// notify.ts — доставка уведомления и передача её отсоединённому дочернему процессу.
//
// ВАЖНО: `opencode run` прерывает продолжение event-хука примерно через 200–300 мс после
// `session.idle` и затем завершает процесс, тогда как одна только отправка в Telegram
// занимает 300–400 мс. Поэтому в production-режиме хук только готовит payload
// (сессия, сообщения, текст) и поручает отправку дочернему процессу
// (`node --experimental-strip-types notify-child.ts <payload.json>`), который переживает
// выход родителя и завершает отправку/запись маршрута/лог.
//
// Payload не содержит секретов: токен и chat_id дочерний процесс читает сам из .env.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_STATE_DIR,
  loadBridgeConfig,
  type BridgeConfig,
} from "./config.ts";
import { createLogger, type Logger } from "./logger.ts";
import { createRoutes, type RoutesStore } from "./routes.ts";
import { sendTelegramMessage, TelegramError, type SendImpl } from "./telegram.ts";

/** HTML-текст уведомления и маршрутная информация. Секретов не содержит. */
export type NotifyPayload = {
  text: string;
  sessionID: string;
  serverUrl: string;
  directory: string;
  dedupKey: string;
  status: string;
  durationMs: number;
  chars: number;
  configDir: string;
  /** переопределение файла лога (используется тестами) */
  logFile?: string;
  /** тестовый режим: без отправки и без чтения .env */
  dryRun?: boolean;
};

export type NotifyOutcome = { pid?: number };
export type NotifyFn = (payload: NotifyPayload) => Promise<NotifyOutcome | void>;

export type DeliverDeps = {
  config: BridgeConfig;
  routes: RoutesStore;
  logger: Logger;
  sendImpl?: SendImpl;
  now?: () => number;
};

/**
 * Собственно доставка: проверка дедупа → отправка → маршрут → отметка ключа.
 * Ошибка отправки СНИМАЕТ pending и НЕ помечает ключ дедупа — следующий idle повторит.
 */
export async function deliver(payload: NotifyPayload, deps: DeliverDeps): Promise<void> {
  const { config, routes, logger } = deps;
  const send = deps.sendImpl ?? sendTelegramMessage;
  const now = deps.now ?? (() => Date.now());

  if (await routes.hasSent(payload.dedupKey)) {
    await routes.clearPending(payload.dedupKey);
    logger.info("idle.skipped", { session: payload.sessionID, reason: "duplicate" });
    return;
  }

  try {
    const { messageId } = await send({
      token: config.token,
      chatId: config.chatId,
      text: payload.text,
      timeoutMs: config.timeoutMs,
      retries: config.retries,
    });
    await routes.recordMessage(messageId, {
      sessionID: payload.sessionID,
      serverUrl: payload.serverUrl,
      directory: payload.directory,
      sentAt: now(),
    });
    await routes.markSent(payload.dedupKey);
    await routes.clearPending(payload.dedupKey);
    logger.info("telegram.sent", {
      session: payload.sessionID,
      message_id: messageId,
      status: payload.status,
      duration_ms: payload.durationMs,
      chars: payload.chars,
    });
  } catch (error) {
    await routes.clearPending(payload.dedupKey);
    logger.error("telegram.send_failed", error, { session: payload.sessionID });
    throw error;
  }
}

/** Node-бинарник для дочернего процесса (плагин выполняется opencode/bun, а не node). */
export function resolveNodeBin(): string {
  const fromEnv = process.env.TELEGRAM_BRIDGE_NODE;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  for (const candidate of ["/usr/bin/node", "/usr/local/bin/node"]) {
    if (existsSync(candidate)) return candidate;
  }
  return "node";
}

export type SpawnNotifyOptions = {
  /** каталог для payload-файла (обычно stateDir) */
  stateDir?: string;
  nodeBin?: string;
  childPath?: string;
};

/**
 * Запуск отсоединённого дочернего процесса с payload-файлом.
 * `detached` + `unref` → процесс переживает выход opencode.
 */
export function spawnNotify(
  payload: NotifyPayload,
  options: SpawnNotifyOptions = {},
): NotifyOutcome {
  const stateDir = options.stateDir ?? DEFAULT_STATE_DIR;
  const childPath =
    options.childPath ?? fileURLToPath(new URL("./notify-child.ts", import.meta.url));
  const nodeBin = options.nodeBin ?? resolveNodeBin();
  const file = join(stateDir, `.notify-${process.pid}-${randomBytes(6).toString("hex")}.json`);
  writeFileSync(file, JSON.stringify(payload), { encoding: "utf8", mode: 0o600 });
  try {
    const child = spawn(nodeBin, ["--experimental-strip-types", childPath, file], {
      stdio: ["ignore", "ignore", "ignore"],
      detached: true,
      env: { ...process.env },
    });
    child.on("error", () => {
      try {
        unlinkSync(file);
      } catch {
        /* уже удалён */
      }
    });
    child.unref();
    return { pid: child.pid };
  } catch (error) {
    try {
      unlinkSync(file);
    } catch {
      /* не создан */
    }
    throw error;
  }
}

/** Точка входа дочернего процесса. Возвращает код выхода (не бросает исключений). */
export async function childMain(argv: string[] = process.argv): Promise<number> {
  const filePath = argv[2];
  if (!filePath) return 2;
  let payload: NotifyPayload | undefined;
  let logger: Logger | undefined;
  try {
    let raw: string;
    try {
      raw = readFileSync(filePath, "utf8");
    } catch {
      return 2;
    }
    try {
      unlinkSync(filePath);
    } catch {
      /* уже удалён */
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return 2;
    }
    payload = parsed as NotifyPayload;
    if (
      !payload ||
      typeof payload.text !== "string" ||
      typeof payload.dedupKey !== "string" ||
      typeof payload.sessionID !== "string"
    ) {
      return 2;
    }
    logger = createLogger({
      logFile: payload.logFile ?? join(DEFAULT_STATE_DIR, "notifier.log"),
      silent: true,
    });
    if (payload.dryRun) {
      logger.info("telegram.dry_run", { session: payload.sessionID, chars: payload.chars });
      return 0;
    }
    const config = loadBridgeConfig({ configDir: payload.configDir });
    logger = createLogger({
      logFile: payload.logFile ?? config.logFile,
      secrets: { token: config.token, chatId: config.chatId },
      silent: true,
    });
    const routes = createRoutes({ stateDir: config.stateDir, file: config.routesFile });
    await deliver(payload, { config, routes, logger });
    return 0;
  } catch (error) {
    // TelegramError уже залогирован внутри deliver как telegram.send_failed
    if (!(error instanceof TelegramError)) {
      try {
        logger?.error("notify.child_failed", error, { session: payload?.sessionID });
      } catch {
        /* логирование не должно ломать выход */
      }
    }
    return 1;
  }
}
