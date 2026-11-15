// Тесты спринта 3 — детект текстового вопроса → status='question' и баннер ❓.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeBridgeConfig } from "../config.ts";
import { buildExtraction, isQuestionText, type ExtractedMessage } from "../extract.ts";
import { formatDone } from "../format.ts";
import { createLogger } from "../logger.ts";
import { deliver, type NotifyPayload } from "../notify.ts";
import { createRoutes } from "../routes.ts";
import { createBridge, type SessionClient } from "../service.ts";

const DIRECTORY = "/root/projects/opencode-telegram-notifier";
const SERVER_URL = "http://127.0.0.1:4100";
const config = () => makeBridgeConfig({ token: "", chatId: "" });

function messages(
  text: string,
  error?: { name?: string; data?: { message?: string } },
): ExtractedMessage[] {
  return [
    {
      info: { id: "u1", role: "user", time: { created: 1000 } },
      parts: [{ type: "text", text: "Задача из теста" }],
    },
    {
      info: {
        id: "a1",
        role: "assistant",
        parentID: "u1",
        time: { created: 1100, completed: 2100 },
        error,
      },
      parts: [{ type: "text", text }],
    },
  ];
}

const session = { id: "ses1", directory: DIRECTORY, time: { created: 1000 } };

function extract(text: string, error?: { name?: string; data?: { message?: string } }) {
  return buildExtraction(session, messages(text, error), SERVER_URL, 5000);
}

test("test_question_detected", () => {
  const question = extract("Какой приоритет: код или тесты?");
  assert.equal(question.status, "question", "текст с ? → status=question");
  const html = formatDone(
    { status: question.status, task: question.task, result: question.result },
    config(),
  );
  assert.ok(
    html.startsWith("❓ <b>Ассистент ждёт ответа</b>"),
    `заголовок вопроса, получено: ${html.slice(0, 60)}`,
  );
  assert.ok(html.includes("<b>Вопрос:</b>"), "блок «Вопрос:», а не «Итог:»");
  assert.ok(!html.includes("<b>Итог:</b>"));

  // вопрос в конце с хвостовым маркером (реальный формат E2E) тоже детектится
  const withMarker = extract("Какой язык вы используете? QUESTION_NOTIFIED");
  assert.equal(withMarker.status, "question");

  // пустой текст — не вопрос
  assert.equal(isQuestionText(""), false);
  assert.equal(isQuestionText("   "), false);
  assert.equal(isQuestionText(undefined), false);
});

test("test_success_without_question_mark", () => {
  const success = extract("Готово, отчёт собран без вопросов");
  assert.equal(success.status, "success");
  const html = formatDone(
    { status: success.status, task: success.task, result: success.result },
    config(),
  );
  assert.ok(html.startsWith("✅ <b>Задача выполнена</b>"));
  assert.ok(!html.includes("❓"));

  // `?` только в середине длинного ответа (URL/код), хвост утвердительный → НЕ вопрос
  const midOnly = [
    "Я проверил проект: сборка проходит, юнит-тесты зелёные, линтер не ругается.",
    "В запросах используется адрес вида https://api.example.com/v1/items?limit=50&offset=0,",
    "поэтому знак вопроса встречается в URL, но это не вопрос к вам.",
    "Итог: всё работает, правок больше не требуется.",
  ].join(" ");
  assert.ok(midOnly.lastIndexOf("?") < midOnly.length - 80, "в кейсе `?` дальше 80 символов от конца");
  assert.equal(extract(midOnly).status, "success", "срединный `?` при утвердительном хвосте — success");
  assert.equal(extract("Итог: 1 + 1 = 2").status, "success");
});

