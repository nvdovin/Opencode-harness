// Тесты extract.ts — выбор assistant, первая user-задача, только text-части, isRoot, abort, длительность.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildExtraction, isQuestionText, selectFirstUserText, selectLatestAssistant, type ExtractedMessage } from "../extract.ts";

const user = (id: string, text: string, created: number): ExtractedMessage => ({
  info: { id, role: "user", time: { created } },
  parts: [{ type: "text", text }],
});

const assistant = (
  id: string,
  opts: {
    created?: number;
    completed?: number;
    parentID?: string;
    error?: { name?: string; data?: { message?: string } } | null;
    parts?: ExtractedMessage["parts"];
    providerID?: string;
    modelID?: string;
  } = {},
): ExtractedMessage => ({
  info: {
    id,
    role: "assistant",
    parentID: opts.parentID ?? "u1",
    time: { created: opts.created ?? 0, completed: opts.completed },
    error: opts.error ?? undefined,
    providerID: opts.providerID ?? "anthropic",
    modelID: opts.modelID ?? "claude-x",
  },
  parts: opts.parts ?? [{ type: "text", text: "ответ" }],
});

test("test_latest_assistant_by_completed", () => {
  const messages: ExtractedMessage[] = [
    user("u1", "задача", 10),
    assistant("a-old", { created: 11, completed: 100, parts: [{ type: "text", text: "СТАРЫЙ" }] }),
    assistant("a-new", { created: 150, completed: 300, parts: [{ type: "text", text: "НОВЫЙ" }] }),
    // created больше, но completed меньше → проигрывает по правилу «максимальный completed»
    assistant("a-weird", { created: 250, completed: 150, parts: [{ type: "text", text: "СТРАННЫЙ" }] }),
  ];
  const latest = selectLatestAssistant(messages);
  // максимальный time.completed = 300 → a-new
  assert.equal(latest?.info.id, "a-new");

  const extraction = buildExtraction(
    { id: "s", time: { created: 0 } },
    messages,
    "http://127.0.0.1:4100",
    1000,
  );
  assert.equal(extraction.result, "НОВЫЙ");
  assert.equal(extraction.assistantMessageID, "a-new");

  // fallback на time.created, когда completed нет ни у кого
  const noCompleted = buildExtraction(
    { id: "s", time: { created: 0 } },
    [
      user("u1", "задача", 10),
      assistant("a1", { created: 11, completed: undefined, parts: [{ type: "text", text: "A1" }] }),
      assistant("a2", { created: 55, completed: undefined, parts: [{ type: "text", text: "A2" }] }),
    ],
    "http://127.0.0.1:4100",
    1000,
  );
  assert.equal(noCompleted.assistantMessageID, "a2");
  assert.equal(noCompleted.result, "A2");
});

test("test_task_from_first_user", () => {
  const messages: ExtractedMessage[] = [
    user("u1", "ПЕРВАЯ ЗАДАЧА", 100),
    assistant("a1", { created: 120, completed: 130, parentID: "u1" }),
    user("u2", "ВТОРОЕ СООБЩЕНИЕ", 200),
    assistant("a2", { created: 220, completed: 230, parentID: "u2" }),
  ];
  assert.equal(selectFirstUserText(messages), "ПЕРВАЯ ЗАДАЧА");
  const extraction = buildExtraction({ id: "s", time: { created: 0 } }, messages, "http://x", 1000);
  assert.equal(extraction.task, "ПЕРВАЯ ЗАДАЧА");
  assert.notEqual(extraction.task, "ВТОРОЕ СООБЩЕНИЕ");
  // итог — из последнего assistant
  assert.equal(extraction.assistantMessageID, "a2");
});

test("test_text_parts_only", () => {
  const messages: ExtractedMessage[] = [
    {
      info: { id: "u1", role: "user", time: { created: 10 } },
      parts: [
        { type: "reasoning", text: "REASONING_IN_TASK" },
        { type: "tool", text: "TOOL_IN_TASK" },
        { type: "text", text: "только текст задачи" },
        { type: "text", text: "synthetic-part", synthetic: true },
      ],
    },
    {
      info: {
        id: "a1",
        role: "assistant",
        parentID: "u1",
        time: { created: 20, completed: 30 },
        providerID: "p",
        modelID: "m",
      },
      parts: [
        { type: "reasoning", text: "REASONING_IN_RESULT" },
        { type: "text", text: "итоговый текст" },
        {
          type: "tool",
          text: "TOOL_IN_RESULT",
        },
        { type: "text", text: "  много   пробелов \n между ", synthetic: false },
      ],
    },
  ];
  const extraction = buildExtraction({ id: "s", time: { created: 0 } }, messages, "http://x", 1000);
  assert.equal(extraction.task, "только текст задачи");
  assert.ok(!extraction.task.includes("REASONING_IN_TASK"));
  assert.ok(!extraction.task.includes("TOOL_IN_TASK"));
  assert.ok(!extraction.task.includes("synthetic-part"));
  assert.ok(!extraction.result.includes("REASONING_IN_RESULT"));
  assert.ok(!extraction.result.includes("TOOL_IN_RESULT"));
  assert.equal(extraction.result, "итоговый текст много пробелов между");
});

