// telegram.ts — отправка и редактирование сообщений через Telegram Bot API.
// Только глобальный fetch + инжектируемые fetchImpl/sleepImpl.
// В сообщениях и stack ошибок не должно попадать ни токена, ни URL с токеном.
import { redact, type SecretSet } from "./logger.ts";

export type FetchLikeResponse = {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
};

export type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal: AbortSignal;
  },
) => Promise<FetchLikeResponse>;

export type SleepImpl = (ms: number) => Promise<void>;

export type TelegramErrorKind = "network" | "timeout" | "api";

export class TelegramError extends Error {
  httpStatus?: number;
  telegramCode?: number;
  retryable: boolean;
  kind: TelegramErrorKind;
  waitMs?: number;

  constructor(
    message: string,
    options: {
      httpStatus?: number;
      telegramCode?: number;
      retryable: boolean;
      kind: TelegramErrorKind;
      waitMs?: number;
    },
  ) {
    super(message);
    this.name = "TelegramError";
    this.httpStatus = options.httpStatus;
    this.telegramCode = options.telegramCode;
    this.retryable = options.retryable;
    this.kind = options.kind;
    this.waitMs = options.waitMs;
  }
}

export type SendTelegramMessageOptions = {
  token: string;
  chatId: string;
  text: string;
  timeoutMs?: number;
  retries?: number;
  /** JSON-объект reply_markup (inline-кнопки); попадает в тело sendMessage как есть. */
  replyMarkup?: unknown;
  fetchImpl?: FetchLike;
  sleepImpl?: SleepImpl;
};

/** Инжектируемая функция отправки (в тестах — фейковая, без реальной сети). */
export type SendImpl = (options: SendTelegramMessageOptions) => Promise<{ messageId: number }>;

export type EditTelegramMessageOptions = {
  token: string;
  chatId: string;
  messageId: number;
  text: string;
  timeoutMs?: number;
  retries?: number;
  fetchImpl?: FetchLike;
  sleepImpl?: SleepImpl;
};

const BOT_URL_RE = /api\.telegram\.org\/bot[^/\s"'\\]+/gi;

/** Лимит текста сообщения Telegram — 4096 символов (спринт 5, п.3.4е). */
export const MAX_MESSAGE_CHARS = 4096;

/**
 * Обрезка до 4096 символов с `…` в конце; удаляет «висящий» незакрытый тег —
 * сообщение уходит с parse_mode=HTML и не должно содержать битую разметку.
 */
export function capBotText(text: string): string {
  if (text.length <= MAX_MESSAGE_CHARS) return text;
  return `${text.slice(0, MAX_MESSAGE_CHARS - 1).replace(/<[^<>]*$/, "")}…`;
}

function sanitize(message: string, secrets: SecretSet): string {
  return redact(message, secrets).replace(BOT_URL_RE, "api.telegram.org/bot[REDACTED]");
}

function backoff(attempt: number): number {
  return 250 * 2 ** attempt;
}

/** HTTP 429 → parameters.retry_after (секунды), с потолком 5000 мс. */
function retryAfterMs(payload: unknown): number | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const parameters = (payload as { parameters?: { retry_after?: unknown } }).parameters;
  const seconds = parameters?.retry_after;
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) return undefined;
  return Math.min(seconds * 1000, 5000);
}

/** Повторяются только: сеть/таймаут/429/5xx. 400/401/403 и прочие 4xx — нет. */
function isRetryable(status: number | undefined, code: number | undefined): boolean {
  if (status === 429 || code === 429) return true;
  if (typeof code === "number" && code >= 500) return true;
  if (typeof status === "number" && status >= 500) return true;
  return false;
}

const defaultFetch: FetchLike = (url, init) =>
  globalThis.fetch(url, init) as unknown as Promise<FetchLikeResponse>;

const defaultSleep: SleepImpl = (ms) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * POST https://api.telegram.org/bot<token>/sendMessage
 * Успех только при `response.ok === true && body.ok === true`.
 * Повторы: attempts = min(retries + 1, 3); backoff 250 мс * 2^attempt;
 * 429 учитывает retry_after (≤5000 мс).
 */
