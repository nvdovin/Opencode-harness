// Тесты format.ts — инструмент question: HTML-текст вопроса (≤3900, экранирование,
// нумерация, обрезка вариантов) и инлайн-кнопки (callback_data ≤64, go/reject).
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeBridgeConfig } from "../config.ts";
import {
  buildQuestionKeyboard,
  formatQuestion,
  MAX_MESSAGE_CHARS,
  QUESTION_BUTTON_LABEL_CHARS,
  QUESTION_MAX_OPTIONS,
} from "../format.ts";

const config = () => makeBridgeConfig({ token: "", chatId: "" });
const RID = "abc123def456";

type KeyboardRow = { text: string; callback_data: string };

function buttons(keyboard: { inline_keyboard: KeyboardRow[][] }): KeyboardRow[] {
  return keyboard.inline_keyboard.map((row) => row[0]);
}

test("test_question_format_escaped", () => {
  const html = formatQuestion(
    {
      sessionShort: "abcd1234",
      questions: [
        {
          question: 'Выбрать <режим> & "формат"?',
          options: [
            { label: "A<b> & c", description: "описание <с> & >" },
            { label: "B", description: "" },
          ],
        },
      ],
    },
    config(),
  );
  assert.ok(html.startsWith("❓ <b>Вопрос агента</b>"));
  assert.ok(html.includes("<b>Сессия:</b> <code>abcd1234</code>"));
  assert.ok(html.includes("&lt;режим&gt;") && html.includes("&amp;"), "вопрос экранирован");
  assert.ok(!html.includes("<режим>"), "сырой тег не попадает в текст");
  assert.ok(html.includes("<i>1. A&lt;b&gt; &amp; c — описание &lt;с&gt; &amp; &gt;</i>"));
  assert.ok(html.includes("<i>2. B</i>"), "пустой description — строка без «—»");
  assert.ok(html.includes("reply"), "хвост упоминает reply");
  assert.ok(!html.includes("<b>1. "), "один вопрос — без нумерации вопроса");
  for (const tag of ["b", "i", "code"]) {
    assert.equal(
      (html.match(new RegExp(`<${tag}>`, "g")) ?? []).length,
      (html.match(new RegExp(`</${tag}>`, "g")) ?? []).length,
      `тег ${tag} не закрыт`,
    );
  }
});

test("test_question_numbering_with_two_questions", () => {
  const html = formatQuestion(
    {
      sessionShort: "abcd1234",
      questions: [
        { question: "Первый вопрос?", options: [{ label: "Да", description: "" }] },
        { question: "Второй вопрос?", options: [{ label: "Нет", description: "" }] },
      ],
    },
    config(),
  );
  assert.ok(html.includes("<b>1. Первый вопрос?</b>"), "нумерация вопросов с 1");
  assert.ok(html.includes("<b>2. Второй вопрос?</b>"));
  assert.ok(html.includes("<i>1. Да</i>"), "нумерация вариантов внутри вопроса");
  assert.ok(html.includes("<i>1. Нет</i>"));
});

test("test_question_options_capped_in_text_only", () => {
  const options = Array.from({ length: 13 }, (_, index) => ({
    label: `Вариант ${index + 1}`,
    description: "",
  }));
  const questions = [{ question: "Что выбрать?", options }];
  const html = formatQuestion({ sessionShort: "abcd1234", questions }, config());
  assert.ok(html.includes("…и ещё 3 вариантов — ответьте текстом (reply)"));
  assert.ok(html.includes("10. Вариант 10"), "первые 10 вариантов показаны");
  assert.ok(!html.includes("11. Вариант 11"), "11-й и дальше в текст не попадают");
  assert.equal(QUESTION_MAX_OPTIONS, 10);

  // кнопки при этом не обрезаются: 13 строк вариантов + ✍️ Свой ответ + reject
  const rows = buildQuestionKeyboard(RID, questions).inline_keyboard;
  assert.equal(rows.length, options.length + 2);
});

test("test_question_format_length_le_3900", () => {
  const html = formatQuestion(
    {
      sessionShort: "x".repeat(500),
      questions: Array.from({ length: 3 }, (_, index) => ({
        question: `Вопрос ${index}? ${"&".repeat(4000)}`,
        options: Array.from({ length: 12 }, (_, optionIndex) => ({
          label: `${"Опция <".repeat(200)}${optionIndex}`,
          description: "descr >".repeat(500),
        })),
      })),
    },
    config(),
  );
  assert.ok(html.length <= MAX_MESSAGE_CHARS, `длина ${html.length} > ${MAX_MESSAGE_CHARS}`);
  assert.ok(html.startsWith("❓ <b>Вопрос агента</b>"), "заголовок сохраняется");
  assert.ok(html.includes("reply"), "хвост с reply сохраняется");
  for (const tag of ["b", "i", "code"]) {
    assert.equal(
      (html.match(new RegExp(`<${tag}>`, "g")) ?? []).length,
      (html.match(new RegExp(`</${tag}>`, "g")) ?? []).length,
      `тег ${tag} не закрыт`,
    );
  }
});