test("test_parent_means_not_root", () => {
  const messages: ExtractedMessage[] = [user("u1", "задача", 1), assistant("a1", { completed: 2 })];
  const root = buildExtraction({ id: "s", time: { created: 0 } }, messages, "http://x", 10);
  assert.equal(root.isRoot, true);
  const child = buildExtraction(
    { id: "s", parentID: "parent-session", time: { created: 0 } },
    messages,
    "http://x",
    10,
  );
  assert.equal(child.isRoot, false);
});

test("test_aborted_status", () => {
  const messages: ExtractedMessage[] = [
    user("u1", "задача", 1),
    assistant("a1", {
      completed: 2,
      error: { name: "MessageAbortedError", data: { message: "aborted" } },
      parts: [],
    }),
  ];
  const aborted = buildExtraction({ id: "s", time: { created: 0 } }, messages, "http://x", 10);
  assert.equal(aborted.status, "abort");
  assert.equal(aborted.errorMessage, "aborted");

  const failed = buildExtraction(
    { id: "s", time: { created: 0 } },
    [
      user("u1", "задача", 1),
      assistant("a1", { completed: 2, error: { name: "APIError", data: { message: "boom" } }, parts: [] }),
    ],
    "http://x",
    10,
  );
  assert.equal(failed.status, "error");
  assert.equal(failed.errorMessage, "boom");

  const success = buildExtraction({ id: "s", time: { created: 0 } }, [user("u1", "задача", 1)], "http://x", 10);
  assert.equal(success.status, "success");
});

test("test_question_text_tail_rule", () => {
  // 1) `?` только в середине (URL/код), хвост — утвердительное завершение → НЕ вопрос
  const midUrl = [
    "Я проверил проект: сборка проходит, юнит-тесты зелёные, линтер не ругается.",
    "В запросах используется адрес вида https://api.example.com/v1/items?limit=50&offset=0,",
    "поэтому знак вопроса встречается в URL, но это не вопрос к вам.",
    "Итог: всё работает, правок больше не требуется.",
  ].join(" ");
  assert.ok(
    midUrl.lastIndexOf("?") < midUrl.length - 80,
    "в кейсе `?` дальше 80 символов от конца (иначе тест не проверяет середину)",
  );
  assert.equal(isQuestionText(midUrl), false, "срединный `?` при утвердительном хвосте — не вопрос");

  // 2) текст заканчивается на `?` → вопрос
  assert.equal(isQuestionText("Какой приоритет: код или тесты?"), true);

  // 3) маркер сразу после вопроса (живой E2E-формат «вопрос? QUESTION_NOTIFIED») → вопрос
  assert.equal(isQuestionText("Какой язык вы используете? QUESTION_NOTIFIED"), true);

  // 4) `?` в последних 80 символах, хотя последнее «предложение» утвердительное → вопрос
  const tail80 = "Проверь результат? Всё сделано. Готово к сдаче.";
  assert.ok(tail80.lastIndexOf("?") >= tail80.length - 80, "в кейсе `?` в последних 80 символах");
  assert.equal(isQuestionText(tail80), true);

  // 5) `?` в последнем «предложении» длинного текста (дальше 80 символов от конца) → вопрос
  const lastSentence =
    "Сначала я обновил конфигурацию и перезапустил сервис, после чего проверил логи на предмет ошибок. " +
    "Затем возник вопрос? какой формат логов предпочитаете, JSON или обычный текст, и также важно понять, " +
    "нужно ли сохранять историю сообщений за прошлые дни или достаточно текущей.";
  assert.ok(lastSentence.lastIndexOf("?") < lastSentence.length - 80, "`?` далеко от конца, но в хвостовом предложении");
  assert.equal(isQuestionText(lastSentence), true);

  // пустой и не-строковый вход — не вопрос
  assert.equal(isQuestionText(""), false);
  assert.equal(isQuestionText("   "), false);
  assert.equal(isQuestionText(undefined), false);
});

test("test_duration_from_parent_user", () => {
  const messages: ExtractedMessage[] = [
    user("u-first", "ранний шум", 50),
    assistant("a-first", { created: 60, completed: 70, parentID: "u-first" }),
    user("u-parent", "настоящая задача", 1000),
    assistant("a-target", { created: 1100, completed: 4000, parentID: "u-parent" }),
  ];
  const extraction = buildExtraction(
    { id: "s", time: { created: 5 } },
    messages,
    "http://127.0.0.1:4100",
    99999,
  );
  // от time.created родительского user (1000) до assistant.time.completed (4000)
  assert.equal(extraction.durationMs, 3000);
  assert.equal(extraction.assistantMessageID, "a-target");

  // fallback на session.time.created, если parentID не найден
  const noParent = buildExtraction(
    { id: "s", time: { created: 200 } },
    [assistant("a-x", { created: 300, completed: 500, parentID: "missing" })],
    "http://x",
    99999,
  );
  assert.equal(noParent.durationMs, 300);
});
