// routes.ts — персистентный routes.json:
//   messages    — маршруты message_id → сессия + дедуп отправок;
//   permissions — маршруты rid → {sessionID, permissionID, serverUrl, ...} (спринт 3);
//   questions   — маршруты rid → {sessionID, requestID, questions, ...} (инструмент question).
// Запись только атомарная: каталог 700, файл 600, tmp + rename под advisory-локом.
// Все секции работают через один файл и один механизм (flock/коррупция-recovery).
// Битый JSON переименовывается в routes.json.corrupt-<timestamp>, содержимое не логируется.
import { randomBytes, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { chmod, mkdir, open, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { DEFAULT_STATE_DIR } from "./config.ts";

export type Route = {
  sessionID: string;
  serverUrl: string;
  directory: string;
  sentAt: number;
};

export type RouteInput = {
  sessionID: string;
  serverUrl: string;
  directory: string;
  sentAt?: number;
};

/** Маршрут permission-кнопки: rid → сессия/permission для будущего ответа (спринт 4). */
export type PermissionRoute = {
  sessionID: string;
  permissionID: string;
  serverUrl: string;
  directory: string;
  messageId: number;
  createdAt: number;
};

/** Один вариант ответа вопроса инструмента `question`. */
export type QuestionOption = {
  label: string;
  description: string;
};

/** Один вопрос инструмента `question` (payload event.properties.questions[i]). */
export type QuestionItem = {
  question: string;
  header: string;
  options: QuestionOption[];
  multiple: boolean;
  custom: boolean;
  /**
   * Индекс соответствующего поля в raw `Form.Field[]` (form.fields), 0-based.
   * Пропуск полей без title/key не должен сдвигать соответствие questions ↔
   * fields: бридж собирает тело `{answer:{key:value}}` по нему, а не по позиции
   * в массиве questions. Необязателен (v1-события и старые записи routes.json) —
   * тогда используется позиционное поведение.
   */
  fieldIndex?: number;
};

/** Маршрут question-кнопки: rid → сессия/requestID/questions для ответа через бридж. */
export type QuestionRoute = {
  sessionID: string;
  /** В v2 это id формы (`frm_…`) — путь /api/session/<sid>/form/<formID>/reply. */
  requestID: string;
  serverUrl: string;
  directory: string;
  messageId: number;
  questions: QuestionItem[];
  /**
   * Raw `Form.Field[]` из события form.created (v2): ключ поля и `value` варианта
   * нужны бриджу для тела `{answer:{key:value}}`. Пишется только плагином.
   */
  fields?: unknown;
  /**
   * Для одиночного вопроса — `questions[0].fieldIndex` (индекс в raw
   * `form.fields`); дубликат для диагностики и совместимости схемы.
   * Основное сопоставление questions ↔ fields — `questions[i].fieldIndex`.
   * Необязателен: старые записи без него читаются как раньше.
   */
  fieldIndex?: number;
  /**
   * Маршрут последовательной формы: плагин отправил только Q1
   * (`messageId` = сообщение Q1), а `questions` содержит ВСЕ вопросы формы —
   * Q2..QN отправляет мост. Необязателен: старые записи без поля читаются
   * как legacy-маршрут (одно сообщение со всеми вопросами).
   */
  sequential?: boolean;
  createdAt: number;
};

export type RoutesState = {
  version: number;
  messages: Record<string, Route>;
  permissions: Record<string, PermissionRoute>;
  /** маршруты вопросов: rid → QuestionRoute */
  questions: Record<string, QuestionRoute>;
  /** дедуп по ключу `<sessionID>:<assistantMessageID>` → timestamp отправки */
  dedup: Record<string, number>;
  /** отправка, взятая в работу дочерним процессом: ключ → timestamp старта */
  pending: Record<string, number>;
};

/**
 * Короткий rid (12 hex-символов) для permission-/question-уведомления:
 * `perm:<rid>:<action>` = 5 + 12 + 1 + 4..6 ≤ 64 байт (лимит callback_data Telegram);
 * `q:<rid>:<oi>` / `q:<rid>:<qi>:<oi>` / `q:<rid>:<qi>:custom` = 17..24 байта того же порядка.
 */
export function generateRid(): string {
  return randomUUID().replace(/-/g, "").slice(0, 12);
}

/**
 * Ключ pending-записи `claimPermission` в секции `pending` state.
 * Формат должен совпадать у service.ts (withKeyLock/clearPending) и routes.ts.
 */
export function permissionPendingKey(permissionID: string): string {
  return `perm:${permissionID}`;
}

/**
 * Ключ pending-записи `claimQuestion` в секции `pending` state.
 * Формат должен совпадать у service.ts (withKeyLock/clearQuestionPending) и routes.ts.
 */
export function questionPendingKey(requestID: string): string {
  return `que:${requestID}`;
}

export type RoutesStore = {
  readonly file: string;
  readonly stateDir: string;
  recordMessage(messageId: number | string, route: RouteInput): Promise<void>;
  getMessage(messageId: number | string): Promise<Route | undefined>;
  /** атомарная запись permission-маршрута по rid */
  recordPermission(rid: string, route: PermissionRoute): Promise<void>;
  getPermission(rid: string): Promise<PermissionRoute | undefined>;
  /** дедуп: найти маршрут по значению permissionID (rid неизвестен до отправки) */
  findPermissionByPermissionID(permissionID: string): Promise<PermissionRoute | undefined>;
  /** удалить permission-записи старше ttl (по createdAt) */
  prunePermissions(ttlDays: number, now?: number): Promise<number>;
  prune(ttlDays: number, now?: number): Promise<number>;
  hasSent(key: string): Promise<boolean>;
  markSent(key: string, at?: number): Promise<void>;
  /** отметить, что отправка передана дочернему процессу (защита от дублей) */
  markPending(key: string, at?: number): Promise<void>;
  /** есть ли активная (не устаревшая) отправка в полёте */
  isPending(key: string, now?: number): Promise<boolean>;
  /** снять отметку «в полёте» (после успеха или ошибки отправки) */
  clearPending(key: string): Promise<void>;
  /**
   * Атомарное «проверить дедуп → проверить pending → занять» одним заходом под лок
   * (спринт 3: один цикл flock вместо трёх — короче секция критической зоны
   * и меньше шанс умереть в гонке на бюджет event-хука opencode).
   * Результат: `claimed` — отправка разрешена; `duplicate` — уже отправлено;
   * `pending` — уже в полёте (в т.ч. устаревшая запись перезанимается).
   */
  claimPending(key: string, at?: number): Promise<"duplicate" | "pending" | "claimed">;
  /**
   * Атомарная выдача permission на отправку (спринт 6): под локом проверяет,
   * что permissionID ещё нет в `permissions` и не занят в pending-механике
   * (`perm:<permissionID>`), иначе занимает pending-запись.
   * `claimed` — можно отправлять; `duplicate` — уже отправлено/уже в полёте.
   * После recordPermission или ошибки отправки — снять через
   * clearPending(permissionPendingKey(permissionID)).
   */
  claimPermission(permissionID: string, at?: number): Promise<"claimed" | "duplicate">;
  /**
   * Атомарная выдача права на отправку вопроса: зеркало claimPermission —
   * под локом проверяет, что requestID ещё нет в `questions` и не занят
   * в pending-механике (`que:<requestID>`), иначе занимает pending-запись.
   * `claimed` — можно отправлять; `duplicate` — уже отправлено/уже в полёте.
   * После recordQuestion или ошибки отправки — снять через
   * clearQuestionPending(questionPendingKey(requestID)).
   */
  claimQuestion(requestID: string, at?: number): Promise<"claimed" | "duplicate">;
  /** атомарная запись question-маршрута по rid */
  recordQuestion(rid: string, route: QuestionRoute): Promise<void>;
  getQuestion(rid: string): Promise<QuestionRoute | undefined>;
  /** дедуп/settle: найти маршрут по значению requestID (rid неизвестен до отправки) */
  getQuestionByRequestID(requestID: string): Promise<{ rid: string; route: QuestionRoute } | undefined>;
  /**
   * Атомарно забрать и удалить маршрут по requestID. Побеждает ровно один
   * процесс — иначе все подписчики события form.replied правят одно и то же
   * TG-сообщение десятки раз и упираются в rate limit Telegram.
   */
  takeQuestionByRequestID(requestID: string): Promise<{ rid: string; route: QuestionRoute } | undefined>;
  /** найти question-маршрут по message_id отправленного TG-сообщения */
  getQuestionByMessage(messageId: number): Promise<QuestionRoute | undefined>;
  removeQuestion(rid: string): Promise<void>;
  /** снять pending-запись claimQuestion (ключ из questionPendingKey) */
  clearQuestionPending(key: string): Promise<void>;
  /** удалить question-записи старше ttl (по createdAt) */
  pruneQuestions(ttlDays: number, now?: number): Promise<number>;
  /**
   * Удалить осиротевшие `${file}.tmp-*` старше maxAgeMs (по умолчанию TMP_STALE_MS):
   * tmp-файлы живут миллисекунды, поэтому файл старше часа — писатель умер.
   */
  cleanupStaleTmp(maxAgeMs?: number): Promise<number>;
  readState(): Promise<RoutesState>;
};

/** Сколько времени запись «в полёте» считается активной (дальше — stale и разрешён повтор). */
export const PENDING_TTL_MS = 10 * 60 * 1000;

/**
 * Дефолтный таймаут ожидания advisory-лока routes.json. 2000 мс не хватало
 * под нагрузкой (десятки `routes: timeout waiting for lock`) → 10 с.
 */
export const DEFAULT_LOCK_TIMEOUT_MS = 10 * 1000;

/** Возраст, после которого осиротевший `${file}.tmp-*` считается брошенным. */
export const TMP_STALE_MS = 60 * 60 * 1000;

export type CreateRoutesOptions = {
  stateDir?: string;
  /** Полный путь к routes.json (по умолчанию <stateDir>/routes.json). */
  file?: string;
  lockTimeoutMs?: number;
  staleLockMs?: number;
  now?: () => number;
};

function emptyState(): RoutesState {
  return { version: 1, messages: {}, permissions: {}, questions: {}, dedup: {}, pending: {} };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function createRoutes(options: CreateRoutesOptions = {}): RoutesStore {
  const stateDir = options.stateDir ?? DEFAULT_STATE_DIR;
  const file = options.file ?? join(stateDir, "routes.json");
  const lockFile = `${file}.lock`;
  const lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const staleLockMs = options.staleLockMs ?? 30000;
  const now = options.now ?? (() => Date.now());

  let chain: Promise<unknown> = Promise.resolve();

  async function ensureDirs(): Promise<void> {
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    try {
      await chmod(stateDir, 0o700);
    } catch {
      /* каталог уже есть / нет прав — не фатально */
    }
  }

  /** Чтение состояния; corrupt → {state: empty, corrupt: true} (содержимое не возвращается). */
  async function loadState(): Promise<{ state: RoutesState; corrupt: boolean }> {
    let raw: string;
    try {
      raw = await readFile(file, "utf8");
    } catch {
      return { state: emptyState(), corrupt: false };
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!isPlainObject(parsed)) throw new Error("invalid shape");
      const messages = parsed.messages;
      if (messages !== undefined && !isPlainObject(messages)) throw new Error("invalid messages");
      const dedup = parsed.dedup;
      if (dedup !== undefined && !isPlainObject(dedup)) throw new Error("invalid dedup");
      const permissions = parsed.permissions;
      if (permissions !== undefined && !isPlainObject(permissions)) throw new Error("invalid permissions");
      const questions = parsed.questions;
      if (questions !== undefined && !isPlainObject(questions)) throw new Error("invalid questions");
      const pending = parsed.pending;
      if (pending !== undefined && !isPlainObject(pending)) throw new Error("invalid pending");
      return {
        state: {
          version: 1,
          messages: (messages as Record<string, Route>) ?? {},
          permissions: (permissions as Record<string, PermissionRoute>) ?? {},
          // файл без секции questions (legacy) читается — questions={}
          questions: (questions as Record<string, QuestionRoute>) ?? {},
          dedup: (dedup as Record<string, number>) ?? {},
          pending: (pending as Record<string, number>) ?? {},
        },
        corrupt: false,
      };
    } catch {
      return { state: emptyState(), corrupt: true };
    }
  }

  async function recoverIfNeeded(load: { state: RoutesState; corrupt: boolean }): Promise<RoutesState> {
    if (!load.corrupt) return load.state;
    const backup = `${file}.corrupt-${now()}`;
    try {
      await rename(file, backup);
    } catch {
      /* файл мог исчезнуть — игнорируем */
    }
    return emptyState();
  }

  /** Чтение с автоматическим corrupt-recovery (для read-only API). */
  async function readState(): Promise<RoutesState> {
    await ensureDirs();
    return recoverIfNeeded(await loadState());
  }

  async function persist(state: RoutesState): Promise<void> {
    await ensureDirs();
    const tmp = `${file}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
    await writeFile(tmp, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
    await rename(tmp, file);
    try {
      await chmod(file, 0o600);
    } catch {
      /* не фатально */
    }
  }

  /**
   * Осиротевшие tmp-файлы: `${file}.tmp-*` живут миллисекунды (write+rename),
   * поэтому файл старше maxAgeMs остался после убитого писателя. Возрастная
   * проверка делает удаление безопасным и без лока: активный tmp никогда не старше.
   */
  async function cleanupStaleTmpImpl(maxAgeMs?: number): Promise<number> {
    const age =
      typeof maxAgeMs === "number" && Number.isFinite(maxAgeMs) && maxAgeMs >= 0
        ? maxAgeMs
        : TMP_STALE_MS;
    const dir = dirname(file);
    const prefix = `${basename(file)}.tmp-`;
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return 0;
    }
    const cutoff = now() - age;
    let removed = 0;
    for (const name of names) {
      if (!name.startsWith(prefix)) continue;
      const path = join(dir, name);
      try {
        const info = await stat(path);
        if (info.isFile() && info.mtimeMs < cutoff) {
          await unlink(path);
          removed += 1;
        }
      } catch {
        /* файл исчез между readdir и unlink — не фатально */
      }
    }
    return removed;
  }

  async function acquireLock(): Promise<number> {
    await ensureDirs();
    const deadline = Date.now() + lockTimeoutMs;
    for (;;) {
      try {
        return await open(lockFile, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EEXIST") throw error;
        // Просроченный лок (владелец умер) — удаляем и пробуем снова.
        try {
          const info = await stat(lockFile);
          if (Date.now() - info.mtimeMs > staleLockMs) {
            await unlink(lockFile);
            continue;
          }
        } catch {
          continue;
        }
        if (Date.now() >= deadline) throw new Error("routes: timeout waiting for lock");
        // Один и тот же протокол у плагина и бриджа (спринт 5, п.3.4а):
        // open(path,'wx') → EEXIST → poll 50 мс до lockTimeoutMs (10 с) →
        // stale 30 с → в finally close+unlink. Общий модуль недоступен плагину из-за
        // изолированного каталога загрузки, поэтому контракт дублируется
        // идентично bridge/lock.ts и проверяется общим тестом
        // test_lock_serializes_writers.
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
  }

  /** Критическая секция: сериализация в процессе + advisory-лок между процессами. */
  async function withLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = chain.then(
      () => exclusive(fn),
      () => exclusive(fn),
    );
    chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async function exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const handle = await acquireLock();
    try {
      return await fn();
    } finally {
      try {
        await handle.close();
      } catch {
        /* уже закрыт */
      }
      try {
        await unlink(lockFile);
      } catch {
        /* лок уже снят/перехвачен stale-логикой */
      }
    }
  }

  async function mutate(mutator: (state: RoutesState) => void): Promise<void> {
    await withLock(async () => {
      const state = await recoverIfNeeded(await loadState());
      mutator(state);
      await persist(state);
    });
  }

  return {
    file,
    stateDir,

    async recordMessage(messageId, route) {
      const key = String(messageId);
      await mutate((state) => {
        state.messages[key] = {
          sessionID: route.sessionID,
          serverUrl: route.serverUrl,
          directory: route.directory,
          sentAt: typeof route.sentAt === "number" && Number.isFinite(route.sentAt) ? route.sentAt : now(),
        };
      });
    },

    async getMessage(messageId) {
      const state = await readState();
      return state.messages[String(messageId)];
    },

    async recordPermission(rid, route) {
      const key = String(rid);
      await mutate((state) => {
        state.permissions[key] = {
          sessionID: route.sessionID,
          permissionID: route.permissionID,
          serverUrl: route.serverUrl,
          directory: route.directory,
          messageId: route.messageId,
          createdAt:
            typeof route.createdAt === "number" && Number.isFinite(route.createdAt)
              ? route.createdAt
              : now(),
        };
      });
    },

    async getPermission(rid) {
      const state = await readState();
      return state.permissions[String(rid)];
    },

    async findPermissionByPermissionID(permissionID) {
      if (!permissionID) return undefined;
      const state = await readState();
      for (const route of Object.values(state.permissions)) {
        if (route?.permissionID === permissionID) return route;
      }
      return undefined;
    },

    async prunePermissions(ttlDays, nowOverride) {
      const ttl = Math.max(1, Math.round(ttlDays)) * 86400000;
      const current = typeof nowOverride === "number" ? nowOverride : now();
      const cutoff = current - ttl;
      let removed = 0;
      await mutate((state) => {
        for (const key of Object.keys(state.permissions)) {
          const createdAt = state.permissions[key]?.createdAt ?? 0;
          if (createdAt < cutoff) {
            delete state.permissions[key];
            removed += 1;
          }
        }
      });
      return removed;
    },

    async recordQuestion(rid, route) {
      const key = String(rid);
      await mutate((state) => {
        state.questions[key] = {
          sessionID: route.sessionID,
          requestID: route.requestID,
          serverUrl: route.serverUrl,
          directory: route.directory,
          messageId: route.messageId,
          questions: Array.isArray(route.questions) ? route.questions : [],
          // raw Form.Field[] (v2) — бридж собирает из него тело {answer:{…}}
          ...(route.fields === undefined ? {} : { fields: route.fields }),
          // индекс одиночного поля формы (см. QuestionRoute.fieldIndex); необязателен
          ...(route.fieldIndex === undefined ? {} : { fieldIndex: route.fieldIndex }),
          // sequential-форма: Q1 отправлена плагином, Q2..QN отправит мост
          ...(route.sequential === true ? { sequential: true } : {}),
          createdAt:
            typeof route.createdAt === "number" && Number.isFinite(route.createdAt)
              ? route.createdAt
              : now(),
        };
      });
    },

    async getQuestion(rid) {
      const state = await readState();
      return state.questions[String(rid)];
    },

    async getQuestionByRequestID(requestID) {
      if (!requestID) return undefined;
      const state = await readState();
      for (const [rid, route] of Object.entries(state.questions)) {
        if (route?.requestID === requestID) return { rid, route };
      }
      return undefined;
    },

    async takeQuestionByRequestID(requestID) {
      if (!requestID) return undefined;
      return withLock(async () => {
        const state = await recoverIfNeeded(await loadState());
        for (const [rid, route] of Object.entries(state.questions)) {
          if (route?.requestID !== requestID) continue;
          delete state.questions[rid];
          await persist(state);
          return { rid, route };
        }
        return undefined;
      });
    },

    async getQuestionByMessage(messageId) {
      const state = await readState();
      for (const route of Object.values(state.questions)) {
        if (route?.messageId === messageId) return route;
      }
      return undefined;
    },

    async removeQuestion(rid) {
      const key = String(rid);
      await mutate((state) => {
        delete state.questions[key];
      });
    },

    async clearQuestionPending(key) {
      await mutate((state) => {
        delete state.pending[key];
      });
    },

    async pruneQuestions(ttlDays, nowOverride) {
      const ttl = Math.max(1, Math.round(ttlDays)) * 86400000;
      const current = typeof nowOverride === "number" ? nowOverride : now();
      const cutoff = current - ttl;
      let removed = 0;
      await mutate((state) => {
        for (const key of Object.keys(state.questions)) {
          const createdAt = state.questions[key]?.createdAt ?? 0;
          if (createdAt < cutoff) {
            delete state.questions[key];
            removed += 1;
          }
        }
      });
      return removed;
    },

    async hasSent(key) {
      // проверка дедупа — под локом, как того требует порядок «проверить → отправить → пометить»
      return withLock(async () => {
        const state = await recoverIfNeeded(await loadState());
        return typeof state.dedup[key] === "number";
      });
    },

    async markSent(key, at) {
      const timestamp = typeof at === "number" && Number.isFinite(at) ? at : now();
      await mutate((state) => {
        state.dedup[key] = timestamp;
        delete state.pending[key];
      });
    },

    async markPending(key, at) {
      const timestamp = typeof at === "number" && Number.isFinite(at) ? at : now();
      await mutate((state) => {
        state.pending[key] = timestamp;
      });
    },

    async isPending(key, nowOverride) {
      const state = await readState();
      const timestamp = state.pending[key];
      if (typeof timestamp !== "number") return false;
      const current = typeof nowOverride === "number" ? nowOverride : now();
      // устаревшая запись «в полёте» (дочерний процесс убит) не блокирует повтор
      if (current - timestamp > PENDING_TTL_MS) {
        await mutate((draft) => {
          delete draft.pending[key];
        });
        return false;
      }
      return true;
    },

    async clearPending(key) {
      await mutate((state) => {
        delete state.pending[key];
      });
    },

    async claimPending(key, at) {
      const timestamp = typeof at === "number" && Number.isFinite(at) ? at : now();
      return withLock(async () => {
        const state = await recoverIfNeeded(await loadState());
        if (typeof state.dedup[key] === "number") return "duplicate";
        const existing = state.pending[key];
        if (typeof existing === "number" && timestamp - existing <= PENDING_TTL_MS) {
          return "pending";
        }
        state.pending[key] = timestamp;
        await persist(state);
        return "claimed";
      });
    },

    async claimPermission(permissionID, at) {
      if (!permissionID) return "duplicate";
      const timestamp = typeof at === "number" && Number.isFinite(at) ? at : now();
      const key = permissionPendingKey(permissionID);
      // один цикл flock: проверка permissions → проверка pending → занятие pending
      // атомарны между процессами (read-then-write был небезопасен)
      return withLock(async () => {
        const state = await recoverIfNeeded(await loadState());
        for (const route of Object.values(state.permissions)) {
          if (route?.permissionID === permissionID) return "duplicate";
        }
        const existing = state.pending[key];
        if (typeof existing === "number" && timestamp - existing <= PENDING_TTL_MS) {
          return "duplicate";
        }
        state.pending[key] = timestamp;
        await persist(state);
        return "claimed";
      });
    },

    async claimQuestion(requestID, at) {
      if (!requestID) return "duplicate";
      const timestamp = typeof at === "number" && Number.isFinite(at) ? at : now();
      const key = questionPendingKey(requestID);
      // тот же один цикл flock, что и у claimPermission: вопросы не дублируются
      // при двойной регистрации плагина и при гонке read-then-write между процессами
      return withLock(async () => {
        const state = await recoverIfNeeded(await loadState());
        for (const route of Object.values(state.questions)) {
          if (route?.requestID === requestID) return "duplicate";
        }
        const existing = state.pending[key];
        if (typeof existing === "number" && timestamp - existing <= PENDING_TTL_MS) {
          return "duplicate";
        }
        state.pending[key] = timestamp;
        await persist(state);
        return "claimed";
      });
    },

    cleanupStaleTmp: cleanupStaleTmpImpl,

    async prune(ttlDays, nowOverride) {
      const ttl = Math.max(1, Math.round(ttlDays)) * 86400000;
      const current = typeof nowOverride === "number" ? nowOverride : now();
      const cutoff = current - ttl;
      let removed = 0;
      await mutate((state) => {
        for (const key of Object.keys(state.messages)) {
          const sentAt = state.messages[key]?.sentAt ?? 0;
          if (sentAt < cutoff) {
            delete state.messages[key];
            removed += 1;
          }
        }
        for (const key of Object.keys(state.dedup)) {
          const ts = state.dedup[key] ?? 0;
          if (ts < cutoff) delete state.dedup[key];
        }
        for (const key of Object.keys(state.pending)) {
          const ts = state.pending[key] ?? 0;
          if (current - ts > PENDING_TTL_MS) delete state.pending[key];
        }
      });
      return removed;
    },

    readState,
  };
}

/**
 * TTL-очистка при старте процесса (спринт 5, п.3.4в): удаляет записи
 * messages/permissions/questions/dedup/pending старше `ttlDays` (stateTtlDays из
 * telegram-bridge.json) и осиротевшие `${file}.tmp-*` (спринт 6).
 * Вызывается один раз из buildHooks плагина.
 * Секции prune, prunePermissions и pruneQuestions идут последовательно под общим локом
 * (тот же протокол, что у бриджа).
 */
export async function startupCleanup(
  routes: RoutesStore,
  ttlDays: number,
): Promise<{ messages: number; permissions: number; questions: number; tmp: number }> {
  const tmp = await routes.cleanupStaleTmp();
  const messages = await routes.prune(ttlDays);
  const permissions = await routes.prunePermissions(ttlDays);
  const questions = await routes.pruneQuestions(ttlDays);
  return { messages, permissions, questions, tmp };
}
