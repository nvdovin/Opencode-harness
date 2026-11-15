// service.ts — оркестрация: child-skip, фильтры статусов, дедуп под локом,
// передача доставки в отсоединённый процесс, сериализация idle одной сессии,
// обработчики permission.updated/permission.asked, question.asked, settle-события.
import type { BridgeConfig } from "./config.ts";
import { buildExtraction, type ExtractedMessage, type ExtractedSession } from "./extract.ts";
import {
  buildPermissionKeyboard,
  buildQuestionPageKeyboard,
  formatDone,
  formatPermission,
  formatQuestionPage,
  formatSessionCreated,
  htmlEscape,
  MAX_MESSAGE_CHARS as MAX_QUESTION_CHARS,
  projectFromDirectory,
  truncate,
} from "./format.ts";
import { createLogger, type Logger } from "./logger.ts";
import {
  spawnNotify,
  type NotifyFn,
  type NotifyPayload,
} from "./notify.ts";
import {
  createRoutes,
  generateRid,
  permissionPendingKey,
  questionPendingKey,
  type QuestionItem,
  type QuestionOption,
  type QuestionRoute,
  type RoutesStore,
} from "./routes.ts";
import { editTelegramMessage, sendTelegramMessage, type FetchLike } from "./telegram.ts";

export type { NotifyFn, NotifyPayload };
export type { SendImpl } from "./telegram.ts";

export type SessionClient = {
  session: {
    get(input: {
      path: { id: string };
      query?: { directory?: string };
    }): Promise<{ data?: unknown; error?: unknown }>;
    messages(input: {
      path: { id: string };
      query?: { directory?: string; limit?: number };
    }): Promise<{ data?: unknown; error?: unknown }>;
  };
};

export type CreateBridgeDeps = {
  client: SessionClient;
  directory: string;
  serverUrl: string;
  config: BridgeConfig;
  routes?: RoutesStore;
  logger?: Logger;
  /** Замена стратегии доставки (тесты подставляют in-process реализацию). */
  notify?: NotifyFn;
  /** Инжектируемый fetch для permission-отправки (тесты подставляют фейковый). */
  fetchImpl?: FetchLike;
  now?: () => number;
};

/** Свойства события `permission.updated` / `permission.asked` (объект Permission из opencode). */
export type PermissionProperties = {
  id?: string;
  sessionID?: string;
  title?: string;
  pattern?: string | string[];
  /** opencode ≥1.19: тип разрешения (edit/bash/external_directory/…) */
  permission?: string;
  /** opencode ≥1.19: массив паттернов */
  patterns?: string[];
  /** opencode ≥1.19: {filepath, parentDir, …} */
  metadata?: Record<string, unknown>;
  /** посторонние поля payload (в т.ч. serverUrl) игнорируются: источник — PluginInput */
  [key: string]: unknown;
};

/** Свойства события `question.asked` / `question.v2.asked` (QuestionRequest из opencode). */
export type QuestionProperties = {
  id?: string;
  sessionID?: string;
  /** массив вопросов; нормализуется в handleQuestion (битые записи отбрасываются) */
  questions?: unknown;
  /**
   * Raw `Form.Field[]` из события form.created (v2). Нужен бриджу, чтобы собрать
   * тело `{answer:{key:value}}` по ключам полей и `value` вариантов.
   */
  fields?: unknown;
  /** v2 form.created несёт location; fallback, если session.get недоступен */
  location?: { directory?: string };
  tool?: { messageID?: string; callID?: string };
  [key: string]: unknown;
};

/** Свойства события `question.replied`/`question.rejected` (и v2-вариантов). */
export type QuestionSettledProperties = {
  sessionID?: string;
  requestID?: string;
  /** string[][] — по массиву меток на каждый вопрос (v1) */
  answers?: unknown;
  /** Ответ формы `{key: value}` (v2) — конвертируется в метки по route.fields */
  answer?: unknown;
  [key: string]: unknown;
};

export type QuestionSettleAction = "replied" | "rejected";

export type Bridge = {
  handleIdle(sessionID: string): Promise<void>;
  /** опционально: обработчик permission.updated / permission.asked */
  handlePermission?(properties?: PermissionProperties): Promise<void>;
  /** опционально: обработчик session.created — «новая сессия» в Telegram */
  handleSessionCreated?(info?: SessionCreatedInfo): Promise<void>;
  /** опционально: обработчик question.asked — вопрос агента с кнопками */
  handleQuestion?(properties?: QuestionProperties): Promise<void>;
  /** опционально: обработчик question.replied / question.rejected (settle) */
  handleQuestionSettled?(
    properties?: QuestionSettledProperties,
    action?: QuestionSettleAction,
  ): Promise<void>;
};

