// config.ts — конфигурация и секреты плагина telegram-bridge.
// Модуль не выполняет сетевых вызовов и не пишет в логи при импорте.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const DEFAULT_ENV_FILE = "/root/projects/opencode-telegram-notifier/.env";
export const DEFAULT_STATE_DIR = "/root/.local/state/opencode/telegram-bridge";
export const DEFAULT_CONFIG_DIR = "/root/.config/opencode";

/** Ошибка конфигурации. Текст содержит только имена переменных, никогда — значения секретов. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/** Значения по умолчанию (совпадают с telegram-bridge.json). */
export const BRIDGE_DEFAULTS = {
  enabled: true,
  notifyOnError: true,
  notifyOnAbort: true,
  notifyOnQuestion: true,
  notifyOnSessionCreate: true,
  includeModel: true,
  includeProject: true,
  includeDuration: true,
  maxTaskChars: 120,
  maxResultChars: 800,
  minResultChars: 40,
  timeoutMs: 5000,
  retries: 2,
  stateTtlDays: 7,
} as const;

export type BridgeConfig = {
  enabled: boolean;
  notifyOnError: boolean;
  notifyOnAbort: boolean;
  notifyOnQuestion: boolean;
  notifyOnSessionCreate: boolean;
  includeModel: boolean;
  includeProject: boolean;
  includeDuration: boolean;
  maxTaskChars: number;
  maxResultChars: number;
  minResultChars: number;
  timeoutMs: number;
  retries: number;
  stateTtlDays: number;
  token: string;
  chatId: string;
  configDir: string;
  configFile: string;
  envFile: string;
  stateDir: string;
  logFile: string;
  routesFile: string;
};

/**
 * Чтение .env-файла: пустые строки и комментарии (`#`) пропускаются,
 * поддерживается префикс `export `, split по первому `=`, снятие кавычек.
 * Значения возвращаются «как есть» (без наложения process.env).
 */
export function loadEnvFile(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!path) return out;
  let raw: string;
  try {
    if (!existsSync(path)) return out;
    raw = readFileSync(path, "utf8");
  } catch {
    return out;
  }
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const body = trimmed.startsWith("export ") ? trimmed.slice("export ".length).trim() : trimmed;
    const eq = body.indexOf("=");
    if (eq <= 0) continue;
    const key = body.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = body.slice(eq + 1).trim();
    if (value.length >= 2) {
      const first = value[0];
      const last = value[value.length - 1];
      if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
        value = value.slice(1, -1).trim();
      }
    }
    out[key] = value;
  }
  return out;
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const num =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Number(value)
        : NaN;
  if (!Number.isFinite(num)) return fallback;
  return Math.min(Math.max(Math.round(num), min), max);
}

function asBool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

export type LoadBridgeConfigOptions = {
  configDir: string;
  env?: Record<string, string | undefined>;
  /** Путь к .env; по умолчанию — .env проекта opencode-telegram-notifier. */
  envFile?: string;
  /** Путь к telegram-bridge.json; по умолчанию — <configDir>/telegram-bridge.json. */
  configFile?: string;
  stateDir?: string;
};

/**
 * Сборка конфигурации: секреты (приоритет `process.env`/`env` над .env),
 * валидация TG_CHAT_ID, обязательность TG_BOT_TOKEN, clamp числовых лимитов.
 */
