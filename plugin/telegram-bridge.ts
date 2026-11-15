// telegram-bridge.ts — точка входа глобального плагина opencode (API v2).
//
// Формат v2: `export default { id, setup(context) }`. В setup подписываемся на
// события сервера (async iterable) и переводим их в события, понятные
// существующей логике service.ts (session.idle / permission.asked /
// session.created / form.created→question.asked / form.replied / form.cancelled).
//
// Что изменилось относительно v1:
//   input.directory  → context.location.directory
//   input.serverUrl  → собственный порт процесса (ss -ltnp) иначе registry.json
//   input.client     → прямой вызов context.session.get + HTTP /api/... с Basic-auth
//   хук `event`      → context.event.subscribe() (async iterable, без фильтра типов)
//
// При импорте файла не выполняются сетевые вызовы и не читаются секреты:
// конфигурация и .env загружаются только внутри setup.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtractedMessage, ExtractedSession } from "./telegram-bridge/extract.ts";
import {
  DEFAULT_STATE_DIR,
  loadBridgeConfig,
  type BridgeConfig,
} from "./telegram-bridge/config.ts";
import { createLogger, type Logger } from "./telegram-bridge/logger.ts";
import { createRoutes, startupCleanup, type QuestionItem } from "./telegram-bridge/routes.ts";
import { createBridge, createEventHooks, type SessionClient } from "./telegram-bridge/service.ts";

/** Каталог конфигурации opencode (~/.config/opencode). */
const CONFIG_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

/** Реестр сессий утилиты `oc` (спринт 1) — источник fallback-порта. */
const REGISTRY_FILE = "/root/.local/state/opencode/oc/registry.json";

/** Файлы с паролем Basic-auth opencode v2 (читаются только внутри setup). */
const SERVE_ENV_FILE = process.env.OC_SERVE_ENV ?? "/root/.local/state/opencode/oc/serve.env";
const SERVICE_STATE_FILE = "/root/.local/state/opencode/service.json";
const SERVICE_CONFIG_FILE = "/root/.config/opencode/service.json";

/**
 * Периодическая догрузка pending-форм. Закрывает «тихий» отказ SSE: поток жив,
 * но события не приходят (half-open соединение), поэтому переподписка не
 * срабатывает. 30с — компромисс между задержкой вопроса и локальным HTTP.
 */
const HYDRATE_INTERVAL_MS = 30_000;

type PlainRecord = Record<string, unknown>;

function isPlainRecord(value: unknown): value is PlainRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** serverUrl → origin `http://127.0.0.1:port` (без path/query/токенов, localhost → 127.0.0.1). */
export function normalizeServerUrl(value: unknown): string {
  try {
    const url = value instanceof URL ? value : new URL(String(value));
    const hostname = url.hostname === "localhost" ? "127.0.0.1" : url.hostname;
    const port = url.port ? `:${url.port}` : "";
    return `${url.protocol}//${hostname}${port}`;
  } catch {
    return "";
  }
}

/** Порт, на котором слушает собственный процесс opencode (ss -ltnp + pid). */
function ownListenPort(): number | undefined {
  try {
    const out = execFileSync("ss", ["-ltnp"], { encoding: "utf8", timeout: 2000 });
    const pattern = /LISTEN\s+\S+\s+\S+\s+127\.0\.0\.1:(\d+)\s+.*?\bpid=(\d+)/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(out)) !== null) {
      if (Number(match[2]) === process.pid) return Number(match[1]);
    }
  } catch {
    /* ss недоступен — переход к реестру */
  }
  return undefined;
}