/** Свойства `session.created` (info: Session из opencode). */
export type SessionCreatedInfo = {
  id?: string;
  directory?: string;
  parentID?: string;
  title?: string;
  time?: { created?: number };
  [key: string]: unknown;
};

function asMessageList(data: unknown): ExtractedMessage[] {
  return Array.isArray(data) ? (data as ExtractedMessage[]) : [];
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Нормализация `properties.questions` из события question.asked: строковые
 * question/header, options — массив {label, description}; записи без текста
 * вопроса или без метки варианта отбрасываются, multiple/custom → boolean.
 * Необязательный `fieldIndex` (индекс в raw form.fields, см. fieldsToQuestions)
 * сохраняется — без него бридж не сможет выровнять ответ с полями формы.
 * Пустой результат → handleQuestion пишет question.skipped reason=invalid_questions.
 */
function normalizeQuestions(value: unknown): QuestionItem[] {
  if (!Array.isArray(value)) return [];
  const out: QuestionItem[] = [];
  for (const entry of value) {
    if (!isPlainRecord(entry)) continue;
    const question = typeof entry.question === "string" ? entry.question : "";
    if (!question.trim()) continue;
    const options: QuestionOption[] = [];
    if (Array.isArray(entry.options)) {
      for (const option of entry.options) {
        if (!isPlainRecord(option)) continue;
        const label = typeof option.label === "string" ? option.label : "";
        if (!label.trim()) continue;
        options.push({
          label,
          description: typeof option.description === "string" ? option.description : "",
        });
      }
    }
    const fieldIndex =
      typeof entry.fieldIndex === "number" &&
      Number.isInteger(entry.fieldIndex) &&
      entry.fieldIndex >= 0
        ? entry.fieldIndex
        : undefined;
    out.push({
      question,
      header: typeof entry.header === "string" ? entry.header : "",
      options,
      multiple: entry.multiple === true,
      custom: entry.custom === true,
      ...(fieldIndex === undefined ? {} : { fieldIndex }),
    });
  }
  return out;
}

/**
 * Текст правки сообщения после settle: исходный текст вопроса не хранится,
 * поэтому сообщение заменяется коротким итогом (≤3900, htmlEscape).
 */
function formatQuestionSettledText(action: QuestionSettleAction, answers: unknown): string {
  if (action !== "replied") return "<b>❌ Вопрос отклонён</b>";
  const flat: string[] = [];
  if (Array.isArray(answers)) {
    for (const entry of answers) {
      if (Array.isArray(entry)) {
        for (const label of entry) if (typeof label === "string") flat.push(label);
      } else if (typeof entry === "string") {
        flat.push(entry);
      }
    }
  }
  const answer = truncate(flat.join(", "), MAX_QUESTION_CHARS - 100);
  if (!answer) return "<b>✅ Вопрос отвечен</b>";
  return `<b>✅ Вопрос отвечен</b>\n<i>Ответ: ${htmlEscape(answer)}</i>`;
}

/**
 * Модульный лок по ключу дедупа (общий для всех экземпляров сервиса в одном процессе).
 * opencode может вызывать функцию плагина дважды за конфиг-проход → два хука на одно
 * событие; без такого лока оба прошли бы проверку hasSent/isPending до отметки и
 * запустили бы два дочерних процесса. Секция «проверить → отметить → отдать в работу»
 * атомарна.
 */
const keyLocks = new Map<string, Promise<unknown>>();

async function withKeyLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = keyLocks.get(key) ?? Promise.resolve();
  const next = previous.then(fn, fn);
  const safe = next.then(
    () => undefined,
    () => undefined,
  );
  keyLocks.set(key, safe);
  try {
    return await next;
  } finally {
    if (keyLocks.get(key) === safe) keyLocks.delete(key);
  }
}

/**
 * Окно cooldown idle-уведомлений внутри процесса: если для sessionID уже было
 * отправлено уведомление <8 с назад, второй session.idle пропускается
 * (дедуп по assistantMessageID не спасает — у сообщений разные id).
 * Межпроцессный дубль того же сообщения покрывает claimPending по dedupKey.
 */