export function loadBridgeConfig(options: LoadBridgeConfigOptions): BridgeConfig {
  const configDir = options.configDir || DEFAULT_CONFIG_DIR;
  const envFile = options.envFile ?? DEFAULT_ENV_FILE;
  const configFile = options.configFile ?? join(configDir, "telegram-bridge.json");
  const env = options.env ?? (process.env as Record<string, string | undefined>);
  const stateDir = options.stateDir ?? DEFAULT_STATE_DIR;

  const fileEnv = loadEnvFile(envFile);
  const pick = (key: string): string | undefined => {
    const fromProcess = env[key];
    const fromFile = fileEnv[key];
    const value =
      typeof fromProcess === "string" && fromProcess.trim() !== ""
        ? fromProcess
        : typeof fromFile === "string" && fromFile.trim() !== ""
          ? fromFile
          : undefined;
    return value === undefined ? undefined : value.trim();
  };

  const token = pick("TG_BOT_TOKEN");
  if (!token) {
    throw new ConfigError(`missing required secret TG_BOT_TOKEN (set it in ${envFile})`);
  }
  const chatId = pick("TG_CHAT_ID");
  if (!chatId) {
    throw new ConfigError(`missing required secret TG_CHAT_ID (set it in ${envFile})`);
  }
  if (!/^-?[0-9]+$/.test(chatId)) {
    throw new ConfigError("invalid TG_CHAT_ID: value must match the pattern ^-?[0-9]+$");
  }

  let raw: Record<string, unknown> = {};
  try {
    if (existsSync(configFile)) {
      const parsed: unknown = JSON.parse(readFileSync(configFile, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        raw = parsed as Record<string, unknown>;
      }
    }
  } catch {
    raw = {};
  }

  const timeoutMs = clampNumber(raw.timeoutMs, BRIDGE_DEFAULTS.timeoutMs, 1000, 30000);
  const retries = clampNumber(raw.retries, BRIDGE_DEFAULTS.retries, 0, 5);
  const maxTaskChars = clampNumber(raw.maxTaskChars, BRIDGE_DEFAULTS.maxTaskChars, 20, 300);
  const maxResultChars = clampNumber(raw.maxResultChars, BRIDGE_DEFAULTS.maxResultChars, 100, 3500);
  const minResultChars = clampNumber(raw.minResultChars, BRIDGE_DEFAULTS.minResultChars, 0, 100000);
  const stateTtlDays = clampNumber(raw.stateTtlDays, BRIDGE_DEFAULTS.stateTtlDays, 1, 30);

  return {
    enabled: asBool(raw.enabled, BRIDGE_DEFAULTS.enabled),
    notifyOnError: asBool(raw.notifyOnError, BRIDGE_DEFAULTS.notifyOnError),
    notifyOnAbort: asBool(raw.notifyOnAbort, BRIDGE_DEFAULTS.notifyOnAbort),
    notifyOnQuestion: asBool(raw.notifyOnQuestion, BRIDGE_DEFAULTS.notifyOnQuestion),
    notifyOnSessionCreate: asBool(raw.notifyOnSessionCreate, BRIDGE_DEFAULTS.notifyOnSessionCreate),
    includeModel: asBool(raw.includeModel, BRIDGE_DEFAULTS.includeModel),
    includeProject: asBool(raw.includeProject, BRIDGE_DEFAULTS.includeProject),
    includeDuration: asBool(raw.includeDuration, BRIDGE_DEFAULTS.includeDuration),
    maxTaskChars,
    maxResultChars,
    minResultChars,
    timeoutMs,
    retries,
    stateTtlDays,
    token,
    chatId,
    configDir,
    configFile,
    envFile,
    stateDir,
    logFile: join(stateDir, "notifier.log"),
    routesFile: join(stateDir, "routes.json"),
  };
}

/** Полный объект конфига из дефолтов + переопределений (удобно для тестов и заглушек). */
export function makeBridgeConfig(overrides: Partial<BridgeConfig> = {}): BridgeConfig {
  const stateDir = overrides.stateDir ?? DEFAULT_STATE_DIR;
  return {
    ...BRIDGE_DEFAULTS,
    token: "",
    chatId: "",
    configDir: DEFAULT_CONFIG_DIR,
    configFile: join(DEFAULT_CONFIG_DIR, "telegram-bridge.json"),
    envFile: DEFAULT_ENV_FILE,
    stateDir,
    logFile: join(stateDir, "notifier.log"),
    routesFile: join(stateDir, "routes.json"),
    ...overrides,
  };
}