/** Каталоги живых oc-сессий из registry.json (для догрузки форм всех локаций). */
export function registryDirectories(): string[] {
  try {
    if (!existsSync(REGISTRY_FILE)) return [];
    const parsed: unknown = JSON.parse(readFileSync(REGISTRY_FILE, "utf8"));
    const sessions = (parsed as { sessions?: Record<string, { directory?: unknown }> }).sessions;
    const out: string[] = [];
    for (const entry of Object.values(sessions ?? {})) {
      const dir = entry?.directory;
      if (typeof dir !== "string" || !dir.startsWith("/")) continue;
      if (!existsSync(dir) || out.includes(dir)) continue;
      out.push(dir);
    }
    return out;
  } catch {
    /* битый реестр — не фатально */
    return [];
  }
}

/** Порты из registry.json утилиты `oc` (первый валидный). */
function registryPort(): number | undefined {
  try {
    if (!existsSync(REGISTRY_FILE)) return undefined;
    const parsed: unknown = JSON.parse(readFileSync(REGISTRY_FILE, "utf8"));
    const sessions = (parsed as { sessions?: Record<string, { port?: unknown }> }).sessions;
    for (const entry of Object.values(sessions ?? {})) {
      const port = Number(entry?.port);
      if (Number.isInteger(port) && port > 0 && port < 65536) return port;
    }
  } catch {
    /* битый реестр — не фатально */
  }
  return undefined;
}

/**
 * serverUrl процесса: свой порт (процесс является сервером), иначе порт из
 * реестра `oc` (процесс — клиент, подключённый к общему serve).
 */
export function fallbackServerUrl(): string {
  const port = ownListenPort() ?? registryPort();
  return port ? `http://127.0.0.1:${port}` : "";
}

function readKeyValues(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    if (!existsSync(file)) return out;
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const idx = line.indexOf("=");
      if (idx <= 0) continue;
      out[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    }
  } catch {
    /* нечитаемый файл — пропускаем */
  }
  return out;
}

function readJsonPassword(file: string): string {
  try {
    if (!existsSync(file)) return "";
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    const password = (parsed as { password?: unknown })?.password;
    return typeof password === "string" ? password : "";
  } catch {
    return "";
  }
}

let cachedPassword: string | undefined;

/**
 * Пароль Basic-auth для собственного HTTP-клиента плагина.
 * Порядок: env (oc-serve экспортирует его) → serve.env → service.json.
 * Ошибки чтения не бросаются: "" → запрос уйдёт без заголовка (сервер ответит 401
 * и событие уйдёт в idle.failed вместо тихой потери).
 */
export function resolvePassword(): string {
  if (cachedPassword !== undefined) return cachedPassword;
  const candidates = [
    typeof process.env.OPENCODE_PASSWORD === "string" ? process.env.OPENCODE_PASSWORD : "",
    readKeyValues(SERVE_ENV_FILE).OPENCODE_PASSWORD ?? "",
    readJsonPassword(SERVICE_STATE_FILE),
    readJsonPassword(SERVICE_CONFIG_FILE),
  ];
  cachedPassword = candidates.find((value) => value.length > 0) ?? "";
  return cachedPassword;
}

/** Сброс кеша пароля (тесты). */
export function resetPasswordCache(): void {
  cachedPassword = undefined;
}

function authHeaders(): Record<string, string> {
  const password = resolvePassword();
  if (!password) return {};
  return { authorization: `Basic ${Buffer.from(`opencode:${password}`, "utf8").toString("base64")}` };
}

// --- маппинг v2 → внутренние типы extract.ts --------------------------------

/** Session.Info (v2) → ExtractedSession: directory живёт в location.directory. */
export function toExtractedSession(raw: unknown): ExtractedSession {
  const s = isPlainRecord(raw) ? raw : {};
  const location = isPlainRecord(s.location) ? s.location : {};
  const time = isPlainRecord(s.time) ? s.time : {};
  const out: ExtractedSession = {};
  if (typeof s.id === "string") out.id = s.id;
  if (typeof s.parentID === "string") out.parentID = s.parentID;
  if (typeof location.directory === "string") out.directory = location.directory;
  const created = Number(time.created);
  if (Number.isFinite(created)) out.time = { created };
  return out;
}

