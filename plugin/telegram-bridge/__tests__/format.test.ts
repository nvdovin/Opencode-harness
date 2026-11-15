// Тесты format.ts — баннеры, экранирование, обрезка, лимит 3900, fallback.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeBridgeConfig } from "../config.ts";
import {
  buildQuestionPageKeyboard,
  formatDone,
  formatDuration,
  formatQuestionPage,
  htmlEscape,
  projectFromDirectory,
  truncate,
  MAX_MESSAGE_CHARS,
  QUESTION_MAX_OPTIONS,
} from "../format.ts";

const config = () => makeBridgeConfig({ token: "", chatId: "" });

function balanced(html: string): boolean {
  for (const tag of ["b", "i", "code"]) {
    const open = (html.match(new RegExp(`<${tag}>`, "g")) ?? []).length;
    const close = (html.match(new RegExp(`</${tag}>`, "g")) ?? []).length;
    if (open !== close) return false;
  }
  return true;
}

test("test_success_banner", () => {
  const html = formatDone(
    {
      status: "success",
      task: "Сделай отчёт",
      result: "Готово, отчёт собран",
      project: "opencode-telegram-notifier",
      model: "anthropic/claude-x",
      durationMs: 65000,
    },
    config(),
  );
  assert.ok(html.startsWith("✅ <b>Задача выполнена</b>"));
  assert.ok(html.includes("<b>Задача:</b> Сделай отчёт"));
  assert.ok(html.includes("<b>Итог:</b> Готово, отчёт собран"));
  assert.ok(html.includes("<i>Проект:</i> <code>opencode-telegram-notifier</code>"));
  assert.ok(html.includes("<i>Модель:</i> anthropic/claude-x"));
  assert.ok(html.includes("<i>Время:</i> 1 мин 5 с"));
  assert.ok(balanced(html));
});

test("test_error_banner", () => {
  const html = formatDone(
    { status: "error", task: "Задача", result: "Сломалось" },
    config(),
  );
  assert.ok(html.startsWith("⚠️ <b>Задача завершилась с ошибкой</b>"));
  assert.ok(html.includes("<b>Итог:</b> Сломалось"));

  const withMessage = formatDone(
    { status: "error", task: "Задача", result: "", errorMessage: "Провал провайдера" },
    config(),
  );
  assert.ok(withMessage.includes("Провал провайдера"));
  assert.ok(balanced(withMessage));
});

test("test_abort_banner", () => {
  const html = formatDone({ status: "abort", task: "Задача", result: "" }, config());
  assert.ok(html.startsWith("⛔ <b>Запрос прерван</b>"));
  assert.ok(html.includes("Запрос был прерван до завершения."));
  assert.ok(balanced(html));
});

test("test_html_escaped", () => {
  const html = formatDone(
    { status: "success", task: "<script>&", result: "1 < 2 && 3 > 2" },
    config(),
  );
  assert.ok(html.includes("&lt;script&gt;&amp;"));
  assert.ok(!html.includes("<script>"));
  assert.ok(html.includes("1 &lt; 2 &amp;&amp; 3 &gt; 2"));
  assert.equal(htmlEscape("<a>&"), "&lt;a&gt;&amp;");
  assert.equal(projectFromDirectory("/root/projects/opencode-telegram-notifier/"), "opencode-telegram-notifier");
  assert.equal(formatDuration(450), "450 мс");
  assert.equal(formatDuration(4000), "4 с");
  assert.equal(formatDuration(125000), "2 мин 5 с");
});

test("test_truncate_word_boundary", () => {
  const cut = truncate("alpha beta gamma delta", 12);
  assert.ok(cut.endsWith("…"));
  assert.equal(Array.from(cut).length <= 12, true);
  assert.ok(cut.startsWith("alpha beta"));
  assert.ok(!cut.includes("  "));

  const noSpace = truncate("abcdefghij", 5);
  assert.equal(noSpace, "abcd…");

  // surrogate-пары не рвутся
  const emoji = truncate("😀😀😀😀😀", 3);
  assert.equal(Array.from(emoji).length, 3);
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(emoji));
  assert.ok(!/(?:[^\uD800-\uDBFF]|^)[\uDC00-\uDFFF]/.test(emoji));

  // короткая строка не обрезается
  assert.equal(truncate("short", 100), "short");
  // в выхлопе не остаётся незакрытых тегов
  const long = formatDone(
    { status: "success", task: "слово ".repeat(200), result: "результат ".repeat(200) },
    config(),
  );
  assert.ok(balanced(long));
});

