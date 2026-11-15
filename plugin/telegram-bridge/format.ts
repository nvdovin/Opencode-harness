// format.ts — HTML-формат уведомления для Telegram (parse_mode=HTML).
// Статусы: success/error/abort (спринт 2) + question (спринт 3),
// плюс формат permission-уведомления с инлайн-кнопками.
import type { BridgeConfig } from "./config.ts";

export type DoneStatus = "success" | "error" | "abort" | "question";

export type DoneInput = {
  status: DoneStatus;
  task: string;
  result: string;
  project?: string;
  model?: string;
  durationMs?: number;
  errorMessage?: string;
};

/** Жёсткий потолок текста уведомления (лимит Telegram 4096 с запасом). */
export const MAX_MESSAGE_CHARS = 3900;

const BANNERS: Record<DoneStatus, string> = {
  success: "✅ <b>Задача выполнена</b>",
  error: "⚠️ <b>Задача завершилась с ошибкой</b>",
  abort: "⛔ <b>Запрос прерван</b>",
  question: "❓ <b>Ассистент ждёт ответа</b>",
};

const FALLBACKS: Record<DoneStatus, string> = {
  success: "Ассистент не вернул текстовый итог.",
  error: "Ошибка без текстового описания.",
  abort: "Запрос был прерван до завершения.",
  question: "Ассистент не вернул текст вопроса.",
};

/** Подсказка для статуса question: ответ продолжает сессию через reply. */
export const QUESTION_HINT =
  "<i>Ответьте на это сообщение (reply), чтобы продолжить сессию.</i>";

/** Экранирование `&`, `<`, `>` для parse_mode=HTML. */
export function htmlEscape(value: unknown): string {
  const text = typeof value === "string" ? value : value === undefined || value === null ? "" : String(value);
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Markdown → Telegram HTML. Порядок: сначала htmlEscape (нельзя впускать
 * чужие теги), затем остались только `* _ ` ~ [ ] ( ) — их конвертируем.
 * Незакрытые маркеры (обрезка truncate) остаются как есть — не ломают разметку.
 */
export function mdToHtml(text: string): string {
  let s = htmlEscape(text);
  // fenced code ```lang\n...\n``` → <pre><code>
  s = s.replace(/```[^\n]*\n([\s\S]*?)```/g, (_m, code: string) => `<pre>${code.replace(/\n$/, "")}</pre>`);
  s = s.replace(/```([\s\S]*?)```/g, (_m, code: string) => `<pre>${code}</pre>`);
  // inline code `...`
  s = s.replace(/`([^`\n]+)`/g, "<code>$1</code>");
  // bold **...** / __...__
  s = s.replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>");
  s = s.replace(/__([^_\n]+)__/g, "<b>$1</b>");
  // italic *...* / _..._ (underscore — только с границами слова)
  s = s.replace(/\*([^*\n]+)\*/g, "<i>$1</i>");
  s = s.replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,!?;:]|$)/g, "$1<i>$2</i>");
  // strikethrough ~~...~~
  s = s.replace(/~~([^~\n]+)~~/g, "<s>$1</s>");
  // links [text](http...) — только http(s), иначе Telegram отклонит
  s = s.replace(/\[([^\]\n]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2">$1</a>');
  return s;
}

/**
 * Обрезка по границе слова с добавлением `…`; не рвёт surrogate-пары,
 * длина результата (в код-поинтах) не превышает maxChars.
 */
export function truncate(value: unknown, maxChars: number): string {
  const text = typeof value === "string" ? value : "";
  if (!Number.isFinite(maxChars) || maxChars <= 0) return "";
  const chars = Array.from(text);
  if (chars.length <= maxChars) return text;
  const limit = maxChars - 1; // место под «…»
  let cut = limit;
  for (let i = limit - 1; i >= 0; i--) {
    if (/\s/.test(chars[i] ?? "")) {
      cut = i;
      break;
    }
  }
  return chars.slice(0, cut).join("").trimEnd() + "…";
}

/** Человекочитаемая длительность. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${Math.round(ms)} мс`;
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds} с`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes} мин ${seconds} с`;
}

/** `project = basename(session.directory)`. */
export function projectFromDirectory(directory: string | undefined): string {
  if (!directory) return "";
  const parts = directory.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || directory;
}