/**
 * Сообщения v2 → ExtractedMessage:
 *   role:  info.role ← type ("assistant"|"user"|…)
 *   parts: у assistant — content (text/reasoning/tool; text берётся joinTextParts),
 *          у user — поле text (в v2 у user-сообщения нет content)
 *   error: info.error ← error либо finish="error"; при outcome failed/interrupted
 *          ошибка доставляется последнему assistant-сообщению (v1 полагался на
 *          info.error, которого в v2 у сообщения может не быть).
 */
export function toExtractedMessages(list: unknown[], outcome: unknown): ExtractedMessage[] {
  const out: ExtractedMessage[] = [];
  for (const raw of list) {
    if (!isPlainRecord(raw) || typeof raw.id !== "string") continue;
    const type = typeof raw.type === "string" ? raw.type : "";
    const time = isPlainRecord(raw.time) ? raw.time : undefined;
    const model = isPlainRecord(raw.model) ? raw.model : undefined;
    const content = Array.isArray(raw.content) ? raw.content : undefined;

    let parts: ExtractedMessage["parts"];
    if (type === "assistant") {
      parts = (content ?? []) as ExtractedMessage["parts"];
    } else if (type === "user") {
      parts = typeof raw.text === "string" ? [{ type: "text", text: raw.text }] : [];
    } else {
      parts = [];
    }

    const info: ExtractedMessage["info"] = { id: raw.id, role: type };
    if (time) info.time = time as { created?: number; completed?: number };
    if (model && typeof model.providerID === "string") info.providerID = model.providerID;
    if (model && typeof model.id === "string") info.modelID = model.id;
    if (isPlainRecord(raw.error)) {
      info.error = raw.error as { name?: string; data?: { message?: string } };
    } else if (raw.finish === "error") {
      info.error = { name: "AssistantError", data: { message: "finish=error" } };
    }
    out.push({ info, parts });
  }

  // outcome сессии → ошибка последнего assistant (иначе failed/interrupted
  // выглядит как успех: v2 не кладёт info.error, пока сообщение не упало само).
  if (outcome === "failed" || outcome === "interrupted") {
    let lastAssistant = -1;
    let latestTime = -Infinity;
    out.forEach((message, index) => {
      if (message.info.role !== "assistant") return;
      const completed = message.info.time?.completed ?? message.info.time?.created ?? 0;
      if (completed >= latestTime) {
        latestTime = completed;
        lastAssistant = index;
      }
    });
    const target = lastAssistant >= 0 ? out[lastAssistant] : undefined;
    if (target && !target.info.error) {
      target.info.error =
        outcome === "interrupted"
          ? { name: "MessageAbortedError", data: { message: "interrupted" } }
          : { name: "AssistantError", data: { message: "session failed" } };
    }
  }
  return out;
}

/**
 * Form.Field[] (v2) → QuestionItem[] (внутренний формат кнопок Telegram).
 *
 * В v2 вопрос инструмента `question` раскладывается на два поля формы:
 *   title       — короткий header (например, «DFG»);
 *   description — собственно текст вопроса.
 * Поэтому в `question` берём description (fallback: title/key), а в `header` —
 * title. Если description нет (произвольные поля других форм), header пустой,
 * чтобы не печатать один и тот же текст дважды.
 *
 * `fieldIndex` — индекс поля в ИСХОДНОМ массиве `form.fields`: пропуск полей
 * без title/key не сдвигает соответствие questions ↔ fields (бридж собирает тело
 * ответа по нему, а не по позиции в questions).
 */