export const IDLE_COOLDOWN_MS = 8000;

/**
 * Ответ формы v2 `{key: value}` → метки вариантов (string[][]) для итогового
 * текста сообщения. Значения без известного `option.value` берутся как есть.
 */
function labelsFromAnswer(fields: unknown, answer: unknown): string[][] | undefined {
  if (!Array.isArray(fields) || !isPlainRecord(answer)) return undefined;
  const out: string[][] = [];
  for (const field of fields) {
    if (!isPlainRecord(field)) continue;
    const key = typeof field.key === "string" ? field.key : "";
    if (!key || !(key in answer)) continue;
    const value = answer[key];
    const options = Array.isArray(field.options) ? field.options : [];
    const values = Array.isArray(value) ? value : [value];
    out.push(
      values.map((item) => {
        const option = options.find(
          (candidate) => isPlainRecord(candidate) && candidate.value === item,
        );
        return isPlainRecord(option) && typeof option.label === "string"
          ? option.label
          : String(item);
      }),
    );
  }
  return out.length > 0 ? out : undefined;
}

/**
 * Метки ответа на Q1 (qi=0) sequential-формы для финальной правки сообщения.
 * v1 присылает `answers: string[][]` — берём первый элемент; v2 присылает
 * `answer: {key: value}` — ищем поле Q1 по `questions[0].fieldIndex`
 * (фоллбэк: первое поле / первая метка), чтобы не показать ответ другого вопроса.
 */
function sequentialFirstAnswer(
  route: QuestionRoute,
  properties: QuestionSettledProperties | undefined,
): string[][] {
  if (Array.isArray(properties?.answers)) {
    const first = properties.answers[0];
    if (Array.isArray(first)) {
      return [first.filter((label): label is string => typeof label === "string")];
    }
    return typeof first === "string" ? [[first]] : [];
  }
  if (!isPlainRecord(properties?.answer)) return [];
  const fields = Array.isArray(route.fields) ? route.fields : [];
  const fieldIndex = route.questions?.[0]?.fieldIndex;
  const field =
    typeof fieldIndex === "number" && isPlainRecord(fields[fieldIndex])
      ? fields[fieldIndex]
      : isPlainRecord(fields[0])
        ? fields[0]
        : undefined;
  if (field) {
    const key = typeof field.key === "string" ? field.key : "";
    if (key && key in properties.answer) {
      const labels = labelsFromAnswer([field], { [key]: properties.answer[key] });
      if (labels) return labels;
    }
  }
  return labelsFromAnswer(route.fields, properties.answer)?.slice(0, 1) ?? [];
}