test("test_question_keyboard_single_question_without_go", () => {
  const keyboard = buildQuestionKeyboard(RID, [
    {
      question: "Какой формат?",
      options: [
        { label: "JSON", description: "" },
        { label: "YAML", description: "" },
      ],
    },
  ]);
  const rows = keyboard.inline_keyboard;
  for (const row of rows) assert.equal(row.length, 1, "каждый вариант — своя строка");
  assert.deepEqual(
    buttons(keyboard).map((b) => b.callback_data),
    [`q:${RID}:0:0`, `q:${RID}:0:1`, `q:${RID}:0:custom`, `q:${RID}:no`],
    "1 вопрос без multiple → без строки go, но с ✍️ Свой ответ перед reject",
  );
  assert.deepEqual(
    buttons(keyboard).map((b) => b.text),
    ["JSON", "YAML", "✍️ Свой ответ", "❌ Отклонить"],
  );
});

test("test_question_keyboard_custom_button_row", () => {
  // «✍️ Свой ответ» есть у каждого вопроса с вариантами и стоит ПЕРЕД go/reject
  const keyboard = buildQuestionKeyboard(RID, [
    { question: "Q1", options: [{ label: "A", description: "" }] },
    { question: "Q2", options: [{ label: "B", description: "" }] },
  ]);
  const rows = buttons(keyboard);
  const customs = rows.filter((row) => row.callback_data.endsWith(":custom"));
  assert.equal(customs.length, 2, "по одной кнопке на вопрос с вариантами");
  assert.deepEqual(
    customs.map((row) => row.callback_data),
    [`q:${RID}:0:custom`, `q:${RID}:1:custom`],
    "индекс вопроса — 0-based, как у вариантов",
  );
  assert.ok(customs.every((row) => row.text === "✍️ Свой ответ"));
  const goIndex = rows.findIndex((row) => row.callback_data === `q:${RID}:go`);
  const noIndex = rows.findIndex((row) => row.callback_data === `q:${RID}:no`);
  assert.ok(goIndex > rows.indexOf(customs[0]) && goIndex > rows.indexOf(customs[1]), "custom до go");
  assert.ok(noIndex > rows.indexOf(customs[1]), "custom до reject");

  // вопрос БЕЗ вариантов (custom) — кнопка не нужна, только reject/go
  const noOptions = buildQuestionKeyboard(RID, [
    { question: "Свободный текст", options: [], custom: true },
    { question: "Второй", options: [{ label: "C", description: "" }] },
  ]);
  const noOptionsRows = buttons(noOptions);
  assert.deepEqual(
    noOptionsRows.map((row) => row.callback_data),
    [`q:${RID}:1:0`, `q:${RID}:1:custom`, `q:${RID}:go`, `q:${RID}:no`],
    "у custom-вопроса без вариантов нет строк, у второго — варианты и ✍️",
  );
});

test("test_question_callback_data_custom_within_64", () => {
  // худший случай: q:(2) + rid(12) + :(1) + qi(2) + :custom(7) = 24 байта ≤ 64
  const worst = `q:${RID}:99:custom`;
  assert.equal(Buffer.byteLength(worst, "utf8"), 24);
  assert.ok(Buffer.byteLength(worst, "utf8") <= 64);

  const keyboard = buildQuestionKeyboard(RID, [
    { question: "Q", options: [{ label: "A", description: "" }] },
    { question: "Q2", multiple: true, options: [{ label: "B", description: "" }] },
  ]);
  for (const row of keyboard.inline_keyboard) {
    const data = row[0].callback_data;
    assert.ok(Buffer.byteLength(data, "utf8") <= 64, `${data} > 64`);
    assert.match(data, /^q:[0-9a-f]{12}:(go|no|custom|[0-9]+:[0-9]+|[0-9]+:custom)$/);
  }
});