export function fieldsToQuestions(fields: unknown): QuestionItem[] {
  if (!Array.isArray(fields)) return [];
  const out: QuestionItem[] = [];
  for (let index = 0; index < fields.length; index++) {
    const field = fields[index];
    if (!isPlainRecord(field)) continue;
    const title =
      typeof field.title === "string" && field.title.trim()
        ? field.title.trim()
        : typeof field.key === "string"
          ? field.key.trim()
          : "";
    if (!title) continue;
    const description =
      typeof field.description === "string" ? field.description.trim() : "";
    const rawOptions = Array.isArray(field.options) ? field.options : [];
    const options = rawOptions
      .filter(isPlainRecord)
      .filter((option) => typeof option.label === "string" && option.label.trim())
      .map((option) => ({
        label: option.label as string,
        description: typeof option.description === "string" ? option.description : "",
      }));
    out.push({
      // description — настоящий текст вопроса; title/key — запасной вариант
      question: description || title,
      header: description ? title : "",
      options,
      multiple: field.type === "multiselect",
      // поля без списка вариантов → текстовый ответ (v1 custom)
      custom: options.length === 0,
      fieldIndex: index,
    });
  }
  return out;
}

/**
 * Form.Info (v2) → внутреннее событие `question.asked`.
 * Используется и для живого `form.created`, и для догрузки pending-форм после
 * подписки/реконнекта (см. hydratePendingQuestions): у Form.Info та же форма
 * `{id, sessionID, fields}`, что и у `form.created.data.form`.
 */
export function formToQuestionEvent(form: unknown, location?: unknown): TranslatedEvent | undefined {
  if (!isPlainRecord(form)) return undefined;
  const formID = typeof form.id === "string" ? form.id : "";
  const sessionID = typeof form.sessionID === "string" ? form.sessionID : "";
  if (!formID || !sessionID) return undefined;
  const questions = fieldsToQuestions(form.fields);
  if (questions.length === 0) return undefined;
  const directory =
    isPlainRecord(location) && typeof location.directory === "string"
      ? location.directory
      : undefined;
  return {
    type: "question.asked",
    properties: {
      id: formID,
      sessionID,
      questions,
      // raw-поля формы нужны бриджу для тела {answer:{key:value}}
      fields: form.fields,
      ...(directory ? { location: { directory } } : {}),
    },
  };
}

// --- HTTP-клиент сообщений ---------------------------------------------------

async function fetchMessagePage(
  serverUrl: string,
  sessionID: string,
  order: "asc" | "desc",
  limit: number,
): Promise<unknown[]> {
  const url = `${serverUrl}/api/session/${encodeURIComponent(sessionID)}/message?order=${order}&limit=${limit}`;
  const response = await fetch(url, {
    headers: { ...authHeaders(), accept: "application/json" },
  });
  if (!response.ok) throw new Error(`opencode: messages http ${response.status}`);
  const payload: unknown = await response.json();
  const data = isPlainRecord(payload) ? payload.data : undefined;
  return Array.isArray(data) ? data : [];
}

/**
 * Pending-формы локации: GET /api/form?location[directory]=…
 * Нужны для догрузки вопросов, созданных пока плагин не был подписан на поток
 * (старт процесса, рестарт serve, разрыв SSE) — живые `form.created` такие
 * события уже не отдадут.
 */
export async function fetchPendingForms(
  serverUrl: string,
  directory: string,
  fetchImpl: typeof fetch = fetch,
): Promise<unknown[]> {
  const base = serverUrl.replace(/\/+$/, "");
  const url = `${base}/api/form?location%5Bdirectory%5D=${encodeURIComponent(directory)}`;
  const response = await fetchImpl(url, {
    headers: { ...authHeaders(), accept: "application/json" },
  });
  if (!response.ok) throw new Error(`opencode: forms http ${response.status}`);
  const payload: unknown = await response.json();
  const data = isPlainRecord(payload) ? payload.data : undefined;
  return Array.isArray(data) ? data : [];
}

/**
 * SessionClient поверх контекста v2: get — прямой вызов (без сети),
 * messages — HTTP (метода в контексте нет), два запроса:
 *   asc  — начало диалога (для task в уведомлении, selectFirstUserText),
 *   desc — хвост диалога (последний assistant → статус, результат, ключ дедупа).
 */