test("test_total_length_le_3900", () => {
  const html = formatDone(
    {
      status: "success",
      task: "очень длинная задача ".repeat(500),
      result: "очень длинный итог ".repeat(500),
      project: "p".repeat(200),
      model: "provider/" + "m".repeat(200),
      durationMs: 999999,
    },
    makeBridgeConfig({
      token: "",
      chatId: "",
      maxTaskChars: 300,
      maxResultChars: 3500,
      includeProject: true,
      includeModel: true,
      includeDuration: true,
    }),
  );
  assert.ok(html.length <= MAX_MESSAGE_CHARS, `длина ${html.length} > ${MAX_MESSAGE_CHARS}`);
  assert.ok(balanced(html), "теги должны быть закрыты");
  assert.ok(html.startsWith("✅ <b>Задача выполнена</b>"));
});

test("test_empty_result_fallback", () => {
  const success = formatDone({ status: "success", task: "Задача", result: "   " }, config());
  assert.ok(success.includes("Ассистент не вернул текстовый итог."));
  assert.ok(!success.includes("<b>Итог:</b> \n"));

  const error = formatDone({ status: "error", task: "Задача", result: "" }, config());
  assert.ok(error.includes("Ошибка без текстового описания."));

  const abort = formatDone({ status: "abort", task: "Задача", result: "" }, config());
  assert.ok(abort.includes("Запрос был прерван до завершения."));

  // флаги include* выключены → мета-строка отсутствует
  const noMeta = formatDone(
    { status: "success", task: "t", result: "r", project: "p", model: "m", durationMs: 1 },
    makeBridgeConfig({ token: "", chatId: "", includeProject: false, includeModel: false, includeDuration: false }),
  );
  assert.ok(!noMeta.includes("Проект:"));
  assert.ok(!noMeta.includes("Модель:"));
  assert.ok(!noMeta.includes("Время:"));
});

test("test_md_bold_italic_code", () => {
  const html = formatDone(
    {
      status: "success",
      task: "сделай **важное** и `код`",
      result: "Готово: **OK**, *italic*, `inline`, ~~strike~~",
    },
    config(),
  );
  assert.ok(html.includes("<b>важное</b>"), "bold");
  assert.ok(html.includes("<code>код</code>"), "task code");
  assert.ok(html.includes("<b>OK</b>"), "result bold");
  assert.ok(html.includes("<i>italic</i>"), "italic");
  assert.ok(html.includes("<code>inline</code>"), "inline code");
  assert.ok(html.includes("<s>strike</s>"), "strike");
  assert.ok(!html.includes("**"), "asterisks consumed");
  assert.ok(balanced(html));
});

test("test_md_link_and_fence", () => {
  const html = formatDone(
    {
      status: "success",
      task: "t",
      result: "См. [документацию](https://example.com/docs)\n```js\nconst x = 1 < 2;\n```",
    },
    config(),
  );
  assert.ok(html.includes('<a href="https://example.com/docs">документацию</a>'), "link");
  assert.ok(html.includes("<pre>const x = 1 &lt; 2;</pre>"), "fence escaped+wrapped");
  assert.ok(balanced(html));
});

test("test_md_unsafe_link_not_converted", () => {
  const html = formatDone(
    { status: "success", task: "t", result: "[x](javascript:alert(1))" },
    config(),
  );
  assert.ok(!html.includes('href="javascript:'), "no js href");
  assert.ok(html.includes("[x](javascript:alert(1))") || html.includes("&lt;"), "остался текстом");
  assert.ok(balanced(html));
});

test("test_md_truncate_no_broken_tags", () => {
  const html = formatDone(
    {
      status: "success",
      task: "**очень важная задача** ".repeat(50),
      result: "**жирный итог** ".repeat(100),
    },
    makeBridgeConfig({ token: "", chatId: "", maxTaskChars: 40, maxResultChars: 80 }),
  );
  assert.ok(balanced(html), "теги сбалансированы после обрезки");
  assert.ok(html.length <= MAX_MESSAGE_CHARS);
});

// --- sequential-форма: рендер одного вопроса и клавиатура Q1 ---

test("test_question_page_renders_single_question", () => {
  const html = formatQuestionPage({
    sessionShort: "ses12345",
    question: {
      question: "Какой формат <конфига>?",
      header: "format",
      options: [
        { label: "JSON", description: "структурированный & строгий" },
        { label: "YAML", description: "" },
      ],
      multiple: false,
      custom: false,
    },
    index: 0,
    total: 2,
  });

  assert.ok(html.startsWith("❓ <b>Вопрос агента · 1/2</b>"), `заголовок 1/2: ${html.slice(0, 50)}`);
  assert.ok(html.includes("<b>Сессия:</b> <code>ses12345</code>"));
  assert.ok(html.includes("<i>format</i>"), "header выводится курсивом");
  assert.ok(html.includes("Какой формат &lt;конфига&gt;?"), "вопрос экранирован");
  assert.ok(!html.includes("<конфига>"), "сырых тегов нет");
  assert.ok(html.includes("<i>1. JSON — структурированный &amp; строгий</i>"));
  assert.ok(html.includes("<i>2. YAML</i>"));
  assert.match(html, /Ответьте кнопкой/, "подсказка с кнопками");
  assert.ok(balanced(html));

  // N=1 → единообразный заголовок 1/1
  const single = formatQuestionPage({
    sessionShort: "s",
    question: { question: "Один?", options: [], custom: true },
    index: 0,
    total: 1,
  });
  assert.ok(single.startsWith("❓ <b>Вопрос агента · 1/1</b>"));
  assert.match(single, /Напишите ответ текстом/, "custom без вариантов → только текст");

  // битые total/index не ломают заголовок
  const broken = formatQuestionPage({
    sessionShort: "s",
    question: { question: "?", options: [] },
    index: 5,
    total: Number.NaN,
  });
  assert.ok(broken.startsWith("❓ <b>Вопрос агента · 1/1</b>"));
});