/** Формирование HTML-строки уведомления (≤3900 символов, теги не рвутся). */
export function formatDone(input: DoneInput, config: BridgeConfig): string {
  const status: DoneStatus = input.status in BANNERS ? input.status : "success";
  const banner = BANNERS[status];
  const rawTask = typeof input.task === "string" ? input.task : "";
  const rawResult = typeof input.result === "string" ? input.result : "";
  const fallback =
    status === "error" && input.errorMessage ? input.errorMessage : FALLBACKS[status];
  const resultSource = rawResult.trim() ? rawResult : fallback;

  const metaPieces: string[] = [];
  if (config.includeProject && input.project) {
    metaPieces.push(`<i>Проект:</i> <code>${htmlEscape(input.project)}</code>`);
  }
  if (config.includeModel && input.model) {
    metaPieces.push(`<i>Модель:</i> ${htmlEscape(input.model)}`);
  }
  if (config.includeDuration && typeof input.durationMs === "number") {
    metaPieces.push(`<i>Время:</i> ${htmlEscape(formatDuration(input.durationMs))}`);
  }
  const metaLine = metaPieces.length ? metaPieces.join(" · ") : "";

  const build = (taskBudget: number, resultBudget: number): string => {
    const taskText = truncate(rawTask, taskBudget);
    const resultText = truncate(resultSource, resultBudget);
    // у вопроса блок называется «Вопрос:», а не «Итог:»
    const resultLabel = status === "question" ? "<b>Вопрос:</b>" : "<b>Итог:</b>";
    const lines = [
      banner,
      `<b>Задача:</b> ${taskText ? mdToHtml(taskText) : "—"}`,
      `${resultLabel} ${mdToHtml(resultText)}`,
    ];
    if (metaLine) lines.push(metaLine);
    if (status === "question") lines.push(QUESTION_HINT);
    return lines.join("\n");
  };

  let taskBudget = config.maxTaskChars;
  let resultBudget = config.maxResultChars;
  let html = build(taskBudget, resultBudget);
  let guard = 0;
  while (html.length > MAX_MESSAGE_CHARS && guard < 60) {
    guard += 1;
    const over = html.length - MAX_MESSAGE_CHARS;
    if (resultBudget > 16) {
      resultBudget = Math.max(12, resultBudget - over - 4);
      html = build(taskBudget, resultBudget);
      continue;
    }
    if (taskBudget > 16) {
      taskBudget = Math.max(12, taskBudget - over - 4);
      html = build(taskBudget, resultBudget);
      continue;
    }
    break;
  }
  if (html.length > MAX_MESSAGE_CHARS) {
    html = build(12, 12);
  }
  return html;
}

// --- спринт 3: permission-уведомление ---

export type PermissionInput = {
  title?: string;
  pattern?: string;
  /** первые 8 символов sessionID */
  sessionShort?: string;
  /** rid используется для callback_data (см. buildPermissionKeyboard), в текст не выводится */
  rid?: string;
};

export type PermissionAction = "once" | "always" | "reject";

export type InlineKeyboardButton = { text: string; callback_data: string };
export type InlineKeyboard = { inline_keyboard: InlineKeyboardButton[][] };

const PERMISSION_BUTTONS: ReadonlyArray<{ action: PermissionAction; text: string }> = [
  { action: "once", text: "✅ Разрешить" },
  { action: "always", text: "🔁 Всегда" },
  { action: "reject", text: "❌ Отклонить" },
];

/**
 * Ровно одна строка из трёх кнопок.
 * `callback_data` = `perm:` + rid(12) + `:` + action(4..6) = 21..23 байт ≤ 64 (лимит Telegram).
 * Это JSON, а не HTML — экранирование не применяется.
 */
export function buildPermissionKeyboard(rid: string): InlineKeyboard {
  return {
    inline_keyboard: [
      PERMISSION_BUTTONS.map(({ action, text }) => ({
        text,
        callback_data: `perm:${rid}:${action}`,
      })),
    ],
  };
}

/**
 * HTML-текст permission-уведомления (≤3900 символов, title/pattern через htmlEscape).
 * `config` входит в сигнатуру по ТЗ (единый формат с formatDone); полей конфига здесь нет.
 */