function makeSessionClient(
  context: { session?: { get?: (input: { sessionID: string }) => Promise<unknown> } },
  serverUrl: string,
): SessionClient {
  const getSession = async (sessionID: string): Promise<unknown> => {
    const get = context?.session?.get;
    if (typeof get !== "function") return undefined;
    try {
      return await get.call(context.session, { sessionID });
    } catch {
      return undefined;
    }
  };

  return {
    session: {
      async get({ path }) {
        const data = await getSession(path.id);
        if (!data) return { error: "session.get failed" };
        return { data: toExtractedSession(data) };
      },
      async messages({ path }) {
        try {
          const sessionID = path.id;
          const [oldest, newest, rawSession] = await Promise.all([
            fetchMessagePage(serverUrl, sessionID, "asc", 40),
            fetchMessagePage(serverUrl, sessionID, "desc", 60),
            getSession(sessionID),
          ]);
          const outcome = isPlainRecord(rawSession) ? rawSession.outcome : undefined;
          const seen = new Set<string>();
          const merged: unknown[] = [];
          for (const message of [...oldest, ...newest]) {
            if (!isPlainRecord(message) || typeof message.id !== "string") continue;
            if (seen.has(message.id)) continue;
            seen.add(message.id);
            merged.push(message);
          }
          return { data: toExtractedMessages(merged, outcome) };
        } catch (error) {
          return { error };
        }
      },
    },
  };
}

// --- маппинг событий v2 → события, которые понимает service.ts ---------------

type TranslatedEvent = { type: string; properties: PlainRecord };

export async function toBridgeEvent(
  context: { session?: { get?: (input: { sessionID: string }) => Promise<unknown> } },
  event: unknown,
): Promise<TranslatedEvent | undefined> {
  if (!isPlainRecord(event)) return undefined;
  const type = typeof event.type === "string" ? event.type : "";
  const data = isPlainRecord(event.data) ? event.data : {};

  switch (type) {
    case "session.idle": {
      const sessionID = typeof data.sessionID === "string" ? data.sessionID : "";
      if (!sessionID) return undefined;
      return { type: "session.idle", properties: { sessionID } };
    }

    case "permission.asked": {
      const sessionID = typeof data.sessionID === "string" ? data.sessionID : "";
      const permissionID = typeof data.id === "string" ? data.id : "";
      if (!sessionID || !permissionID) return undefined;
      const properties: PlainRecord = { id: permissionID, sessionID };
      if (typeof data.action === "string") properties.permission = data.action;
      if (Array.isArray(data.resources)) properties.patterns = data.resources;
      if (isPlainRecord(data.metadata)) properties.metadata = data.metadata;
      if (typeof data.message === "string" && data.message) properties.title = data.message;
      return { type: "permission.asked", properties };
    }

    case "session.created": {
      const sessionID = typeof data.sessionID === "string" ? data.sessionID : "";
      if (!sessionID) return undefined;
      const location = isPlainRecord(data.location) ? data.location : {};
      let info: PlainRecord = {
        id: sessionID,
        ...(typeof location.directory === "string" ? { directory: location.directory } : {}),
      };
      // v2 кладёт в событие только sessionID/projectID: parentID (детект child-сессии)
      // и title доступны только через саму сессию.
      try {
        const get = context?.session?.get;
        if (typeof get === "function") {
          const raw = await get.call(context.session, { sessionID });
          if (isPlainRecord(raw)) {
            info = {
              id: typeof raw.id === "string" ? raw.id : sessionID,
              ...(typeof raw.parentID === "string" ? { parentID: raw.parentID } : {}),
              ...(isPlainRecord(raw.location) && typeof raw.location.directory === "string"
                ? { directory: raw.location.directory }
                : {}),
              ...(typeof raw.title === "string" ? { title: raw.title } : {}),
            };
          }
        }
      } catch {
        /* без session.get обходимся тем, что есть в событии */
      }
      return { type: "session.created", properties: { info } };
    }

    // В v2 инструмент question порождает форму: created → вопрос с кнопками.
    // location прокидываем для fallback-directory, если session.get недоступен.
    case "form.created":
      return formToQuestionEvent(data.form, data.location);

    case "form.replied": {
      const formID = typeof data.id === "string" ? data.id : "";
      const sessionID = typeof data.sessionID === "string" ? data.sessionID : "";
      if (!formID || !sessionID) return undefined;
      return {
        type: "question.replied",
        properties: {
          requestID: formID,
          sessionID,
          ...(data.answer !== undefined ? { answer: data.answer } : {}),
        },
      };
    }

    case "form.cancelled": {
      const formID = typeof data.id === "string" ? data.id : "";
      const sessionID = typeof data.sessionID === "string" ? data.sessionID : "";
      if (!formID || !sessionID) return undefined;
      return { type: "question.rejected", properties: { requestID: formID, sessionID } };
    }

    default:
      return undefined;
  }
}

