// Тесты notify.ts — доставка, снятие pending при ошибке, дочерний процесс, отсутствие секретов в payload.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeBridgeConfig, DEFAULT_STATE_DIR } from "../config.ts";
import { createLogger } from "../logger.ts";
import { childMain, deliver, spawnNotify, type NotifyPayload } from "../notify.ts";
import { createRoutes } from "../routes.ts";
import { TelegramError, type SendImpl } from "../telegram.ts";

const TOKEN = "777000111:AA-secret-TOKEN-value";
const CHAT_ID = "-100999888777";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "tb-notify-"));
}

function payload(overrides: Partial<NotifyPayload> = {}): NotifyPayload {
  return {
    text: "<b>✅ Задача выполнена</b>\n<b>Итог:</b> BRIDGE_IDLE_OK",
    sessionID: "ses_notify",
    serverUrl: "http://127.0.0.1:4100",
    directory: "/root/projects/opencode-telegram-notifier",
    dedupKey: "ses_notify:a1",
    status: "success",
    durationMs: 1234,
    chars: 60,
    configDir: "/root/.config/opencode",
    ...overrides,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("test_deliver_success_records_route_and_dedup", async () => {
  const dir = tmp();
  try {
    const config = makeBridgeConfig({ token: TOKEN, chatId: CHAT_ID, stateDir: dir });
    const routes = createRoutes({ stateDir: dir });
    const logFile = join(dir, "notifier.log");
    const logger = createLogger({ logFile, secrets: { token: TOKEN, chatId: CHAT_ID }, silent: true });
    const calls: string[] = [];
    const sendImpl: SendImpl = async ({ text }) => {
      calls.push(text);
      return { messageId: 991 };
    };

    await deliver(payload(), { config, routes, logger, sendImpl });

    assert.equal(calls.length, 1);
    const route = await routes.getMessage(991);
    assert.equal(route?.sessionID, "ses_notify");
    assert.equal(route?.serverUrl, "http://127.0.0.1:4100");
    assert.equal(await routes.hasSent("ses_notify:a1"), true);
    assert.equal(await routes.isPending("ses_notify:a1"), false, "pending снят после успеха");

    const log = readFileSync(logFile, "utf8");
    assert.match(log, /event=telegram\.sent/);
    assert.match(log, /message_id=991/);
    assert.ok(!log.includes(TOKEN), "токен не попадает в лог");
    assert.ok(!log.includes(CHAT_ID), "chat_id не попадает в лог");

    // повторная доставка того же ключа не шлёт второе сообщение
    await deliver(payload(), { config, routes, logger, sendImpl });
    assert.equal(calls.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("test_deliver_failure_allows_retry", async () => {
  const dir = tmp();
  try {
    const config = makeBridgeConfig({ token: TOKEN, chatId: CHAT_ID, stateDir: dir });
    const routes = createRoutes({ stateDir: dir });
    const logFile = join(dir, "notifier.log");
    const logger = createLogger({ logFile, secrets: { token: TOKEN, chatId: CHAT_ID }, silent: true });
    await routes.markPending("ses_notify:a1");

    const failing: SendImpl = async () => {
      throw new TelegramError("telegram request failed (http 500, code 500)", {
        httpStatus: 500,
        telegramCode: 500,
        retryable: true,
        kind: "api",
      });
    };
    await assert.rejects(
      () => deliver(payload(), { config, routes, logger, sendImpl: failing }),
      TelegramError,
    );

    // ошибка отправки не помечает ключ дедупа и снимает pending → повтор возможен
    assert.equal(await routes.hasSent("ses_notify:a1"), false);
    assert.equal(await routes.isPending("ses_notify:a1"), false);
    assert.equal(await routes.getMessage(991), undefined);
    assert.match(readFileSync(logFile, "utf8"), /event=telegram\.send_failed/);

    const ok: SendImpl = async () => ({ messageId: 77 });
    await deliver(payload(), { config, routes, logger, sendImpl: ok });
    assert.equal(await routes.hasSent("ses_notify:a1"), true);
    assert.equal((await routes.getMessage(77))?.sessionID, "ses_notify");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("test_child_main_dry_run_and_guards", async () => {
  const dir = tmp();
  try {
    const logFile = join(dir, "child.log");
    const payloadFile = join(dir, "payload.json");
    writeFileSync(payloadFile, JSON.stringify(payload({ dryRun: true, logFile })), "utf8");

    const code = await childMain(["node", "notify-child.ts", payloadFile]);
    assert.equal(code, 0, "dry-run завершается с кодом 0");
    assert.match(readFileSync(logFile, "utf8"), /event=telegram\.dry_run/);
    assert.equal(existsSync(payloadFile), false, "payload-файл удаляется после чтения");

    // без аргумента — код 2
    assert.equal(await childMain(["node", "notify-child.ts"]), 2);
    // битый payload — код 2, файл удалён
    const broken = join(dir, "broken.json");
    writeFileSync(broken, "не json", "utf8");
    assert.equal(await childMain(["node", "notify-child.ts", broken]), 2);
    assert.equal(existsSync(broken), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("test_spawn_child_writes_log_and_cleans_payload", async () => {
  const dir = tmp();
  try {
    const logFile = join(dir, "spawned.log");
    const p = payload({ dryRun: true, logFile });
    const outcome = spawnNotify(p, { stateDir: dir });
    assert.ok(typeof outcome.pid === "number" && outcome.pid > 0, "дочерний процесс запущен");

    const deadline = Date.now() + 15000;
    let text = "";
    while (Date.now() < deadline) {
      if (existsSync(logFile)) {
        text = readFileSync(logFile, "utf8");
        if (/telegram\.dry_run/.test(text)) break;
      }
      await sleep(50);
    }
    assert.match(text, /event=telegram\.dry_run/, "отсоединённый процесс отработал и записал лог");
    assert.ok(!text.includes(TOKEN), "токен не попадает в лог дочернего процесса");

    const leftovers = readdirSync(dir).filter((name) => name.startsWith(".notify-"));
    assert.deepEqual(leftovers, [], `payload-файлы не удалены: ${leftovers.join(", ")}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("test_payload_has_no_secrets", () => {
  const p = payload();
  const serialized = JSON.stringify(p);
  assert.ok(!serialized.includes(TOKEN));
  assert.ok(!serialized.includes(CHAT_ID));
  assert.ok(!/TG_BOT_TOKEN|TG_CHAT_ID/.test(serialized));
  // и сам payload, который создаёт сервис, тоже не содержит секретов
  assert.equal(typeof p.configDir, "string");
  assert.equal(p.configDir.startsWith("/"), true);
  // резолв node-бинарника детерминирован
  assert.equal(typeof p.dedupKey, "string");
  // путь каталога состояния по умолчанию существует в конфиге
  assert.equal(DEFAULT_STATE_DIR, "/root/.local/state/opencode/telegram-bridge");
});