export function formatPermission(input: PermissionInput, config: BridgeConfig): string {
  const build = (titleBudget: number, patternBudget: number): string => {
    const title = truncate(input.title ?? "", titleBudget).trim();
    const pattern = truncate(input.pattern ?? "", patternBudget).trim();
    const sessionShort = truncate(input.sessionShort ?? "", 64);
    const lines = [
      "<b>🔐 Запрос разрешения</b>",
      `<b>Сессия:</b> <code>${htmlEscape(sessionShort) || "—"}</code>`,
      `<b>Действие:</b> ${htmlEscape(title) || "—"}`,
    ];
    if (pattern) lines.push(`<b>Паттерн:</b> ${htmlEscape(pattern)}`);
    return lines.join("\n");
  };

  let titleBudget = 600;
  let patternBudget = 600;
  let html = build(titleBudget, patternBudget);
  let guard = 0;
  while (html.length > MAX_MESSAGE_CHARS && guard < 60) {
    guard += 1;
    const over = html.length - MAX_MESSAGE_CHARS;
    if (patternBudget > 16) {
      patternBudget = Math.max(12, patternBudget - over - 4);
      html = build(titleBudget, patternBudget);
      continue;
    }
    if (titleBudget > 16) {
      titleBudget = Math.max(12, titleBudget - over - 4);
      html = build(titleBudget, patternBudget);
      continue;
    }
    break;
  }
  if (html.length > MAX_MESSAGE_CHARS) {
    html = build(12, 12);
  }
  return html;
}

// --- session.created: уведомление о новой сессии ---

export type SessionCreatedInput = {
  /** первые 8 символов sessionID */
  sessionShort?: string;
  project?: string;
  title?: string;
};

/**
 * HTML-текст «новая сессия создана» (≤3900). Reply на это сообщение
 * доставляет текст в сессию — маршрут записывает доставка уведомления.
 */
export function formatSessionCreated(input: SessionCreatedInput, config: BridgeConfig): string {
  const sessionShort = truncate(input.sessionShort ?? "", 64).trim();
  const title = truncate(input.title ?? "", 200).trim();
  const lines = [
    "🆕 <b>Новая сессия</b>",
    `<b>Сессия:</b> <code>${htmlEscape(sessionShort) || "—"}</code>`,
  ];
  if (config.includeProject && input.project) {
    lines.push(`<i>Проект:</i> <code>${htmlEscape(input.project)}</code>`);
  }
  if (title) lines.push(`<b>Название:</b> ${mdToHtml(title)}`);
  lines.push("<i>Ответьте на это сообщение, чтобы продолжить сессию.</i>");
  return lines.join("\n");
}

// --- инструмент question: HTML-текст вопроса + инлайн-кнопки вариантов ---

/** Один вариант вопроса (label/description необязательны — payload опрашивается). */
export type QuestionOptionInput = {
  label?: string;
  description?: string;
};

export type QuestionInput = {
  question?: string;
  header?: string;
  options?: QuestionOptionInput[];
  multiple?: boolean;
  custom?: boolean;
};

export type QuestionFormatInput = {
  /** первые 8 символов sessionID */
  sessionShort?: string;
  questions: QuestionInput[];
};

/** Сколько вариантов одного вопроса печатается в тексте (остальное — «и ещё N»). */
export const QUESTION_MAX_OPTIONS = 10;

/** Обрезка текста кнопки-варианта (60 символов, лимит Telegram на кнопку безопасно шире). */
export const QUESTION_BUTTON_LABEL_CHARS = 60;

/** Текст кнопки свободного ответа: callback_data `q:<rid>:<qi>:custom` (≤24 байт ≤ 64). */
export const QUESTION_CUSTOM_BUTTON = "✍️ Свой ответ";

/**
 * Подсказка для вопроса С вариантами: кнопка, кнопка ✍️ «Свой ответ» и текстовый
 * reply — всё разрешено, подсказка не врёт о доступных способах.
 */
export const QUESTION_OPTIONS_TAIL =
  `<i>Ответьте кнопкой, нажмите ✍️ «Свой ответ» или напишите текст (reply на это сообщение).</i>`;

/**
 * Подсказка для custom-вопроса (без вариантов): кнопок нет → только текст.
 * Используется и запасной строкой, когда тело сообщения вырезано по лимиту 3900.
 */
export const QUESTION_TAIL = "<i>Напишите ответ текстом (reply на это сообщение).</i>";