/**
 * Потребление потока событий. Никогда не бросает: ошибка парсинга/обработки
 * одного события не должна ронять подписку и opencode.
 * Возвращает, сколько сырых событий принято (для сброса backoff) и почему
 * поток закрылся — лог stream_closed пишет уже цикл переподписки.
 */
type ConsumeResult = { consumed: number; detail: string };

async function consumeEvents(
  stream: AsyncIterable<unknown>,
  context: Parameters<typeof toBridgeEvent>[0],
  dispatch: (event: TranslatedEvent) => Promise<void>,
  logger: Logger,
): Promise<ConsumeResult> {
  let consumed = 0;
  let detail = "end";
  try {
    for await (const raw of stream) {
      consumed += 1;
      try {
        const translated = await toBridgeEvent(context, raw);
        if (translated) await dispatch(translated);
      } catch (error) {
        logger.error("event.dispatch_failed", error, {
          etype: isPlainRecord(raw) && typeof raw.type === "string" ? raw.type : "unknown",
        });
      }
    }
  } catch (error) {
    // поток закрыт (перезапуск сервера) — это не ошибка плагина
    detail = String((error as Error)?.message ?? error);
  }
  return { consumed, detail };
}

/**
 * Задержка перед переподпиской: 1с → 2с → 4с → … → 60с максимум.
 * `failures` — число подряд закрытий потока без принятых событий (0 → 1с).
 */
export function streamRetryDelayMs(failures: number): number {
  const n = Number.isFinite(failures) && failures > 0 ? Math.floor(failures) : 1;
  return Math.min(1000 * 2 ** (n - 1), 60_000);
}

export type EventLoopOptions = {
  /** Новая подписка на каждую итерацию (после закрытия потока). */
  subscribe: () => AsyncIterable<unknown> | undefined | null;
  context: Parameters<typeof toBridgeEvent>[0];
  dispatch: (event: TranslatedEvent) => Promise<void>;
  logger: Logger;
  sleepImpl?: (ms: number) => Promise<void>;
  /**
   * Вызывается после КАЖДОЙ подписки (первой и переподписках) до чтения потока:
   * догрузка pending-форм закрывает окно, в котором события терялись.
   * Ошибка логируется и не рвёт цикл.
   */
  onSubscribed?: () => Promise<void>;
  /** Тесты/graceful: false → цикл переподписки завершается. */
  shouldContinue?: () => boolean;
};

export type EventLoopResult = {
  /** Сколько раз реально подписались (первая + переподписки). */
  subscriptions: number;
  /** Сколько сырых событий принято. */
  events: number;
  /** Задержки перед каждой переподпиской (для проверки backoff). */
  delays: number[];
};