export async function sendTelegramMessage(
  options: SendTelegramMessageOptions,
): Promise<{ messageId: number }> {
  const secrets: SecretSet = { token: options.token, chatId: options.chatId };
  const url = `https://api.telegram.org/bot${options.token}/sendMessage`;
  const timeoutMs = options.timeoutMs ?? 5000;
  const retries = Math.min(Math.max(Math.round(options.retries ?? 2), 0), 5);
  const attempts = Math.min(retries + 1, 3);
  const fetchImpl = options.fetchImpl ?? defaultFetch;
  const sleepImpl = options.sleepImpl ?? defaultSleep;
  const payload: Record<string, unknown> = {
    chat_id: options.chatId,
    // Финальный cap ≤4096 перед sendTelegramMessage (п.3.4е).
    text: capBotText(options.text),
    parse_mode: "HTML",
    disable_web_page_preview: true,
  };
  // reply_markup — это JSON, а не HTML: передаётся без экранирования;
  // при отсутствии поля в теле его нет (существующие вызовы не меняются).
  if (options.replyMarkup !== undefined && options.replyMarkup !== null) {
    payload.reply_markup = options.replyMarkup;
  }
  const body = JSON.stringify(payload);

  let lastError: TelegramError | undefined;

  for (let attempt = 0; attempt < attempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let waitMs: number | undefined;
    try {
      const response = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        signal: controller.signal,
      });
      let payload: unknown = null;
      try {
        payload = await response.json();
      } catch {
        payload = null;
      }

      const record =
        payload && typeof payload === "object"
          ? (payload as { ok?: unknown; result?: { message_id?: unknown }; error_code?: unknown })
          : null;

      if (
        response.ok === true &&
        record?.ok === true &&
        record.result &&
        typeof record.result.message_id === "number"
      ) {
        return { messageId: record.result.message_id };
      }

      const status = typeof response.status === "number" ? response.status : undefined;
      const code =
        typeof record?.error_code === "number" ? record.error_code : status;
      const retryable = isRetryable(status, code);
      const wait = retryAfterMs(payload);
      lastError = new TelegramError(
        sanitize(`telegram request failed (http ${status ?? "?"}, code ${code ?? "?"})`, secrets),
        { httpStatus: status, telegramCode: code, retryable, kind: "api", waitMs: wait },
      );
      if (!retryable) throw lastError;
      waitMs = wait ?? backoff(attempt);
    } catch (error) {
      if (error instanceof TelegramError) {
        if (!error.retryable) throw error;
        lastError = error;
        waitMs = error.waitMs ?? backoff(attempt);
      } else {
        const isTimeout = controller.signal.aborted;
        const raw = error instanceof Error ? error.message : String(error);
        lastError = new TelegramError(sanitize(`telegram network error: ${raw}`, secrets), {
          retryable: true,
          kind: isTimeout ? "timeout" : "network",
        });
        waitMs = backoff(attempt);
      }
    } finally {
      clearTimeout(timer);
    }

    if (attempt + 1 >= attempts) break;
    await sleepImpl(waitMs ?? backoff(attempt));
  }

  throw (
    lastError ??
    new TelegramError("telegram request failed", { retryable: false, kind: "network" })
  );
}

/**
 * POST https://api.telegram.org/bot<token>/editMessageText
 * Тело: chat_id/message_id/text/parse_mode/disable_web_page_preview БЕЗ
 * reply_markup — editMessageText без reply_markup убирает кнопки из сообщения.
 * Успех при `response.ok && body.ok`; HTTP 400 «message is not modified»
 * (текст уже совпадает) тоже считается успехом — без ретраев и без исключения.
 * Повторы/редактирование ошибок — как у sendTelegramMessage.
 */
export async function editTelegramMessage(options: EditTelegramMessageOptions): Promise<void> {
  const secrets: SecretSet = { token: options.token, chatId: options.chatId };
  const url = `https://api.telegram.org/bot${options.token}/editMessageText`;
  const timeoutMs = options.timeoutMs ?? 5000;
  const retries = Math.min(Math.max(Math.round(options.retries ?? 2), 0), 5);
  const attempts = Math.min(retries + 1, 3);
  const fetchImpl = options.fetchImpl ?? defaultFetch;
  const sleepImpl = options.sleepImpl ?? defaultSleep;
  const body = JSON.stringify({
    chat_id: options.chatId,
    message_id: options.messageId,
    text: capBotText(options.text),
    parse_mode: "HTML",
    disable_web_page_preview: true,
  });

  let lastError: TelegramError | undefined;

  for (let attempt = 0; attempt < attempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let waitMs: number | undefined;
    try {
      const response = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        signal: controller.signal,
      });
      let payload: unknown = null;
      try {
        payload = await response.json();
      } catch {
        payload = null;
      }

      const record =
        payload && typeof payload === "object"
          ? (payload as { ok?: unknown; error_code?: unknown; description?: unknown })
          : null;

      if (response.ok === true && record?.ok === true) return;

      const status = typeof response.status === "number" ? response.status : undefined;
      const description = typeof record?.description === "string" ? record.description : "";
      if (status === 400 && /message is not modified/i.test(description)) return;

      const code = typeof record?.error_code === "number" ? record.error_code : status;
      const retryable = isRetryable(status, code);
      const wait = retryAfterMs(payload);
      lastError = new TelegramError(
        sanitize(`telegram request failed (http ${status ?? "?"}, code ${code ?? "?"})`, secrets),
        { httpStatus: status, telegramCode: code, retryable, kind: "api", waitMs: wait },
      );
      if (!retryable) throw lastError;
      waitMs = wait ?? backoff(attempt);
    } catch (error) {
      if (error instanceof TelegramError) {
        if (!error.retryable) throw error;
        lastError = error;
        waitMs = error.waitMs ?? backoff(attempt);
      } else {
        const isTimeout = controller.signal.aborted;
        const raw = error instanceof Error ? error.message : String(error);
        lastError = new TelegramError(sanitize(`telegram network error: ${raw}`, secrets), {
          retryable: true,
          kind: isTimeout ? "timeout" : "network",
        });
        waitMs = backoff(attempt);
      }
    } finally {
      clearTimeout(timer);
    }

    if (attempt + 1 >= attempts) break;
    await sleepImpl(waitMs ?? backoff(attempt));
  }

  throw (
    lastError ??
    new TelegramError("telegram request failed", { retryable: false, kind: "network" })
  );
}