test("test_question_page_option_limit_and_length", () => {
  const options = Array.from({ length: 15 }, (_, index) => ({
    label: `вариант ${index + 1}`,
    description: "описание",
  }));
  const html = formatQuestionPage({
    sessionShort: "ses",
    question: { question: "Выбери?", options },
    index: 0,
    total: 1,
  });
  assert.ok(html.includes("<i>10. вариант 10 — описание</i>"), "10-й вариант есть");
  assert.ok(!html.includes("11. вариант 11"), "варианты сверх лимита не печатаются");
  assert.ok(html.includes("…и ещё 5 вариантов"), "строка про остаток");
  assert.ok(QUESTION_MAX_OPTIONS === 10);

  // длинный вопрос/варианты → ≤3900 и закрытые теги
  const long = formatQuestionPage({
    sessionShort: "s".repeat(80),
    question: {
      question: "очень длинный вопрос ".repeat(400),
      header: "h".repeat(500),
      options: Array.from({ length: 10 }, () => ({
        label: "label ".repeat(50),
        description: "description ".repeat(50),
      })),
    },
    index: 0,
    total: 1,
  });
  assert.ok(long.length <= MAX_MESSAGE_CHARS, `длина ${long.length} > ${MAX_MESSAGE_CHARS}`);
  assert.ok(balanced(long));
});

test("test_question_page_keyboard_single_and_multiple", () => {
  const rid = "0123456789ab";
  const single = buildQuestionPageKeyboard(
    rid,
    {
      question: "Какой?",
      options: [{ label: "A", description: "" }, { label: "B", description: "" }],
      multiple: false,
      custom: false,
    },
    0,
  );
  assert.deepEqual(
    single.inline_keyboard.map((row) => row[0].callback_data),
    [`q:${rid}:0:0`, `q:${rid}:0:1`, `q:${rid}:0:custom`, `q:${rid}:no`],
    "варианты + ✍️ + reject, без commit/go",
  );
  assert.deepEqual(
    single.inline_keyboard.map((row) => row[0].text),
    ["A", "B", "✍️ Свой ответ", "❌ Отклонить"],
  );

  const multiple = buildQuestionPageKeyboard(
    rid,
    { question: "Несколько?", options: [{ label: "X", description: "" }], multiple: true, custom: false },
    2,
  );
  assert.deepEqual(
    multiple.inline_keyboard.map((row) => row[0].callback_data),
    [`q:${rid}:2:0`, `q:${rid}:2:custom`, `q:${rid}:2:commit`, `q:${rid}:no`],
    "multiple → ✅ Готово перед reject, q:<rid>:go отсутствует",
  );
  assert.ok(
    multiple.inline_keyboard.every((row) => row.length === 1),
    "каждый вариант отдельной строкой",
  );

  // custom без вариантов: ✍️ всё равно есть (контракт Q1), commit — только multiple
  const empty = buildQuestionPageKeyboard(rid, { question: "?", options: [], multiple: false }, 0);
  assert.deepEqual(
    empty.inline_keyboard.map((row) => row[0].callback_data),
    [`q:${rid}:0:custom`, `q:${rid}:no`],
  );

  // label ≤60, callback_data ≤64 байт; >10 вариантов в клавиатуру не попадают
  const many = buildQuestionPageKeyboard(
    rid,
    {
      question: "?",
      options: Array.from({ length: 14 }, () => ({ label: "о".repeat(200), description: "" })),
      multiple: true,
    },
    0,
  );
  for (const row of many.inline_keyboard) {
    assert.ok(Buffer.byteLength(row[0].callback_data, "utf8") <= 64);
  }
  assert.ok(many.inline_keyboard[0][0].text.length <= 60);
  const variantRows = many.inline_keyboard.filter((row) => /:\d+:\d+$/.test(row[0].callback_data));
  assert.equal(variantRows.length, 10, "не больше 10 вариантов");
  assert.ok(!many.inline_keyboard.some((row) => row[0].callback_data.endsWith(":go")));
});