/**
 * Цикл подписки: поток закрылся/упал → лог event.stream_closed → пауза по
 * экспоненциальному backoff (1с…60с) → НОВАЯ подписка. Число попыток не
 * ограничено: после рестарта serve плагин не должен «оглохнуть» молча.
 * Ошибки не пробрасываются — цикл живёт, пока живёт opencode.
 */
export async function runEventLoop(options: EventLoopOptions): Promise<EventLoopResult> {
  const sleep = options.sleepImpl ?? ((ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms)));
  const result: EventLoopResult = { subscriptions: 0, events: 0, delays: [] };
  let failures = 0;

  while (options.shouldContinue?.() ?? true) {
    let stream: AsyncIterable<unknown> | undefined | null;
    try {
      stream = options.subscribe();
    } catch (error) {
      options.logger.error("event.subscribe_failed", error, {});
      failures += 1;
      const delayMs = streamRetryDelayMs(failures);
      result.delays.push(delayMs);
      await sleep(delayMs);
      continue;
    }
    if (!stream || typeof stream[Symbol.asyncIterator] !== "function") {
      // Подписка недоступна (контекст без event) — переподписываться нечем.
      options.logger.warn("event.subscribe_unavailable");
      return result;
    }

    result.subscriptions += 1;
    if (options.onSubscribed) {
      try {
        await options.onSubscribed();
      } catch (error) {
        options.logger.error("event.hydrate_failed", error, {});
      }
    }
    const consumed = await consumeEvents(stream, options.context, options.dispatch, options.logger);
    result.events += consumed.consumed;
    failures = consumed.consumed > 0 ? 0 : failures + 1;
    const delayMs = streamRetryDelayMs(failures);
    result.delays.push(delayMs);
    options.logger.warn("event.stream_closed", {
      consumed: consumed.consumed,
      attempt: failures,
      delay_ms: delayMs,
      detail: consumed.detail,
    });
    await sleep(delayMs);
  }
  return result;
}

export type BridgePluginOptions = {
  configDir?: string;
  envFile?: string;
  stateDir?: string;
  /** Инъекция готовой конфигурации (тесты/внешние инструменты). */
  config?: BridgeConfig;
  /** Инъекция HTTP-клиента для догрузки pending-форм (тесты/внешние инструменты). */
  fetchImpl?: typeof fetch;
  /** Интервал периодической догрузки pending-форм (тесты; по умолчанию 30с). */
  hydrateIntervalMs?: number;
};

/**
 * Точка входа плагина v2. Любая ошибка перехватывается: плагин никогда
 * не роняет opencode.
 */
