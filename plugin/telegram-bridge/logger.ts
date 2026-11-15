// logger.ts — строки `event=...` в notifier.log (600) + console.error для warnings.
// Запрещено логировать текст задачи/итога целиком и тело ответа Telegram.
import { appendFileSync, chmodSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";

/** Порог ротации лог-файла при старте процесса (спринт 5, п.3.4б). */
export const LOG_ROTATE_BYTES = 5 * 1024 * 1024;

/**
 * Ротация логов при СТАРТЕ процесса: файл > 5 МБ → `<имя>.1`, прежние
 * `.1` → `.2`, существующий `.2` удаляется (максимум 3 файла), права 600
 * сохраняются. Контракт идентичен bridge/logger.ts (общий протокол спринта 5).
 * Ошибки не фатальны: лог не должен ронять процесс.
 */
export function rotateLogSync(logFile: string, options: { maxBytes?: number } = {}): void {
  const maxBytes = options.maxBytes ?? LOG_ROTATE_BYTES;
  try {
    const info = statSync(logFile);
    if (!info.isFile() || info.size <= maxBytes) return;
  } catch {
    return; // файла нет — ротировать нечего
  }
  try {
    const two = `${logFile}.2`;
    if (existsSync(two)) unlinkSync(two);
    const one = `${logFile}.1`;
    if (existsSync(one)) renameSync(one, two);
    renameSync(logFile, one);
    appendFileSync(logFile, "", { mode: 0o600 });
    chmodSync(logFile, 0o600);
    try {
      chmodSync(one, 0o600);
    } catch {
      /* права уже 600 — не фатально */
    }
  } catch {
    /* ротация не должна ронять процесс */
  }
}

export type SecretSet = { token?: string; chatId?: string };

export type LogFields = Record<string, string | number | boolean | undefined | null>;

export type Logger = {
  readonly logFile: string;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, error?: unknown, fields?: LogFields): void;
};

const BOT_URL_RE = /api\.telegram\.org\/bot[^/\s"'\\]+/gi;

/**
 * Ключи числовой телеметрии: значения подлежат замене только токена,
 * но не TG_CHAT_ID — иначе message_id/duration могли бы совпасть с chat_id
 * и превратиться в [REDACTED]. Сам chat_id в эти поля не попадает по построению.
 */
const NUMERIC_SAFE_KEYS = new Set([
  "message_id",
  "duration_ms",
  "count",
  "attempt",
  "http_status",
  "chars",
]);

function replaceLiteral(text: string, needle: string | undefined): string {
  if (!needle) return text;
  // Числовой секрет (TG_CHAT_ID) заменяем только на границах цифр,
  // чтобы не портить обычные числа в логах (http-статусы, id, длительности).
  if (/^-?\d+$/.test(needle)) {
    const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return text.replace(new RegExp(`(?<!\\d)${escaped}(?!\\d)`, "g"), "[REDACTED]");
  }
  return text.split(needle).join("[REDACTED]");
}

/**
 * redact(value) — замена TG_BOT_TOKEN, TG_CHAT_ID и URL вида
 * `api.telegram.org/bot<token>` на `[REDACTED]`.
 */
export function redact(value: unknown, secrets?: SecretSet): string {
  let text: string;
  if (typeof value === "string") {
    text = value;
  } else if (value instanceof Error) {
    text = `${value.name}: ${value.message}`;
  } else {
    try {
      text = JSON.stringify(value) ?? String(value);
    } catch {
      text = String(value);
    }
  }
  text = replaceLiteral(text, secrets?.token);
  text = replaceLiteral(text, secrets?.chatId);
  text = text.replace(BOT_URL_RE, "api.telegram.org/bot[REDACTED]");
  return text;
}

function sanitizeValue(value: unknown): string {
  let text: string;
  if (value === undefined || value === null) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    text = String(value);
  } else {
    try {
      text = JSON.stringify(value) ?? String(value);
    } catch {
      text = String(value);
    }
  }
  return text.replace(/[\r\n]+/g, " ").trim();
}

export type CreateLoggerOptions = {
  logFile: string;
  secrets?: SecretSet;
  /** Куда писать warnings/errors помимо файла (по умолчанию console.error). */
  stderr?: (line: string) => void;
  /** Отключить запись в stderr (в тестах). */
  silent?: boolean;
};

export function createLogger(options: CreateLoggerOptions): Logger {
  const logFile = options.logFile;
  const secrets = options.secrets ?? {};
  const stderr = options.stderr ?? ((line: string) => console.error(line));
  let ensured = false;
  // Ротация при старте процесса (до первой записи): >5 МБ → .1/.2.
  rotateLogSync(logFile);

  const ensure = (): boolean => {
    if (ensured) return true;
    try {
      mkdirSync(dirname(logFile), { recursive: true, mode: 0o700 });
      try {
        chmodSync(dirname(logFile), 0o700);
      } catch {
        /* каталог уже существует или нет прав — не фатально */
      }
      if (!existsSync(logFile)) {
        appendFileSync(logFile, "", { mode: 0o600 });
      }
      chmodSync(logFile, 0o600);
      ensured = true;
      return true;
    } catch {
      return false;
    }
  };

  const write = (line: string): void => {
    if (!ensure()) return;
    try {
      appendFileSync(logFile, line + "\n", { mode: 0o600 });
    } catch {
      /* лог не должен ронять процесс */
    }
  };

  const build = (event: string, fields?: LogFields): string => {
    const parts: string[] = [`event=${sanitizeValue(event)}`];
    if (fields) {
      for (const key of Object.keys(fields)) {
        const value = fields[key];
        if (value === undefined || value === null || value === "") continue;
        const clean = sanitizeValue(value);
        if (clean === "") continue;
        const active = NUMERIC_SAFE_KEYS.has(key) ? { token: secrets.token } : secrets;
        parts.push(`${sanitizeValue(key)}=${redact(clean, active)}`);
      }
    }
    return `${new Date().toISOString()} ${parts.join(" ")}`;
  };

  return {
    logFile,
    info(event, fields) {
      write(build(event, fields));
    },
    warn(event, fields) {
      const line = build(event, fields);
      write(line);
      if (!options.silent) stderr(redact(line, secrets));
    },
    error(event, error, fields) {
      const message = error === undefined ? "" : redact(error, secrets);
      const line = fields ? build(event, fields) : build(event);
      write(message ? `${line} error=${message}` : line);
      if (!options.silent) stderr(redact(message ? `${line} error=${message}` : line, secrets));
    },
  };
}