export function createBridge(deps: CreateBridgeDeps): Bridge {
  const { client, directory, serverUrl, config } = deps;
  const logger =
    deps.logger ??
    createLogger({
      logFile: config.logFile,
      secrets: { token: config.token, chatId: config.chatId },
      silent: true,
    });
  const routes = deps.routes ?? createRoutes({ stateDir: config.stateDir, file: config.routesFile });
  const now = deps.now ?? (() => Date.now());
  const notify: NotifyFn =
    deps.notify ??
    (async (payload) => spawnNotify(payload, { stateDir: config.stateDir }));
  const inflight = new Map<string, Promise<void>>();
  /** timestamp последнего успешного idle-уведомления по sessionID (cooldown). */
  const idleCooldown = new Map<string, number>();

  async function run(sessionID: string): Promise<void> {
    // 1–2. сессия и сообщения — параллельно (бюджет event-хука opencode ≈200–300 мс)
    const fetchStarted = now();
    const [sessionResult, messagesResult] = await Promise.all([
      client.session.get({ path: { id: sessionID }, query: { directory } }),
      client.session.messages({ path: { id: sessionID }, query: { directory } }),
    ]);
    logger.info("idle.fetched", {
      session: sessionID,
      duration_ms: Math.max(0, now() - fetchStarted),
    });
    if (!sessionResult || sessionResult.error || !sessionResult.data) {
      throw new Error("session.get failed");
    }
    if (!messagesResult || messagesResult.error || !messagesResult.data) {
      throw new Error("session.messages failed");
    }
    const session = sessionResult.data as ExtractedSession;

    // дочерние (subagent) сессии не уведомляются
    if (session.parentID) {
      logger.info("idle.skipped", { session: sessionID, reason: "child_session" });
      return;
    }

    const extraction = buildExtraction(session, asMessageList(messagesResult.data), serverUrl, now());
    if (!extraction.isRoot) {
      logger.info("idle.skipped", { session: sessionID, reason: "child_session" });
      return;
    }

    // 3. фильтры по конфигурации; notifyOnQuestion=false → вопрос уходит обычным success
    const status =
      extraction.status === "question" && !config.notifyOnQuestion
        ? "success"
        : extraction.status;
    if (status === "error" && !config.notifyOnError) {
      logger.info("idle.skipped", { session: sessionID, reason: "notify_on_error_disabled" });
      return;
    }
    if (status === "abort" && !config.notifyOnAbort) {
      logger.info("idle.skipped", { session: sessionID, reason: "notify_on_abort_disabled" });
      return;
    }
    if (!extraction.assistantMessageID) {
      logger.info("idle.skipped", { session: sessionID, reason: "no_assistant_message" });
      return;
    }

    // фильтр тривиального итога: success с пустым/очень коротким result
    // («Готово.») не уведомляем. Касается только success ПОСЛЕ понижения
    // question→success; error/abort не фильтруются.
    if (status === "success") {
      const minResultChars = config.minResultChars ?? 40;
      if (extraction.result.trim().length < minResultChars) {
        logger.info("idle.skipped", { session: sessionID, reason: "trivial_result" });
        return;
      }
    }

    // 6. дедуп: один атомарный claim (проверка+занятие) под локом ДО передачи в работу;
    // ошибка доставки снимает pending и не помечает ключ → следующий idle повторит.
    // Форматирование — синхронное и выполняется ДО лока, чтобы секция критической
    // зоны была максимально короткой (бюджет event-хука opencode ≈200–300 мс).
    const dedupKey = `${sessionID}:${extraction.assistantMessageID}`;
    const text = formatDone(
      {
        status,
        task: extraction.task,
        result: extraction.result,
        project: projectFromDirectory(session.directory || directory),
        model: extraction.model,
        durationMs: extraction.durationMs,
        errorMessage: extraction.errorMessage,
      },
      config,
    );

    await withKeyLock(dedupKey, async () => {
      const claim = await routes.claimPending(dedupKey);
      if (claim !== "claimed") {
        logger.info("idle.skipped", { session: sessionID, reason: claim });
        return;
      }
      // cooldown: второе idle-уведомление той же сессии в окне <8 с — дубль
      // (другой assistantMessageID → dedup его не поймал). Pending снимается,
      // чтобы следующий idle после окна мог уведомить заново.
      const lastSentAt = idleCooldown.get(sessionID);
      if (typeof lastSentAt === "number" && now() - lastSentAt < IDLE_COOLDOWN_MS) {
        await routes.clearPending(dedupKey);
        logger.info("idle.skipped", { session: sessionID, reason: "cooldown" });
        return;
      }
      logger.info("idle.claimed", { session: sessionID, chars: text.length });

      const payload: NotifyPayload = {
        text,
        sessionID,
        serverUrl,
        directory: session.directory || directory,
        dedupKey,
        status,
        durationMs: extraction.durationMs,
        chars: text.length,
        configDir: config.configDir,
      };

      let outcome: { pid?: number } | void;
      try {
        outcome = await notify(payload);
      } catch (error) {
        await routes.clearPending(dedupKey);
        throw error;
      }
      // timestamp ставится только после успешной отправки: упавший notify
      // должен разрешить немедленный повтор (cooldown не блокирует retry)
      idleCooldown.set(sessionID, now());
      logger.info("telegram.queued", {
        session: sessionID,
        status,
        chars: text.length,
        pid: outcome && typeof outcome === "object" ? outcome.pid : undefined,
      });
    });
  }

  function handleIdle(sessionID: string): Promise<void> {
    const previous = inflight.get(sessionID);
    const next = (previous ?? Promise.resolve()).then(() => run(sessionID));
    // в map храним только «безопасную» версию, чтобы ошибка не блокировала следующие idle
    const safe = next.then(
      () => undefined,
      () => undefined,
    );
    inflight.set(sessionID, safe);
    return next.finally(() => {
      if (inflight.get(sessionID) === safe) inflight.delete(sessionID);
    });
  }

  /**
   * `permission.updated` / `permission.asked` → «🔐 Запрос разрешения» с тремя
   * инлайн-кнопками и маршрут `permissions[rid] → {sessionID, permissionID, …}`.
   *
   * Порядок (ТЗ п.4): enabled → дедуп по permissionID → rid → serverUrl из PluginInput →
   * format → send → record. Запись маршрута — только после успешной отправки (иначе
   * «осиротевшая» запись; при сбое recordPermission следующий event с тем же permissionID
   * пройдёт заново). Исключения пробрасываются наверх: их ловит event-hook и пишет
   * `event=permission.failed`, хук при этом всегда завершается resolve.
   */
  async function handlePermission(properties?: PermissionProperties): Promise<void> {
    if (!config.enabled) {
      logger.info("permission.skipped", { reason: "disabled" });
      return;
    }
    const permissionID = properties?.id ? String(properties.id) : "";
    const sessionID = properties?.sessionID ? String(properties.sessionID) : "";
    if (!permissionID || !sessionID) {
      logger.info("permission.skipped", { reason: "missing_fields" });
      return;
    }

    // Критическая зона под локом по permissionID: двойная регистрация плагина
    // вызывает event-hook параллельно — без лока оба проходят find и шлют сообщение.
    // Внутри — claimPermission: атомарный (под файловым локом) «маршрут уже есть
    // или отправка в полёте → duplicate» для межпроцессной гонки read-then-write.
    const permPendingKey = permissionPendingKey(permissionID);
    await withKeyLock(permPendingKey, async () => {
      const claim = await routes.claimPermission(permissionID);
      if (claim !== "claimed") {
        logger.info("permission.skipped", { session: sessionID, reason: "duplicate" });
        return;
      }
      try {
        const rid = generateRid();
        // directory — из session.directory (событие permission его не несёт)
        const sessionResult = await client.session.get({
          path: { id: sessionID },
          query: { directory },
        });
        if (!sessionResult || sessionResult.error || !sessionResult.data) {
          throw new Error("session.get failed");
        }
        const routeDirectory = ((sessionResult.data as ExtractedSession).directory || directory);

        // v1 (permission.updated): title/pattern строками.
        // v2 (permission.asked): permission/patterns/metadata.filepath.
        const meta = (properties?.metadata ?? {}) as Record<string, unknown>;
        const filepath = typeof meta.filepath === "string" ? meta.filepath : "";
        const permType =
          (typeof properties?.permission === "string" && properties.permission) ||
          (typeof properties?.type === "string" && properties.type) ||
          "";
        const patterns: string[] = Array.isArray(properties?.patterns)
          ? properties.patterns.filter((p): p is string => typeof p === "string")
          : typeof properties?.pattern === "string"
            ? [properties.pattern]
            : [];
        const title =
          (typeof properties?.title === "string" && properties.title) ||
          (filepath ? `${permType || "access"} → ${filepath}` : permType) ||
          "запрос разрешения";
        const pattern = patterns.join(", ");

        const text = formatPermission(
          { title, pattern, sessionShort: sessionID.slice(0, 8), rid },
          config,
        );

        // serverUrl — только из PluginInput процесса (deps.serverUrl), не из payload события
        const { messageId } = await sendTelegramMessage({
          token: config.token,
          chatId: config.chatId,
          text,
          replyMarkup: buildPermissionKeyboard(rid),
          timeoutMs: config.timeoutMs,
          retries: config.retries,
          fetchImpl: deps.fetchImpl,
        });

        await routes.recordPermission(rid, {
          sessionID,
          permissionID,
          serverUrl,
          directory: routeDirectory,
          messageId,
          createdAt: now(),
        });
        logger.info("permission.sent", {
          session: sessionID,
          message_id: messageId,
          rid,
          chars: text.length,
        });
      } finally {
        // pending снимается ВСЕГДА: после recordPermission (маршрут и так даёт
        // duplicate) и после ошибки — иначе retry навсегда заблокирован до TTL.
        try {
          await routes.clearPending(permPendingKey);
        } catch {
          /* снятие pending не должно маскировать основной результат */
        }
      }
    });
  }

  /**
   * `question.asked` / `question.v2.asked` → отправка только Q1
   * «❓ Вопрос агента · 1/N» с инлайн-кнопками вариантов и маршрут
   * `questions[rid] → {sessionID, requestID, questions, sequential:true, …}`.
   *
   * Порядок (ТЗ): enabled/notifyOnQuestion → дедуп по requestID (claimQuestion под
   * локом) → directory из session → нормализация questions → format Q1 → send → record.
   * В маршрут пишутся ВСЕ вопросы формы и `sequential:true`: Q2..QN отдельными
   * сообщениями отправляет мост, плагин правит только Q1 на settle.
   * Прямая отправка в процессе (как у permission, НЕ spawnNotify): маршрут должен
   * быть записан до того, как бридж сможет ответить на первое нажатие кнопки.
   * Вместе с маршрутом questions пишется messages[messageId] — после закрытия
   * вопроса текстовый reply на это сообщение уходит в prompt (фоллбэк бриджа).
   * Исключения пробрасываются наверх: их ловит event-hook → `question.failed`.
   */
  async function handleQuestion(properties?: QuestionProperties): Promise<void> {
    if (!config.enabled || !config.notifyOnQuestion) {
      logger.info("question.skipped", { reason: "disabled" });
      return;
    }
    const requestID = properties?.id ? String(properties.id) : "";
    const sessionID = properties?.sessionID ? String(properties.sessionID) : "";
    if (!requestID || !sessionID) {
      logger.info("question.skipped", { reason: "missing_fields" });
      return;
    }

    // критическая зона под локом по requestID: двойная регистрация плагина
    // запускает event-hook параллельно — без лока оба шлют сообщение
    const questionKey = questionPendingKey(requestID);
    await withKeyLock(questionKey, async () => {
      const claim = await routes.claimQuestion(requestID);
      if (claim !== "claimed") {
        logger.info("question.skipped", { session: sessionID, reason: "duplicate" });
        return;
      }
      try {
        // directory нужен бриджу для reply/prompt: приоритет — session.directory,
        // затем location из form.created, затем каталог плагина. Ошибка
        // session.get НЕ должна терять вопрос: процесс, выигравший claim, раньше
        // бросал исключение, остальные уже пропускали событие как duplicate —
        // уведомление исчезало целиком.
        let routeDirectory =
          typeof properties?.location?.directory === "string" &&
          properties.location.directory.trim()
            ? properties.location.directory
            : directory;
        try {
          const sessionResult = await client.session.get({
            path: { id: sessionID },
            query: { directory },
          });
          if (!sessionResult || sessionResult.error || !sessionResult.data) {
            logger.warn("question.session_lookup_failed", { session: sessionID });
          } else {
            routeDirectory =
              (sessionResult.data as ExtractedSession).directory || routeDirectory;
          }
        } catch (error) {
          logger.warn("question.session_lookup_failed", {
            session: sessionID,
            reason: error instanceof Error ? error.name : "unknown",
          });
        }

        const questions = normalizeQuestions(properties?.questions);
        if (questions.length === 0) {
          logger.info("question.skipped", { session: sessionID, reason: "invalid_questions" });
          return;
        }

        const rid = generateRid();
        // sequential: плагин шлёт только Q1, остальные вопросы отправит мост
        const text = formatQuestionPage({
          sessionShort: sessionID.slice(0, 8),
          question: questions[0],
          index: 0,
          total: questions.length,
        });

        // serverUrl — только из PluginInput процесса (deps.serverUrl), не из payload события
        const { messageId } = await sendTelegramMessage({
          token: config.token,
          chatId: config.chatId,
          text,
          replyMarkup: buildQuestionPageKeyboard(rid, questions[0], 0),
          timeoutMs: config.timeoutMs,
          retries: config.retries,
          fetchImpl: deps.fetchImpl,
        });

        await routes.recordQuestion(rid, {
          sessionID,
          requestID,
          serverUrl,
          directory: routeDirectory,
          messageId,
          questions,
          sequential: true,
          // raw Form.Field[] (v2) — без них бридж не соберёт {answer:{…}}
          fields: properties?.fields,
          // для одиночного вопроса — прямой индекс поля формы (см. QuestionRoute.fieldIndex)
          ...(questions.length === 1 && questions[0].fieldIndex !== undefined
            ? { fieldIndex: questions[0].fieldIndex }
            : {}),
          createdAt: now(),
        });
        await routes.recordMessage(messageId, {
          sessionID,
          serverUrl,
          directory: routeDirectory,
          sentAt: now(),
        });
        logger.info("question.sent", {
          session: sessionID,
          message_id: messageId,
          rid,
          sequential: true,
          questions_count: questions.length,
          chars: text.length,
        });
      } finally {
        // pending снимается ВСЕГДА: после recordQuestion (маршрут и так даёт
        // duplicate) и после ошибки — иначе retry навсегда заблокирован до TTL.
        try {
          await routes.clearQuestionPending(questionKey);
        } catch {
          /* снятие pending не должно маскировать основной результат */
        }
      }
    });
  }

  /**
   * `question.replied` / `question.rejected` (и v2) → правка TG-сообщения
   * итогом вопроса + удаление маршрута. Для sequential-маршрута плагин правит
   * ТОЛЬКО Q1 (`route.messageId`), Q2..QN закрывает мост; в тексте — ответ qi=0.
   * Для legacy-маршрута поведение прежнее (все ответы). Маршрут забирается
   * атомарно (takeQuestionByRequestID): только один процесс правит сообщение,
   * остальные получают `question.settled handled=false` без лишних API-вызовов.
   * Ошибка editMessageText логируется как question.failed, но маршрут уже
   * удалён — повторного settle не будет.
   */
  async function handleQuestionSettled(
    properties?: QuestionSettledProperties,
    action?: QuestionSettleAction,
  ): Promise<void> {
    const requestID = properties?.requestID ? String(properties.requestID) : "";
    const settled: QuestionSettleAction =
      action ??
      (Array.isArray(properties?.answers) || properties?.answer !== undefined
        ? "replied"
        : "rejected");

    // Атомарное «забрать и удалить»: из десятков подписчиков form.replied
    // сообщение правит только один, остальные видят handled=false.
    const found = requestID ? await routes.takeQuestionByRequestID(requestID) : undefined;
    if (!found) {
      logger.info("question.settled", {
        action: settled,
        handled: false,
        session: properties?.sessionID,
      });
      return;
    }
    const { rid, route } = found;

    // v2 присылает `{answer:{key:value}}` — превращаем в метки по сохранённым
    // raw-полям формы; v1 шлёт сразу `answers: string[][]`.
    // sequential: плагин правит только Q1, поэтому берём ответ первого вопроса.
    const displayAnswers =
      route.sequential === true
        ? sequentialFirstAnswer(route, properties)
        : Array.isArray(properties?.answers)
          ? properties.answers
          : (labelsFromAnswer(route.fields, properties?.answer) ?? []);

    try {
      await editTelegramMessage({
        token: config.token,
        chatId: config.chatId,
        messageId: route.messageId,
        text: formatQuestionSettledText(settled, displayAnswers),
        timeoutMs: config.timeoutMs,
        retries: config.retries,
        fetchImpl: deps.fetchImpl,
      });
    } catch (error) {
      logger.error("question.failed", error, { rid, session: route.sessionID });
    }

    logger.info("question.settled", {
      action: settled,
      handled: true,
      session: route.sessionID,
      rid,
      sequential: route.sequential === true,
    });
  }

  /**
   * `session.created` → «🆕 Новая сессия» + маршрут messages[messageId].
   * Только корневые сессии (без parentID) — child/subagent не уведомляем.
   * Дедуп: один claim на sessionID (повторный вызов хука → skipped).
   * Отправка через отсоединённый процесс (бюджет event-хука ≈200–300 мс).
   */
  async function handleSessionCreated(info?: SessionCreatedInfo): Promise<void> {
    if (!config.enabled || !config.notifyOnSessionCreate) {
      logger.info("session_create.skipped", { reason: "disabled" });
      return;
    }
    const sessionID = info?.id ? String(info.id) : "";
    if (!sessionID) {
      logger.info("session_create.skipped", { reason: "missing_id" });
      return;
    }
    if (info?.parentID) {
      logger.info("session_create.skipped", { session: sessionID, reason: "child_session" });
      return;
    }

    const dedupKey = `session.created:${sessionID}`;
    const directory = (typeof info?.directory === "string" && info.directory) || deps.directory;
    const title = typeof info?.title === "string" ? info.title : "";
    const text = formatSessionCreated(
      {
        sessionShort: sessionID.slice(0, 8),
        project: projectFromDirectory(directory),
        title,
      },
      config,
    );

    await withKeyLock(dedupKey, async () => {
      const claim = await routes.claimPending(dedupKey);
      if (claim !== "claimed") {
        logger.info("session_create.skipped", { session: sessionID, reason: claim });
        return;
      }
      const payload: NotifyPayload = {
        text,
        sessionID,
        serverUrl,
        directory,
        dedupKey,
        status: "created",
        durationMs: 0,
        chars: text.length,
        configDir: config.configDir,
      };
      try {
        const outcome = await notify(payload);
        logger.info("session_create.queued", {
          session: sessionID,
          chars: text.length,
          pid: outcome && typeof outcome === "object" ? outcome.pid : undefined,
        });
      } catch (error) {
        await routes.clearPending(dedupKey);
        throw error;
      }
    });
  }

  return { handleIdle, handlePermission, handleSessionCreated, handleQuestion, handleQuestionSettled };
}