/**
 * Адаптивная подсказка одного вопроса: `custom: true` ИЛИ отсутствие вариантов →
 * только текстовый ответ; обычный вопрос с вариантами → кнопка/✍️/текст.
 * Флаг `custom` реально читается в рендере (раньше хвост был общий и врал для
 * вопросов без вариантов). Для гипотетического `custom: true` при наличии
 * вариантов (v1-события) подсказка ведёт на текст — кнопки вариантов остаются.
 */
export function questionHint(item: QuestionInput | undefined): string {
  const options = Array.isArray(item?.options) ? item.options : [];
  const custom = item?.custom === true || options.length === 0;
  return custom ? QUESTION_TAIL : QUESTION_OPTIONS_TAIL;
}

/** Вход рендера одного вопроса последовательной формы (Q1 плагина, Q2..QN — мост). */
export type QuestionPageInput = {
  /** первые 8 символов sessionID */
  sessionShort?: string;
  question: QuestionInput;
  /** 0-based индекс вопроса в форме */
  index: number;
  /** всего вопросов в форме */
  total: number;
};

/**
 * HTML-текст ОДНОГО вопроса формы (≤3900): `❓ Вопрос агента · i/N`,
 * сессия, необязательный header, сам вопрос, до 10 вариантов
 * `<i>n. label — description</i>` и адаптивная подсказка (questionHint).
 * Заголовок всегда с `i/N` (в т.ч. `1/1`) — единообразно для плагина и моста.
 * `index` клампится в `[0, total-1]`; битые `total`/`index` → `1/1` и `0`.
 */
export function formatQuestionPage(input: QuestionPageInput): string {
  const rawTotal = typeof input?.total === "number" && Number.isFinite(input.total) ? input.total : 1;
  const total = rawTotal > 0 ? Math.floor(rawTotal) : 1;
  const rawIndex =
    typeof input?.index === "number" && Number.isFinite(input.index) && input.index >= 0
      ? Math.floor(input.index)
      : 0;
  const index = Math.min(rawIndex, total - 1);
  const sessionShort = truncate(input?.sessionShort ?? "", 64).trim();
  const item: QuestionInput = input?.question ?? {};
  const options = Array.isArray(item.options) ? item.options : [];

  const head = [
    `❓ <b>Вопрос агента · ${index + 1}/${total}</b>`,
    `<b>Сессия:</b> <code>${htmlEscape(sessionShort) || "—"}</code>`,
  ];

  const buildBody = (questionBudget: number, optionBudget: number): string[] => {
    const lines: string[] = [];
    const header = truncate(item.header ?? "", questionBudget).trim();
    if (header) lines.push(`<i>${htmlEscape(header)}</i>`);
    const title = truncate(item.question ?? "", questionBudget).trim();
    lines.push(`<b>${htmlEscape(title) || "—"}</b>`);
    options.forEach((option, optionIndex) => {
      if (optionIndex >= QUESTION_MAX_OPTIONS) return;
      const label = truncate(option?.label ?? "", optionBudget).trim();
      if (!label) return;
      const description = truncate(option?.description ?? "", optionBudget).trim();
      const number = `${optionIndex + 1}.`;
      lines.push(
        description
          ? `<i>${number} ${htmlEscape(label)} — ${htmlEscape(description)}</i>`
          : `<i>${number} ${htmlEscape(label)}</i>`,
      );
    });
    if (options.length > QUESTION_MAX_OPTIONS) {
      lines.push(
        `…и ещё ${options.length - QUESTION_MAX_OPTIONS} вариантов — ответьте текстом (reply)`,
      );
    }
    lines.push(questionHint(item));
    return lines;
  };

  const join = (lines: string[]): string => [...head, ...lines].join("\n");
  let questionBudget = 800;
  let optionBudget = 240;
  let body = buildBody(questionBudget, optionBudget);
  let html = join(body);
  let guard = 0;
  while (html.length > MAX_MESSAGE_CHARS && guard < 60) {
    guard += 1;
    const over = html.length - MAX_MESSAGE_CHARS;
    if (optionBudget > 16) {
      optionBudget = Math.max(12, optionBudget - over - 4);
      body = buildBody(questionBudget, optionBudget);
      html = join(body);
      continue;
    }
    if (questionBudget > 16) {
      questionBudget = Math.max(12, questionBudget - over - 4);
      body = buildBody(questionBudget, optionBudget);
      html = join(body);
      continue;
    }
    break;
  }

  // страховка: слишком много строк → отрезаем с конца и оставляем маркер с reply-подсказкой
  let dropped = 0;
  while (html.length > MAX_MESSAGE_CHARS && body.length > 0) {
    body = body.slice(0, -1);
    dropped += 1;
    const marker = `…и ещё ${dropped} пунктов — ответьте текстом (reply)`;
    html = join([...body, marker]);
  }
  if (html.length > MAX_MESSAGE_CHARS) {
    html = join([QUESTION_TAIL]);
  }
  return html;
}