test("test_question_tail_rule", () => {
  // текст заканчивается на `?` → question
  assert.equal(extract("Какой приоритет: код или тесты?").status, "question");

  // маркер в хвосте после вопроса (живой E2E-формат) → question
  assert.equal(extract("Какой язык вы используете? QUESTION_NOTIFIED").status, "question");

  // `?` в последних 80 символах, последнее «предложение» утвердительное → question
  const tail80 = "Проверь результат? Всё сделано. Готово к сдаче.";
  assert.ok(tail80.lastIndexOf("?") >= tail80.length - 80);
  assert.equal(extract(tail80).status, "question");

  // длинный ответ с `?` в середине и точкой в конце → НЕ question
  const longMid = [
    "Проверил сборку и все тесты, линтер чистый, документация обновлена.",
    "Код использует формат foo?bar=1 в URL запроса, это не вопрос к вам.",
    "Затем перезапустил сервис и убедился, что логи чистые, ошибок нет.",
    "Всё готово, отчёт приложен выше и правок больше не требуется.",
  ].join(" ");
  assert.ok(longMid.lastIndexOf("?") < longMid.length - 80, "в кейсе `?` дальше 80 символов от конца");
  assert.equal(extract(longMid).status, "success");
});

test("test_question_hint_present", () => {
  const question = extract("Продолжить разработку?");
  const html = formatDone(
    { status: question.status, task: question.task, result: question.result },
    config(),
  );
  assert.match(html, /reply/, "подсказка упоминает reply");
  assert.ok(html.includes("Ответьте на это сообщение (reply)"));
  // полный текст вопроса присутствует
  assert.ok(html.includes("Продолжить разработку?"));
});

test("test_abort_beats_question", () => {
  const aborted = extract("А может всё отменить?", {
    name: "MessageAbortedError",
    data: { message: "aborted" },
  });
  assert.equal(aborted.status, "abort", "abort важнее вопроса");
  const html = formatDone(
    { status: aborted.status, task: aborted.task, result: aborted.result, errorMessage: aborted.errorMessage },
    config(),
  );
  assert.ok(html.startsWith("⛔ <b>Запрос прерван</b>"), "заголовок ⛔, а не ❓");
  assert.ok(!html.includes("❓ <b>Ассистент ждёт ответа</b>"));

  // иной assistant.error → error, вопрос тоже не детектится
  const failed = extract("Что пошло не так?", { name: "ProviderError", data: { message: "boom" } });
  assert.equal(failed.status, "error");
  const errorHtml = formatDone(
    { status: failed.status, task: failed.task, result: failed.result, errorMessage: failed.errorMessage },
    config(),
  );
  assert.ok(errorHtml.startsWith("⚠️ <b>Задача завершилась с ошибкой</b>"));
});

test("test_question_disabled_falls_back", async () => {
  // notifyOnQuestion=false → вопрос уходит обычным success-баннером (сервисный уровень)
  const dir = mkdtempSync(join(tmpdir(), "tb-question-"));
  try {
    const configObj = makeBridgeConfig({
      token: "123:TESTTOKEN",
      chatId: "-100123",
      stateDir: dir,
      notifyOnQuestion: false,
    });
    const routes = createRoutes({ stateDir: dir });
    const logFile = join(dir, "notifier.log");
    const logger = createLogger({
      logFile,
      secrets: { token: configObj.token, chatId: configObj.chatId },
      silent: true,
    });
    const sent: string[] = [];
    const client: SessionClient = {
      session: {
        async get() {
          return { data: session };
        },
        async messages() {
          return { data: messages("Какой язык вы используете? QUESTION_NOTIFIED") };
        },
      },
    };
    const bridge = createBridge({
      client,
      directory: DIRECTORY,
      serverUrl: SERVER_URL,
      config: configObj,
      routes,
      logger,
      notify: async (payload: NotifyPayload) => {
        await deliver(payload, {
          config: configObj,
          routes,
          logger,
          sendImpl: async ({ text }) => {
            sent.push(text);
            return { messageId: 6001 };
          },
        });
      },
    });

    await bridge.handleIdle("ses1");

    assert.equal(sent.length, 1);
    assert.ok(sent[0].startsWith("✅ <b>Задача выполнена</b>"), "success-баннер вместо ❓");
    assert.ok(!sent[0].includes("❓ <b>Ассистент ждёт ответа</b>"));
    const log = readFileSync(logFile, "utf8");
    assert.match(log, /event=telegram\.sent/);
    assert.match(log, /status=success/, "в логе status=success, а не question");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