export type EventHookDeps = {
  bridge: {
    handleIdle(sessionID: string): Promise<void>;
    /** опционально: обработчик permission.updated / permission.asked */
    handlePermission?(properties?: PermissionProperties): Promise<void>;
    /** опционально: обработчик session.created */
    handleSessionCreated?(info?: SessionCreatedInfo): Promise<void>;
    /** опционально: обработчик question.asked */
    handleQuestion?(properties?: QuestionProperties): Promise<void>;
    /** опционально: обработчик question.replied / question.rejected */
    handleQuestionSettled?(
      properties?: QuestionSettledProperties,
      action?: QuestionSettleAction,
    ): Promise<void>;
  };
  logger: Logger;
};

type BridgeEvent = {
  type?: string;
  properties?: Record<string, unknown> & { sessionID?: string };
  /** v2-события opencode приходят с полем data вместо properties */
  data?: Record<string, unknown> & { sessionID?: string };
};

/**
 * Event-hook плагина: `session.idle`, `permission.updated`/`permission.asked`,
 * `session.created`, `question.asked`/`question.replied`/`question.rejected`
 * (и v2-варианты с полем data). Всегда завершается resolve — никогда не роняет opencode.
 */
export function createEventHooks(deps: EventHookDeps): {
  event: (input: { event: BridgeEvent }) => Promise<void>;
} {
  return {
    async event(input) {
      const event = input?.event;
      if (!event) return;

      if (event.type === "session.idle") {
        const sessionID = event.properties?.sessionID;
        // синхронная точка на входе: фиксирует факт события даже если процесс
        // opencode завершится до завершения асинхронной работы хука
        deps.logger.info("idle.received", { session: sessionID });
        if (!sessionID) return;
        try {
          await deps.bridge.handleIdle(sessionID);
        } catch (error) {
          deps.logger.error("idle.failed", error, { session: sessionID });
        }
        return;
      }

      if (event.type === "permission.updated" || event.type === "permission.asked") {
        deps.logger.info("permission.received", {
          etype: event.type,
          session: (event.properties as PermissionProperties | undefined)?.sessionID,
        });
        try {
          await deps.bridge.handlePermission?.(event.properties as PermissionProperties);
        } catch (error) {
          deps.logger.error("permission.failed", error, {});
        }
        return;
      }

      if (event.type === "session.created") {
        const info = (event.properties as { info?: SessionCreatedInfo } | undefined)?.info;
        deps.logger.info("session_create.received", { session: info?.id });
        try {
          await deps.bridge.handleSessionCreated?.(info);
        } catch (error) {
          deps.logger.error("session_create.failed", error, { session: info?.id });
        }
        return;
      }

      const asked =
        event.type === "question.asked" || event.type === "question.v2.asked";
      const settled =
        event.type === "question.replied" ||
        event.type === "question.v2.replied" ||
        event.type === "question.rejected" ||
        event.type === "question.v2.rejected";
      if (asked || settled) {
        // v1 приходит в properties, v2 — в data (см. BridgeEvent)
        const properties = (event.properties ?? event.data) as
          | (QuestionProperties & QuestionSettledProperties)
          | undefined;
        deps.logger.info("question.received", {
          etype: event.type,
          session: properties?.sessionID,
        });
        try {
          if (asked) {
            await deps.bridge.handleQuestion?.(properties);
          } else {
            const action: QuestionSettleAction = event.type?.endsWith("rejected")
              ? "rejected"
              : "replied";
            await deps.bridge.handleQuestionSettled?.(properties, action);
          }
        } catch (error) {
          deps.logger.error("question.failed", error, {});
        }
      }
    },
  };
}