/**
 * HTML-текст вопроса агента (≤3900): заголовок ❓, сессия, вопросы
 * (нумерация `1.` только при >1 вопроса) и варианты `<i>n. label — description</i>`
 * с htmlEscape; больше 10 вариантов → первые 10 + строка «…и ещё N … (reply)».
 * После каждого вопроса — его адаптивная подсказка (questionHint).
 * `config` входит в сигнатуру по ТЗ (единый формат с formatDone/formatPermission);
 * полей конфига здесь нет.
 */
export function formatQuestion(input: QuestionFormatInput, config: BridgeConfig): string {
  const sessionShort = truncate(input.sessionShort ?? "", 64).trim();
  const questions = Array.isArray(input.questions) ? input.questions : [];
  const numbered = questions.length > 1;
  const head = [
    "❓ <b>Вопрос агента</b>",
    `<b>Сессия:</b> <code>${htmlEscape(sessionShort) || "—"}</code>`,
  ];

  const buildBody = (questionBudget: number, optionBudget: number): string[] => {
    const lines: string[] = [];
    questions.forEach((item, index) => {
      const title = truncate(item?.question ?? "", questionBudget).trim();
      const prefix = numbered ? `${index + 1}. ` : "";
      lines.push(`<b>${prefix}${htmlEscape(title) || "—"}</b>`);
      const options = Array.isArray(item?.options) ? item.options : [];
      options.forEach((option, optionIndex) => {
        if (optionIndex >= QUESTION_MAX_OPTIONS) return;
        const label = truncate(option?.label ?? "", optionBudget).trim();
        if (!label) return;
        const description = truncate(option?.description ?? "", optionBudget).trim();
        const number = `${optionIndex + 1}.`;
        lines.push(
          description
            ? `<i>${number} ${htmlEscape(label)} — ${htmlEscape(description)}</i>`
            : `<i>${number} ${htmlEscape(label)}</i>`,
        );
      });
      if (options.length > QUESTION_MAX_OPTIONS) {
        lines.push(
          `…и ещё ${options.length - QUESTION_MAX_OPTIONS} вариантов — ответьте текстом (reply)`,
        );
      }
      // подсказка — после каждого вопроса, адаптивно (см. questionHint)
      lines.push(questionHint(item));
    });
    return lines;
  };

  // 1) сжимаем поля (вопрос/вариант), пока весь текст не влезет в 3900
  let questionBudget = 800;
  let optionBudget = 240;
  let body = buildBody(questionBudget, optionBudget);
  const join = (lines: string[]): string => [...head, ...lines].join("\n");
  let html = join(body);
  let guard = 0;
  while (html.length > MAX_MESSAGE_CHARS && guard < 60) {
    guard += 1;
    const over = html.length - MAX_MESSAGE_CHARS;
    if (optionBudget > 16) {
      optionBudget = Math.max(12, optionBudget - over - 4);
      body = buildBody(questionBudget, optionBudget);
      html = join(body);
      continue;
    }
    if (questionBudget > 16) {
      questionBudget = Math.max(12, questionBudget - over - 4);
      body = buildBody(questionBudget, optionBudget);
      html = join(body);
      continue;
    }
    break;
  }

  // 2) страховка: слишком много строк → отрезаем с конца и оставляем маркер с reply-подсказкой
  let dropped = 0;
  while (html.length > MAX_MESSAGE_CHARS && body.length > 0) {
    body = body.slice(0, -1);
    dropped += 1;
    const marker = `…и ещё ${dropped} пунктов — ответьте текстом (reply)`;
    html = [...head, ...body, marker].join("\n");
  }
  if (html.length > MAX_MESSAGE_CHARS) {
    // тело вырезано целиком → одна нейтральная подсказка (честна для любого вопроса)
    html = join([QUESTION_TAIL]);
  }
  return html;
}

