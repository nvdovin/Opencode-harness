// extract.ts — извлечение данных из сессии (задача, итог, статус, длительность).
// Не содержит секретов и не выполняет сетевых вызовов.

export type MessageRole = "user" | "assistant";

export type ExtractedPart = {
  type?: string;
  text?: string;
  synthetic?: boolean;
};

export type ExtractedMessage = {
  info: {
    id: string;
    role: MessageRole | string;
    parentID?: string;
    time?: { created?: number; completed?: number };
    providerID?: string;
    modelID?: string;
    error?: { name?: string; data?: { message?: string } } | null;
  };
  parts?: ExtractedPart[];
};

export type ExtractedSession = {
  id?: string;
  parentID?: string;
  directory?: string;
  time?: { created?: number };
};

export type ExtractionStatus = "success" | "error" | "abort" | "question";

export type Extraction = {
  isRoot: boolean;
  task: string;
  result: string;
  status: ExtractionStatus;
  durationMs: number;
  serverUrl: string;
  errorMessage: string;
  /** id последнего assistant-сообщения — часть ключа дедупликации. */
  assistantMessageID: string;
  /** `providerID/modelID` последнего assistant-сообщения. */
  model: string;
};

function timeOf(message: ExtractedMessage): number {
  const completed = message.info.time?.completed;
  if (typeof completed === "number" && Number.isFinite(completed)) return completed;
  const created = message.info.time?.created;
  return typeof created === "number" && Number.isFinite(created) ? created : 0;
}

/** assistant-сообщение с максимальным time.completed (fallback time.created). */
export function selectLatestAssistant(messages: ExtractedMessage[]): ExtractedMessage | undefined {
  let best: ExtractedMessage | undefined;
  let bestTime = -Infinity;
  for (const message of messages ?? []) {
    if (message?.info?.role !== "assistant") continue;
    const t = timeOf(message);
    if (t > bestTime) {
      bestTime = t;
      best = message;
    }
  }
  return best;
}

/** Нормализация пробелов: склейка + схлопывание повторов. */
export function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/** Склейка только text-part'ов без флага synthetic. */
function joinTextParts(parts: ExtractedPart[] | undefined): string {
  const chunks: string[] = [];
  for (const part of parts ?? []) {
    if (part?.type !== "text") continue;
    if (part.synthetic) continue;
    if (typeof part.text !== "string") continue;
    const text = normalizeText(part.text);
    if (text) chunks.push(text);
  }
  return normalizeText(chunks.join(" "));
}

/** Первое user-сообщение (не последнее!), склейка только text-частей. */
export function selectFirstUserText(messages: ExtractedMessage[]): string {
  for (const message of messages ?? []) {
    if (message?.info?.role !== "user") continue;
    return joinTextParts(message.parts);
  }
  return "";
}

function statusOf(assistant: ExtractedMessage | undefined): ExtractionStatus {
  const error = assistant?.info?.error;
  if (!error) return "success";
  if (error.name === "MessageAbortedError") return "abort";
  return "error";
}

/**
 * Детект текстового вопроса ассистента: вопросом считается только хвост текста.
 *
 * Ложные срабатывания старого правила «содержит ?» (любой `?` в URL/коде/середине
 * текста → баннер ❓) отсекаются: `?` должен стоять в хвосте trimmed-текста —
 * в последних {@link QUESTION_TAIL_CHARS} символах ИЛИ в последнем «предложении/абзаце»
 * (фрагмент после последнего перевода строки либо после последнего `. ` / `! ` / `; `).
 *
 * Живой E2E-формат (критерий 5) — «вопрос? QUESTION_NOTIFIED»: маркер идёт сразу
 * после вопроса, поэтому `?` попадает и в последние 80 символов, и в хвостовой
 * фрагмент — детект сохраняется. Строгий `endsWith('?')` на этом формате не срабатывал бы.
 */
const QUESTION_TAIL_CHARS = 80;

function questionTailFragment(text: string): string {
  let idx = -1;
  let sepLen = 0;
  for (const sep of [". ", "! ", "; ", "\n"]) {
    const i = text.lastIndexOf(sep);
    if (i > idx) {
      idx = i;
      sepLen = sep.length;
    }
  }
  return idx >= 0 ? text.slice(idx + sepLen) : text;
}

export function isQuestionText(text: unknown): boolean {
  const trimmed = typeof text === "string" ? text.trim() : "";
  if (!trimmed) return false;
  if (/[?？]/.test(trimmed.slice(-QUESTION_TAIL_CHARS))) return true;
  return /[?？]/.test(questionTailFragment(trimmed));
}

function durationOf(
  session: ExtractedSession,
  assistant: ExtractedMessage | undefined,
  messages: ExtractedMessage[],
  now: number,
): number {
  const completed = assistant?.info.time?.completed;
  const end = typeof completed === "number" && Number.isFinite(completed) ? completed : now;
  let start: number | undefined;
  const parentID = assistant?.info.parentID;
  if (parentID) {
    const parent = messages.find((m) => m?.info?.id === parentID && m?.info?.role === "user");
    const created = parent?.info.time?.created;
    if (typeof created === "number" && Number.isFinite(created)) start = created;
  }
  if (start === undefined) {
    const sessionCreated = session?.time?.created;
    if (typeof sessionCreated === "number" && Number.isFinite(sessionCreated)) start = sessionCreated;
  }
  if (start === undefined) start = 0;
  return Math.max(0, end - start);
}

/**
 * buildExtraction(session, messages, serverUrl, now) →
 * { isRoot, task, result, status, durationMs, serverUrl, errorMessage, ... }
 */
export function buildExtraction(
  session: ExtractedSession,
  messages: ExtractedMessage[],
  serverUrl: string,
  now: number,
): Extraction {
  const list = messages ?? [];
  const assistant = selectLatestAssistant(list);
  const baseStatus = statusOf(assistant);
  const result = joinTextParts(assistant?.parts);
  // приоритеты: abort/error важнее вопроса — вопрос детектируется только при success
  const status: ExtractionStatus =
    baseStatus === "success" && isQuestionText(result) ? "question" : baseStatus;
  const errorMessage = assistant?.info?.error?.data?.message ?? "";
  return {
    isRoot: !session?.parentID,
    task: selectFirstUserText(list),
    result,
    status,
    durationMs: durationOf(session, assistant, list, now),
    serverUrl,
    errorMessage,
    assistantMessageID: assistant?.info?.id ?? "",
    model:
      assistant?.info.providerID && assistant.info.modelID
        ? `${assistant.info.providerID}/${assistant.info.modelID}`
        : "",
  };
}