export async function setupPlugin(
  context: {
    location?: { directory?: string };
    session?: { get?: (input: { sessionID: string }) => Promise<unknown> };
    event?: { subscribe?: () => AsyncIterable<unknown> };
  },
  options?: BridgePluginOptions,
): Promise<void> {
  const directory =
    (typeof context?.location?.directory === "string" ? context.location.directory : "") ||
    process.cwd();

  let logger: Logger = createLogger({
    logFile: `${DEFAULT_STATE_DIR}/notifier.log`,
    silent: true,
  });
  try {
    const opts = options ?? {};
    const config =
      opts.config ??
      loadBridgeConfig({
        configDir: opts.configDir ?? CONFIG_DIR,
        envFile: opts.envFile,
        stateDir: opts.stateDir,
      });
    logger = createLogger({
      logFile: config.logFile,
      secrets: { token: config.token, chatId: config.chatId },
    });

    if (!config.enabled) {
      logger.info("plugin.disabled");
      return;
    }

    // serverUrl: свой порт процесса, иначе порт общего serve из реестра `oc`.
    const serverUrl = fallbackServerUrl();
    if (!serverUrl) {
      logger.warn("server.empty", { directory });
    }

    const routes = createRoutes({ stateDir: config.stateDir, file: config.routesFile });
    // TTL-очистка routes при старте процесса; ошибки не должны ронять загрузку.
    try {
      const pruned = await startupCleanup(routes, config.stateTtlDays);
      if (pruned.messages > 0 || pruned.permissions > 0 || pruned.questions > 0) {
        logger.info("routes.pruned", {
          messages: pruned.messages,
          permissions: pruned.permissions,
          questions: pruned.questions,
        });
      }
    } catch (error) {
      logger.error("routes.prune_failed", error);
    }

    const client = makeSessionClient(context, serverUrl);
    const bridge = createBridge({
      client,
      directory,
      serverUrl,
      config,
      routes,
      logger,
    });
    const hooks = createEventHooks({ bridge, logger });

    logger.info("plugin.loaded", {
      directory,
      server: serverUrl,
      password: resolvePassword() ? "set" : "missing",
    });

    /**
     * Догрузка вопросов, которые уже ждут ответа, но чьё `form.created` плагин
     * не увидел (подписка появилась позже события / разрыв SSE / рестарт serve).
     * Дедуп по requestID внутри handleQuestion не даёт отправить повторно.
     */
    let hydrating = false;
    const hydratePendingQuestions = async (): Promise<void> => {
      if (!serverUrl || !config.notifyOnQuestion || hydrating) return;
      hydrating = true;
      try {
        // Своя локация + каталоги oc-сессий: вопросы не теряются, даже если
        // событие пропустил процесс, привязанный к другому каталогу.
        const directories = [directory];
        for (const dir of registryDirectories()) {
          if (!directories.includes(dir)) directories.push(dir);
        }
        let fresh = 0;
        for (const dir of directories) {
          let forms: unknown[];
          try {
            forms = await fetchPendingForms(serverUrl, dir, opts.fetchImpl);
          } catch (error) {
            logger.error("question.hydrate_failed", error, { directory: dir });
            continue;
          }
          for (const form of forms) {
            const formID = isPlainRecord(form) && typeof form.id === "string" ? form.id : "";
            if (!formID) continue;
            // Уже отправленный вопрос не трогаем: иначе каждый тик писал бы
            // question.skipped reason=duplicate.
            if (await routes.getQuestionByRequestID(formID)) continue;
            const translated = formToQuestionEvent(form, { directory: dir });
            if (!translated) continue;
            fresh += 1;
            await hooks.event({ event: translated });
          }
        }
        if (fresh > 0) logger.info("question.hydrated", { count: fresh });
      } finally {
        hydrating = false;
      }
    };

    const subscribe = context?.event?.subscribe;
    if (typeof subscribe !== "function") {
      logger.warn("event.subscribe_unavailable");
      return;
    }
    // Без фильтра типов: фильтр по types в v2 молча отбрасывает события,
    // а дубли между локациями гасит файловый дедуп routes.json (как в v1).
    // Цикл сам переподписывается после закрытия потока (рестарт serve) —
    // иначе плагин молча «оглохнет» и уведомления перестанут приходить.
    void runEventLoop({
      subscribe: () => {
        const stream = subscribe.call(context.event);
        return stream && typeof stream[Symbol.asyncIterator] === "function"
          ? (stream as AsyncIterable<unknown>)
          : undefined;
      },
      context,
      dispatch: (translated) => hooks.event({ event: translated }),
      onSubscribed: hydratePendingQuestions,
      logger,
    });

    // Страховка от «тихого» зависания SSE: даже без закрытия потока pending-
    // вопросы будут догружены. unref не держит процесс opencode при выходе.
    const hydrateTimer = setInterval(() => {
      void hydratePendingQuestions().catch((error) =>
        logger.error("event.hydrate_failed", error, {}),
      );
    }, opts.hydrateIntervalMs ?? HYDRATE_INTERVAL_MS);
    hydrateTimer.unref?.();
  } catch (error) {
    logger.error("plugin.init.failed", error, { directory });
  }
}

export default {
  id: "telegram-bridge",
  async setup(context: Parameters<typeof setupPlugin>[0]): Promise<void> {
    await setupPlugin(context);
  },
};