test("test_question_keyboard_go_row_when_accumulation_needed", () => {
  // два вопроса → строка go обязана быть (и ✍️ после каждого вопроса)
  const two = buildQuestionKeyboard(RID, [
    { question: "Q1", options: [{ label: "A", description: "" }] },
    { question: "Q2", options: [{ label: "B", description: "" }] },
  ]);
  assert.deepEqual(
    buttons(two).map((b) => b.callback_data),
    [`q:${RID}:0:0`, `q:${RID}:0:custom`, `q:${RID}:1:0`, `q:${RID}:1:custom`, `q:${RID}:go`, `q:${RID}:no`],
  );

  // один вопрос с multiple → тоже go
  const multiple = buildQuestionKeyboard(RID, [
    { question: "Q1", multiple: true, options: [{ label: "A", description: "" }] },
  ]);
  assert.deepEqual(
    buttons(multiple).map((b) => b.callback_data),
    [`q:${RID}:0:0`, `q:${RID}:0:custom`, `q:${RID}:go`, `q:${RID}:no`],
  );
  assert.deepEqual(
    buttons(multiple).map((b) => b.text),
    ["A", "✍️ Свой ответ", "✅ Ответить", "❌ Отклонить"],
  );

  // reject всегда последней строкой
  for (const keyboard of [two, multiple]) {
    const last = keyboard.inline_keyboard[keyboard.inline_keyboard.length - 1][0];
    assert.equal(last.callback_data, `q:${RID}:no`);
    assert.equal(last.text, "❌ Отклонить");
  }
});

test("test_question_callback_data_within_64", () => {
  const keyboard = buildQuestionKeyboard(RID, [
    { question: "Q1", options: [{ label: "A", description: "" }, { label: "B", description: "" }] },
    { question: "Q2", multiple: true, options: [{ label: "C", description: "" }] },
  ]);
  assert.ok(keyboard.inline_keyboard.length >= 5, "варианты + go + reject");
  for (const row of keyboard.inline_keyboard) {
    const data = row[0].callback_data;
    const bytes = Buffer.byteLength(data, "utf8");
    assert.ok(bytes <= 64, `${data} = ${bytes} байт > 64`);
    assert.match(data, /^q:[0-9a-f]{12}:(go|no|custom|[0-9]+:[0-9]+|[0-9]+:custom)$/);
  }
  // длина: q:(2) + rid(12) + :(1) + go/no(2) = 17 байт ≤ 64
  assert.equal(Buffer.byteLength(`q:${RID}:go`, "utf8"), 17);
  assert.equal(Buffer.byteLength(`q:${RID}:no`, "utf8"), 17);
});

test("test_question_button_label_truncated", () => {
  const label = "Очень длинный вариант ответа ".repeat(10);
  const keyboard = buildQuestionKeyboard(RID, [{ question: "Q", options: [{ label }] }]);
  const text = buttons(keyboard)[0].text;
  assert.ok(Array.from(text).length <= QUESTION_BUTTON_LABEL_CHARS, `длина ${text.length}`);
  assert.ok(text.endsWith("…"), "обрезка с многоточием");

  // пустая/пробельная метка не создаёт строку, индексы callback не сдвигаются
  const withEmpty = buildQuestionKeyboard(RID, [
    { question: "Q", options: [{ label: "   ", description: "" }, { label: "A", description: "" }] },
  ]);
  assert.deepEqual(
    buttons(withEmpty).map((b) => b.callback_data),
    [`q:${RID}:0:1`, `q:${RID}:0:custom`, `q:${RID}:no`],
  );
});

test("test_question_adaptive_hint_options_vs_custom", () => {
  // вопрос с вариантами → подсказка про кнопку, ✍️ и текст (честно: всё доступно)
  const withOptions = formatQuestion(
    { sessionShort: "abcd1234", questions: [{ question: "Q?", options: [{ label: "A", description: "" }] }] },
    config(),
  );
  assert.ok(withOptions.includes("Ответьте кнопкой"), withOptions);
  assert.ok(withOptions.includes("нажмите ✍️ «Свой ответ»"), withOptions);
  assert.ok(withOptions.includes("reply на это сообщение"), withOptions);

  // custom-вопрос (без вариантов) → только текстовый ответ, кнопки не обещаем
  const custom = formatQuestion(
    { sessionShort: "abcd1234", questions: [{ question: "Q?", options: [], custom: true }] },
    config(),
  );
  assert.ok(custom.includes("Напишите ответ текстом (reply на это сообщение)"), custom);
  assert.ok(!custom.includes("Ответьте кнопкой"), "подсказка не врёт про кнопки");

  // флаг custom реально читается: custom=true при вариантах (v1) → текстовый хвост
  const flagged = formatQuestion(
    {
      sessionShort: "abcd1234",
      questions: [{ question: "Q?", options: [{ label: "A", description: "" }], custom: true }],
    },
    config(),
  );
  assert.ok(flagged.includes("Напишите ответ текстом"), flagged);
  assert.ok(!flagged.includes("Ответьте кнопкой"), flagged);

  // смешанный список: подсказки разные у разных вопросов
  const mixed = formatQuestion(
    {
      sessionShort: "abcd1234",
      questions: [
        { question: "С вариантами?", options: [{ label: "A", description: "" }] },
        { question: "Свободный?", options: [], custom: true },
      ],
    },
    config(),
  );
  assert.ok(mixed.includes("Ответьте кнопкой") && mixed.includes("Напишите ответ текстом"), mixed);
});