/**
 * Инлайн-кнопки вопроса. Каждый вариант — отдельная строка, текст = label
 * (обрезка до 60 символов), callback_data `q:<rid>:<qi>:<oi>` (0-based).
 * Для каждого вопроса с вариантами (`options.length > 0`) сразу после его
 * вариантов идёт строка «✍️ Свой ответ» → `q:<rid>:<qi>:custom` (свободный
 * текст через reply); у вопросов без вариантов кнопки нет — там и так reply-текст.
 * Строка «✅ Ответить» (`q:<rid>:go`) — только если вопросов несколько или
 * хотя бы один с multiple (иначе выбор отправляется сразу, см. бридж).
 * Последняя строка всегда «❌ Отклонить» → `q:<rid>:no`.
 * Выбранное состояние (✅) рисует бридж при накоплении — плагин шлёт исходное.
 */
export function buildQuestionKeyboard(
  rid: string,
  questions: QuestionInput[],
): InlineKeyboard {
  const list = Array.isArray(questions) ? questions : [];
  const rows: InlineKeyboardButton[][] = [];
  list.forEach((item, questionIndex) => {
    const options = Array.isArray(item?.options) ? item.options : [];
    if (options.length === 0) return; // custom-вопрос: кнопка не нужна, только reply-текст
    options.forEach((option, optionIndex) => {
      const label = truncate(option?.label ?? "", QUESTION_BUTTON_LABEL_CHARS).trim();
      if (!label) return;
      rows.push([{ text: label, callback_data: `q:${rid}:${questionIndex}:${optionIndex}` }]);
    });
    // ✍️ «Свой ответ» — строкой ПЕРЕД ✅ Ответить / ❌ Отклонить
    rows.push([
      { text: QUESTION_CUSTOM_BUTTON, callback_data: `q:${rid}:${questionIndex}:custom` },
    ]);
  });
  const needsGo = list.length > 1 || list.some((item) => item?.multiple === true);
  if (needsGo) {
    rows.push([{ text: "✅ Ответить", callback_data: `q:${rid}:go` }]);
  }
  rows.push([{ text: "❌ Отклонить", callback_data: `q:${rid}:no` }]);
  return { inline_keyboard: rows };
}

/**
 * Клавиатура ОДНОГО вопроса формы (sequential: Q1 плагина, Q2..QN моста).
 * Каждый вариант — отдельная строка: label ≤60, callback_data `q:<rid>:<qi>:<oi>`.
 * Затем «✍️ Свой ответ» → `q:<rid>:<qi>:custom`, для `multiple:true` —
 * «✅ Готово» → `q:<rid>:<qi>:commit`, последняя строка всегда
 * «❌ Отклонить» → `q:<rid>:no`. Агрегированной кнопки `q:<rid>:go` здесь нет:
 * sequential-форму ведёт мост, плагин шлёт только Q1.
 * Все callback_data ≤ 64 байт (rid 12 hex, qi/oi — небольшие индексы).
 */
export function buildQuestionPageKeyboard(
  rid: string,
  item: QuestionInput | undefined,
  questionIndex: number,
): InlineKeyboard {
  const qi =
    typeof questionIndex === "number" && Number.isInteger(questionIndex) && questionIndex >= 0
      ? questionIndex
      : 0;
  const options = Array.isArray(item?.options) ? item.options : [];
  const rows: InlineKeyboardButton[][] = [];
  options.forEach((option, optionIndex) => {
    if (optionIndex >= QUESTION_MAX_OPTIONS) return;
    const label = truncate(option?.label ?? "", QUESTION_BUTTON_LABEL_CHARS).trim();
    if (!label) return;
    rows.push([{ text: label, callback_data: `q:${rid}:${qi}:${optionIndex}` }]);
  });
  rows.push([{ text: QUESTION_CUSTOM_BUTTON, callback_data: `q:${rid}:${qi}:custom` }]);
  if (item?.multiple === true) {
    rows.push([{ text: "✅ Готово", callback_data: `q:${rid}:${qi}:commit` }]);
  }
  rows.push([{ text: "❌ Отклонить", callback_data: `q:${rid}:no` }]);
  return { inline_keyboard: rows };
}
