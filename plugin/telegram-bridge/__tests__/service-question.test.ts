// Тесты спринта question — обработчик question.asked в event-hook:
// отправка с кнопками, дедуп по requestID, disabled, invalid payload,
// never-reject, settle (replied/rejected) + правка сообщения и удаление маршрута.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeBridgeConfig, type BridgeConfig } from "../config.ts";
import { createLogger, type Logger } from "../logger.ts";
import { createRoutes, questionPendingKey, type RoutesStore } from "../routes.ts";
import { createBridge, createEventHooks, type SessionClient } from "../service.ts";
import type { FetchLike, FetchLikeResponse } from "../telegram.ts";

const DIRECTORY = "/root/projects/opencode-telegram-notifier";
const SERVER_URL = "http://127.0.0.1:4100";
const REQUEST_ID = "que_test_1";

type FetchCall = { url: string; body: Record<string, unknown> };

function jsonResponse(status: number, body: unknown): FetchLikeResponse {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function fakeFetch(calls: FetchCall[]): FetchLike {
  return async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) as Record<string, unknown> });
    return jsonResponse(200, { ok: true, result: { message_id: 9000 + calls.length } });
  };
}

function failingFetch(calls: FetchCall[]): FetchLike {
  return async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) as Record<string, unknown> });
    throw new Error("network down");
  };
}

function fakeClient(): SessionClient {
  return {
    session: {
      async get({ path }) {
        return { data: { id: path.id, directory: DIRECTORY } };
      },
      async messages() {
        return { data: [] };
      },
    },
  };
}

function brokenClient(): SessionClient {
  return {
    session: {
      async get() {
        throw new Error("client is down");
      },
      async messages() {
        return { data: [] };
      },
    },
  };
}

type SetupOptions = {
  config?: Partial<BridgeConfig>;
  client?: SessionClient;
  fetchImpl?: FetchLike;
};

type Setup = {
  dir: string;
  routes: RoutesStore;
  logger: Logger;
  calls: FetchCall[];
  hooks: ReturnType<typeof createEventHooks>;
  logText(): string;
};

function setup(options: SetupOptions = {}): Setup {
  const dir = mkdtempSync(join(tmpdir(), "tb-question-"));
  const config = makeBridgeConfig({
    token: "123:TESTTOKEN",
    chatId: "-100123",
    stateDir: dir,
    ...options.config,
  });
  const routes = createRoutes({ stateDir: dir });
  const logFile = join(dir, "notifier.log");
  const logger = createLogger({
    logFile,
    secrets: { token: config.token, chatId: config.chatId },
    silent: true,
  });
  const calls: FetchCall[] = [];
  const bridge = createBridge({
    client: options.client ?? fakeClient(),
    directory: DIRECTORY,
    serverUrl: SERVER_URL,
    config,
    routes,
    logger,
    fetchImpl: options.fetchImpl ?? fakeFetch(calls),
  });
  return {
    dir,
    routes,
    logger,
    calls,
    hooks: createEventHooks({ bridge, logger }),
    logText: () => {
      try {
        return readFileSync(logFile, "utf8");
      } catch {
        return "";
      }
    },
  };
}

type EventPayload = Record<string, unknown> & { sessionID?: string };

function questionProperties(overrides: Record<string, unknown> = {}): EventPayload {
  return {
    id: REQUEST_ID,
    sessionID: "ses1",
    questions: [
      {
        question: "Какой формат конфига?",
        header: "format",
        options: [
          { label: "JSON", description: "структурированный" },
          { label: "YAML", description: "читаемый" },
        ],
        multiple: false,
        custom: false,
      },
    ],
    tool: { messageID: "msg_1", callID: "call_1" },
    ...overrides,
  } as EventPayload;
}

function questionEvent(properties: Record<string, unknown> = {}, type = "question.asked") {
  return { event: { type, properties: questionProperties(properties) } };
}

type KeyboardRow = { text: string; callback_data: string };

function buttons(call: FetchCall): KeyboardRow[] {
  const markup = call.body.reply_markup as { inline_keyboard: KeyboardRow[][] } | undefined;
  assert.ok(markup, "payload содержит reply_markup");
  return markup.inline_keyboard.map((row) => row[0]);
}

test("test_question_sends_buttons_and_routes", async () => {
  const s = setup();
  try {
    await s.hooks.event(questionEvent());

    assert.equal(s.calls.length, 1, "ровно один fetch");
    const call = s.calls[0];
    assert.ok(String(call.url).endsWith("/sendMessage"));
    assert.equal(call.body.parse_mode, "HTML");
    assert.equal(call.body.disable_web_page_preview, true);
    assert.match(String(call.body.text), /❓ <b>Вопрос агента · 1\/1<\/b>/);
    assert.match(String(call.body.text), /JSON — структурированный/);

    const rows = buttons(call);
    const rid = rows[0].callback_data.split(":")[1];
    assert.match(rid, /^[0-9a-f]{12}$/, "rid из 12 hex-символов");
    assert.deepEqual(
      rows.map((b) => b.callback_data),
      [`q:${rid}:0:0`, `q:${rid}:0:1`, `q:${rid}:0:custom`, `q:${rid}:no`],
      "1 вопрос без multiple → варианты + ✍️ Свой ответ + reject, без go",
    );
    assert.deepEqual(
      rows.map((b) => b.text),
      ["JSON", "YAML", "✍️ Свой ответ", "❌ Отклонить"],
    );
    for (const row of rows) {
      assert.ok(Buffer.byteLength(row.callback_data, "utf8") <= 64);
    }
    // подсказка в теле честна для вопроса с вариантами
    assert.match(String(call.body.text), /Ответьте кнопкой/);
    assert.match(String(call.body.text), /Свой ответ/);

    // маршрут questions + messages записаны
    const state = await s.routes.readState();
    const entries = Object.entries(state.questions);
    assert.equal(entries.length, 1, "ровно одна запись questions");
    const [routeRid, route] = entries[0];
    assert.equal(routeRid, rid, "rid из кнопки совпадает с ключом маршрута");
    assert.match(routeRid, /^[0-9a-f]{12}$/);
    assert.equal(route.requestID, REQUEST_ID);
    assert.equal(route.sessionID, "ses1");
    assert.equal(route.serverUrl, SERVER_URL, "serverUrl берётся из PluginInput, не из payload");
    assert.match(route.serverUrl, /^http:\/\/127\.0\.0\.1:[0-9]+$/);
    assert.equal(route.directory, DIRECTORY);
    assert.equal(route.questions.length, 1);
    assert.equal(route.questions[0].options.length, 2);
    assert.equal(route.sequential, true, "маршрут помечен sequential для моста");
    assert.equal(typeof route.createdAt, "number");

    const messageRoute = await s.routes.getMessage(route.messageId);
    assert.ok(messageRoute, "messages[messageId] пишется для текстового reply");
    assert.equal(messageRoute.sessionID, "ses1");

    // файл маршрутов содержит секцию questions
    const raw = JSON.parse(readFileSync(join(s.dir, "routes.json"), "utf8")) as {
      questions: Record<string, { requestID: string }>;
    };
    assert.equal(raw.questions[routeRid].requestID, REQUEST_ID);

    const log = s.logText();
    assert.match(log, /event=question\.received/);
    assert.match(log, /event=question\.sent/);
    assert.match(log, new RegExp(`rid=${rid}`));
    assert.match(log, /message_id=/);
    assert.match(log, /sequential=true/, "лог отправки фиксирует sequential");
    assert.match(log, /questions_count=1/);
    assert.ok(!log.includes("123:TESTTOKEN"), "токен не попадает в лог");
  } finally {
    rmSync(s.dir, { recursive: true, force: true });
  }
});

test("test_question_dedup_by_request_id", async () => {
  const s = setup();
  try {
    await s.hooks.event(questionEvent());
    await s.hooks.event(questionEvent());

    assert.equal(s.calls.length, 1, "второй fetch не выполняется");
    const state = await s.routes.readState();
    assert.equal(Object.keys(state.questions).length, 1, "записана ровно одна запись");
    assert.equal((s.logText().match(/event=question\.sent/g) ?? []).length, 1, "одна отправка");
    assert.match(s.logText(), /reason=duplicate/);
  } finally {
    rmSync(s.dir, { recursive: true, force: true });
  }
});

test("test_question_disabled_no_send", async () => {
  const s = setup({ config: { notifyOnQuestion: false } });
  try {
    await s.hooks.event(questionEvent());
    await s.hooks.event(questionEvent({ id: "que_second" }));

    assert.equal(s.calls.length, 0, "fetch не вызывается при notifyOnQuestion=false");
    const state = await s.routes.readState();
    assert.equal(Object.keys(state.questions).length, 0, "записей нет");
    assert.match(s.logText(), /event=question\.skipped reason=disabled/);
    assert.ok(!s.logText().includes("event=question.sent"));
  } finally {
    rmSync(s.dir, { recursive: true, force: true });
  }

  const off = setup({ config: { enabled: false } });
  try {
    await off.hooks.event(questionEvent());
    assert.equal(off.calls.length, 0, "fetch не вызывается при enabled=false");
    assert.match(off.logText(), /event=question\.skipped reason=disabled/);
  } finally {
    rmSync(off.dir, { recursive: true, force: true });
  }
});

test("test_question_invalid_payload_no_send", async () => {
  const s = setup();
  try {
    // (а) нет id/sessionID → skip до claim, pending не занят
    await s.hooks.event(questionEvent({ id: undefined }));
    await s.hooks.event(questionEvent({ sessionID: undefined }));
    assert.equal(s.calls.length, 0, "без id отправки нет");
    assert.match(s.logText(), /event=question\.skipped reason=missing_fields/);

    // (б) есть id, но questions — не массив/битые → invalid_questions + pending снят
    await s.hooks.event(questionEvent({ questions: "не массив" }));
    await s.hooks.event(questionEvent({ id: "que_bad_2", questions: [{ options: [] }] }));
    await s.hooks.event(questionEvent({ id: "que_bad_3", questions: [] }));
    assert.equal(s.calls.length, 0, "битый payload не отправляется");
    assert.match(s.logText(), /reason=invalid_questions/);

    const state = await s.routes.readState();
    assert.equal(Object.keys(state.questions).length, 0, "маршруты не записаны");
    for (const id of [REQUEST_ID, "que_bad_2", "que_bad_3"]) {
      assert.equal(state.pending[questionPendingKey(id)], undefined, `pending по ${id} снят`);
      assert.equal(
        await s.routes.claimQuestion(id),
        "claimed",
        `после сбоя ${id} можно заново claim-нуть`,
      );
    }
  } finally {
    rmSync(s.dir, { recursive: true, force: true });
  }
});

test("test_question_event_never_rejects", async () => {
  // (а) fetch бросает исключение (клиент исправен) — записи после неудачной отправки нет
  const brokenCalls: FetchCall[] = [];
  const s1 = setup({ fetchImpl: failingFetch(brokenCalls), config: { retries: 0 } });
  try {
    await assert.doesNotReject(
      () => s1.hooks.event(questionEvent({ id: "que_broken_fetch" })),
      "event-hook не должен отклоняться при падении fetch",
    );
    assert.match(s1.logText(), /event=question\.failed/);
    assert.ok(brokenCalls.length >= 1, "fetch действительно вызывался и упал");
    const state1 = await s1.routes.readState();
    assert.equal(Object.keys(state1.questions).length, 0, "осиротевшей записи нет");
    assert.equal(
      state1.pending[questionPendingKey("que_broken_fetch")],
      undefined,
      "pending снят после ошибки",
    );
    assert.ok(!s1.logText().includes("123:TESTTOKEN"), "токен не в логе ошибки");

    // повторный event после сбоя проходит заново (pending снят, маршрута нет)
    await s1.hooks.event(questionEvent({ id: "que_broken_fetch" }));
    assert.equal(brokenCalls.length, 2, "повтор после сбоя дошёл до telegram");
  } finally {
    rmSync(s1.dir, { recursive: true, force: true });
  }

  // (б) client.session.get бросает — вопрос всё равно уходит в Telegram
  // с fallback-directory: иначе процесс, выигравший claim, «съедал» событие.
  const clientCalls: FetchCall[] = [];
  const s2 = setup({ client: brokenClient(), fetchImpl: fakeFetch(clientCalls) });
  try {
    await assert.doesNotReject(
      () => s2.hooks.event(questionEvent({ id: "que_broken_client" })),
      "event-hook не должен отклоняться",
    );
    assert.equal(clientCalls.length, 1, "вопрос доставлен несмотря на сбой session.get");
    assert.match(s2.logText(), /event=question\.session_lookup_failed/);
    assert.ok(!s2.logText().includes("event=question.failed"));
    const route = await s2.routes.getQuestionByRequestID("que_broken_client");
    assert.ok(route, "маршрут записан с fallback-directory");
    assert.equal(route.route.directory, DIRECTORY);
    assert.equal(
      (await s2.routes.readState()).pending[questionPendingKey("que_broken_client")],
      undefined,
      "pending снят после успешной отправки",
    );
  } finally {
    rmSync(s2.dir, { recursive: true, force: true });
  }

  // (в) событие без properties и не-question события игнорируются
  const s3 = setup();
  try {
    await assert.doesNotReject(() => s3.hooks.event({ event: { type: "question.asked" } }));
    await assert.doesNotReject(() => s3.hooks.event({ event: { type: "session.status" } }));
    assert.equal(s3.calls.length, 0, "без id/sessionID отправки нет");
    assert.match(s3.logText(), /event=question\.skipped/);
  } finally {
    rmSync(s3.dir, { recursive: true, force: true });
  }
});

test("test_question_prefers_event_location_when_session_get_fails", async () => {
  const s = setup({ client: brokenClient() });
  try {
    await s.hooks.event(
      questionEvent({
        id: "que_event_location",
        location: { directory: "/root/projects/event-dir" },
      }),
    );
    const found = await s.routes.getQuestionByRequestID("que_event_location");
    assert.ok(found, "маршрут записан");
    assert.equal(
      found.route.directory,
      "/root/projects/event-dir",
      "location из form.created важнее каталога плагина",
    );
  } finally {
    rmSync(s.dir, { recursive: true, force: true });
  }
});

test("test_question_v2_asked_from_data", async () => {
  const s = setup();
  try {
    // v2-событие приходит с полем data вместо properties
    await s.hooks.event({
      event: { type: "question.v2.asked", data: questionProperties({ id: "que_v2_1" }) },
    });

    assert.equal(s.calls.length, 1, "v2-событие отправляется");
    assert.match(String(s.calls[0].body.text), /❓ <b>Вопрос агента · 1\/1<\/b>/);
    assert.match(s.logText(), /event=question\.received etype=question\.v2\.asked/);
    const route = await s.routes.getQuestionByRequestID("que_v2_1");
    assert.ok(route, "маршрут записан по v2-событию");
    assert.equal(route.route.sessionID, "ses1");
  } finally {
    rmSync(s.dir, { recursive: true, force: true });
  }
});

test("test_question_multi_sends_only_q1_sequential", async () => {
  const s = setup();
  try {
    await s.hooks.event(
      questionEvent({
        id: "que_multi_1",
        questions: [
          {
            question: "Первый?",
            header: "one",
            options: [
              { label: "A", description: "" },
              { label: "B", description: "" },
            ],
            multiple: false,
            custom: false,
          },
          {
            question: "Второй?",
            header: "two",
            options: [{ label: "C", description: "" }],
            multiple: true,
            custom: false,
          },
          { question: "Третий?", header: "three", options: [], multiple: false, custom: true },
        ],
      }),
    );

    assert.equal(s.calls.length, 1, "плагин отправляет ровно одно сообщение — Q1");
    const text = String(s.calls[0].body.text);
    assert.match(text, /❓ <b>Вопрос агента · 1\/3<\/b>/);
    assert.match(text, /Первый\?/);
    assert.ok(!text.includes("Второй?"), "Q2 отправляет мост, не плагин");
    assert.ok(!text.includes("Третий?"), "Q3 отправляет мост, не плагин");

    const rows = buttons(s.calls[0]);
    const rid = rows[0].callback_data.split(":")[1];
    assert.deepEqual(
      rows.map((row) => row.callback_data),
      [`q:${rid}:0:0`, `q:${rid}:0:1`, `q:${rid}:0:custom`, `q:${rid}:no`],
      "Q1: qi=0, без commit/go; multiple второго вопроса на клавиатуру Q1 не влияет",
    );

    const found = await s.routes.getQuestionByRequestID("que_multi_1");
    assert.ok(found, "маршрут записан");
    assert.equal(found.route.sequential, true, "sequential:true в маршруте");
    assert.equal(found.route.questions.length, 3, "в маршруте ВСЕ вопросы формы");
    assert.equal(found.route.questions[1].multiple, true);
    assert.equal(found.route.fieldIndex, undefined, "route-level fieldIndex только для одиночного");
    assert.match(s.logText(), /event=question\.sent .*questions_count=3/);
  } finally {
    rmSync(s.dir, { recursive: true, force: true });
  }
});

test("test_question_multiple_keyboard_has_commit", async () => {
  const s = setup();
  try {
    await s.hooks.event(
      questionEvent({
        id: "que_multiple_1",
        questions: [
          {
            question: "Выбери несколько?",
            header: "",
            options: [
              { label: "X", description: "" },
              { label: "Y", description: "" },
            ],
            multiple: true,
            custom: false,
          },
        ],
      }),
    );
    assert.equal(s.calls.length, 1);
    const rows = buttons(s.calls[0]);
    const rid = rows[0].callback_data.split(":")[1];
    assert.deepEqual(
      rows.map((row) => row.callback_data),
      [`q:${rid}:0:0`, `q:${rid}:0:1`, `q:${rid}:0:custom`, `q:${rid}:0:commit`, `q:${rid}:no`],
      "multiple → ✅ Готово; агрегированной q:<rid>:go нет",
    );
  } finally {
    rmSync(s.dir, { recursive: true, force: true });
  }
});

// --- fieldIndex: выравнивание questions ↔ raw form.fields ---

test("test_question_field_index_survives_normalization", async () => {
  const s = setup();
  try {
    // v2-стиль: fieldIndex приходит из fieldsToQuestions и должен дойти до routes.json
    await s.hooks.event(
      questionEvent({
        id: "que_fieldidx_1",
        questions: [
          {
            question: "Первый?",
            header: "",
            options: [{ label: "A", description: "" }],
            multiple: false,
            custom: false,
            fieldIndex: 4,
          },
        ],
      }),
    );
    const found = await s.routes.getQuestionByRequestID("que_fieldidx_1");
    assert.ok(found, "маршрут записан");
    assert.equal(found.route.questions[0].fieldIndex, 4, "fieldIndex сохранён normalizeQuestions");
    assert.equal(found.route.fieldIndex, 4, "одиночный вопрос дублируется в QuestionRoute.fieldIndex");

    // битые значения fieldIndex (отрицательное/строка) не сохраняются
    await s.hooks.event(
      questionEvent({
        id: "que_fieldidx_2",
        questions: [
          { question: "Второй?", header: "", options: [], custom: true, fieldIndex: -1 },
          { question: "Третий?", header: "", options: [], custom: true, fieldIndex: "3" },
        ],
      }),
    );
    const found2 = await s.routes.getQuestionByRequestID("que_fieldidx_2");
    assert.ok(found2, "маршрут записан");
    assert.equal(found2.route.questions[0].fieldIndex, undefined, "-1 отброшен");
    assert.equal(found2.route.questions[1].fieldIndex, undefined, "строка отброшена");
    assert.equal(found2.route.fieldIndex, undefined, "несколько вопросов → route-level не пишется");

    // событие без fieldIndex (v1) → запись читается как раньше
    await s.hooks.event(questionEvent({ id: "que_fieldidx_3" }));
    const found3 = await s.routes.getQuestionByRequestID("que_fieldidx_3");
    assert.ok(found3);
    assert.equal(found3.route.questions[0].fieldIndex, undefined);
    assert.equal(found3.route.fieldIndex, undefined);
  } finally {
    rmSync(s.dir, { recursive: true, force: true });
  }
});

test("test_question_custom_without_options_hint_and_buttons", async () => {
  const s = setup();
  try {
    await s.hooks.event(
      questionEvent({
        id: "que_custom_1",
        questions: [{ question: "Свободный вопрос?", header: "", options: [], multiple: false, custom: true }],
      }),
    );
    assert.equal(s.calls.length, 1, "вопрос отправлен");
    const text = String(s.calls[0].body.text);
    assert.match(text, /Напишите ответ текстом \(reply на это сообщение\)/, "подсказка честна для custom");
    assert.ok(!text.includes("Ответьте кнопкой"), "кнопки не обещаются");

    // без вариантов: ✍️ «Свой ответ» остаётся по контракту Q1, затем reject
    // (агрегированной кнопки ✅ Ответить нет — форму ведёт мост)
    const rows = buttons(s.calls[0]);
    const rid = rows[0].callback_data.split(":")[1];
    assert.deepEqual(
      rows.map((row) => row.callback_data),
      [`q:${rid}:0:custom`, `q:${rid}:no`],
    );
  } finally {
    rmSync(s.dir, { recursive: true, force: true });
  }
});

// --- settle: question.replied / question.rejected ---

async function sendFirst(s: Setup): Promise<{ rid: string; messageId: number }> {
  await s.hooks.event(questionEvent({ id: "que_settle_1" }));
  const found = await s.routes.getQuestionByRequestID("que_settle_1");
  assert.ok(found, "маршрут должен быть записан после отправки");
  return { rid: found.rid, messageId: found.route.messageId };
}

test("test_question_settled_replied_edits_and_removes", async () => {
  const s = setup();
  try {
    const { messageId } = await sendFirst(s);
    assert.equal(s.calls.length, 1);

    await s.hooks.event({
      event: {
        type: "question.replied",
        properties: {
          sessionID: "ses1",
          requestID: "que_settle_1",
          answers: [["JSON"], ["YAML"]],
        },
      },
    });

    assert.equal(s.calls.length, 2, "ровно один edit-запрос");
    const edit = s.calls[1];
    assert.ok(String(edit.url).endsWith("/editMessageText"));
    assert.equal(edit.body.message_id, messageId);
    assert.equal(edit.body.parse_mode, "HTML");
    assert.equal(edit.body.reply_markup, undefined, "без reply_markup — кнопки исчезают");
    assert.match(String(edit.body.text), /<b>✅ Вопрос отвечен<\/b>/);
    assert.match(String(edit.body.text), /Ответ: JSON/, "для sequential показывается ответ qi=0");

    const state = await s.routes.readState();
    assert.equal(Object.keys(state.questions).length, 0, "маршрут questions удалён");
    assert.ok(await s.routes.getMessage(messageId), "маршрут messages остаётся для reply");
    assert.match(s.logText(), /event=question\.settled action=replied handled=true/);
  } finally {
    rmSync(s.dir, { recursive: true, force: true });
  }
});

test("test_question_settled_is_idempotent_across_duplicate_events", async () => {
  const s = setup();
  try {
    await sendFirst(s);
    const event = {
      event: {
        type: "question.replied",
        properties: {
          sessionID: "ses1",
          requestID: "que_settle_1",
          answers: [["JSON"]],
        },
      },
    };

    await s.hooks.event(event);
    assert.equal(s.calls.length, 2, "первый settle сделал ровно один edit");

    // Дубли события от других подписчиков не должны снова править сообщение
    // (иначе Telegram получает десятки edit и упирается в rate limit).
    await s.hooks.event(event);
    assert.equal(s.calls.length, 2, "повторный settle не делает лишних запросов");
    assert.match(s.logText(), /event=question\.settled action=replied handled=false/);
  } finally {
    rmSync(s.dir, { recursive: true, force: true });
  }
});

test("test_question_settled_rejected_edits_and_removes", async () => {
  const s = setup();
  try {
    const { messageId } = await sendFirst(s);

    await s.hooks.event({
      event: {
        type: "question.v2.rejected",
        data: { sessionID: "ses1", requestID: "que_settle_1" },
      },
    });

    assert.equal(s.calls.length, 2, "edit-запрос выполнен");
    const edit = s.calls[1];
    assert.ok(String(edit.url).endsWith("/editMessageText"));
    assert.equal(edit.body.message_id, messageId);
    assert.match(String(edit.body.text), /<b>❌ Вопрос отклонён<\/b>/);
    const state = await s.routes.readState();
    assert.equal(Object.keys(state.questions).length, 0, "маршрут questions удалён");
    assert.equal(await s.routes.getQuestionByRequestID("que_settle_1"), undefined);
    assert.match(s.logText(), /event=question\.settled action=rejected handled=true/);
  } finally {
    rmSync(s.dir, { recursive: true, force: true });
  }
});

test("test_question_settled_sequential_edits_only_q1", async () => {
  const s = setup();
  try {
    await s.hooks.event(
      questionEvent({
        id: "que_settle_seq",
        questions: [
          {
            question: "Первый?",
            header: "",
            options: [
              { label: "JSON", description: "" },
              { label: "YAML", description: "" },
            ],
            multiple: false,
            custom: false,
          },
          {
            question: "Второй?",
            header: "",
            options: [{ label: "C", description: "" }],
            multiple: false,
            custom: false,
          },
        ],
      }),
    );
    const found = await s.routes.getQuestionByRequestID("que_settle_seq");
    assert.ok(found, "маршрут записан");
    assert.equal(s.calls.length, 1, "отправлен только Q1");

    await s.hooks.event({
      event: {
        type: "question.replied",
        properties: {
          sessionID: "ses1",
          requestID: "que_settle_seq",
          answers: [["JSON"], ["C"]],
        },
      },
    });

    assert.equal(s.calls.length, 2, "ровно один edit — Q1; Q2..QN правит мост");
    const edit = s.calls[1];
    assert.ok(String(edit.url).endsWith("/editMessageText"));
    assert.equal(edit.body.message_id, found.route.messageId, "правится messageId Q1");
    assert.match(String(edit.body.text), /<b>✅ Вопрос отвечен<\/b>/);
    assert.match(String(edit.body.text), /JSON/, "ответ qi=0 в тексте");
    assert.ok(!String(edit.body.text).includes("C"), "ответ Q2 в правку Q1 не попадает");
    assert.equal(edit.body.reply_markup, undefined, "кнопки исчезают");

    const state = await s.routes.readState();
    assert.equal(Object.keys(state.questions).length, 0, "маршрут questions удалён");
    assert.match(s.logText(), /event=question\.settled .*sequential=true/);
  } finally {
    rmSync(s.dir, { recursive: true, force: true });
  }
});

test("test_question_settled_sequential_v2_answer_qi0", async () => {
  const s = setup();
  try {
    await s.hooks.event(
      questionEvent({
        id: "que_settle_seq_v2",
        fields: [
          { key: "other", title: "other", options: [{ value: "zzz", label: "ZZZ" }] },
          { key: "format", title: "format", options: [{ value: "yaml", label: "YAML" }] },
        ],
        questions: [
          {
            question: "Формат?",
            header: "format",
            options: [{ label: "YAML", description: "" }],
            multiple: false,
            custom: false,
            fieldIndex: 1,
          },
          { question: "Второй?", header: "", options: [], multiple: false, custom: true },
        ],
      }),
    );
    const found = await s.routes.getQuestionByRequestID("que_settle_seq_v2");
    assert.ok(found);

    await s.hooks.event({
      event: {
        type: "question.v2.replied",
        data: {
          sessionID: "ses1",
          requestID: "que_settle_seq_v2",
          answer: { other: "zzz", format: "yaml" },
        },
      },
    });

    assert.equal(s.calls.length, 2, "один edit Q1");
    const text = String(s.calls[1].body.text);
    assert.match(text, /YAML/, "метка значения поля Q1 (fieldIndex=1)");
    assert.ok(!text.includes("ZZZ"), "ответ другого поля не показывается");
    assert.equal(await s.routes.getQuestionByRequestID("que_settle_seq_v2"), undefined);
  } finally {
    rmSync(s.dir, { recursive: true, force: true });
  }
});

test("test_question_settled_legacy_route_edits_all_answers", async () => {
  const s = setup();
  try {
    // legacy-маршрут без sequential (запись старого формата) — поведение прежнее
    await s.routes.recordQuestion("abcdefabcdef", {
      sessionID: "ses1",
      requestID: "que_legacy",
      serverUrl: SERVER_URL,
      directory: DIRECTORY,
      messageId: 7000,
      questions: [
        { question: "Первый?", header: "", options: [], multiple: false, custom: true },
        { question: "Второй?", header: "", options: [], multiple: false, custom: true },
      ],
      createdAt: Date.now(),
    });

    await s.hooks.event({
      event: {
        type: "question.replied",
        properties: { sessionID: "ses1", requestID: "que_legacy", answers: [["A"], ["B"]] },
      },
    });

    assert.equal(s.calls.length, 1, "legacy: один edit");
    assert.equal(s.calls[0].body.message_id, 7000);
    assert.match(String(s.calls[0].body.text), /A, B/, "legacy показывает все ответы");
    assert.equal(await s.routes.getQuestionByRequestID("que_legacy"), undefined);
    assert.match(s.logText(), /event=question\.settled .*sequential=false/);
  } finally {
    rmSync(s.dir, { recursive: true, force: true });
  }
});

test("test_question_settled_without_route_handled_false", async () => {
  const s = setup();
  try {
    await s.hooks.event({
      event: {
        type: "question.replied",
        properties: { sessionID: "ses1", requestID: "que_unknown_1", answers: [["A"]] },
      },
    });

    assert.equal(s.calls.length, 0, "без маршрута editMessageText не вызывается");
    assert.match(
      s.logText(),
      /event=question\.settled action=replied handled=false/,
      "ответ уже обработан бриджем",
    );
    assert.ok(!s.logText().includes("event=question.failed"));
  } finally {
    rmSync(s.dir, { recursive: true, force: true });
  }
});

test("test_question_settled_edit_failure_still_removes", async () => {
  // успешная отправка, затем editMessageText падает (401 без повторов)
  const calls: FetchCall[] = [];
  let failEdit = false;
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) as Record<string, unknown> });
    if (failEdit) {
      return jsonResponse(401, { ok: false, error_code: 401, description: "Unauthorized" });
    }
    return jsonResponse(200, { ok: true, result: { message_id: 9100 + calls.length } });
  };
  const s = setup({ fetchImpl, config: { retries: 0 } });
  try {
    await sendFirst(s);
    failEdit = true;

    await assert.doesNotReject(
      () =>
        s.hooks.event({
          event: {
            type: "question.replied",
            properties: { sessionID: "ses1", requestID: "que_settle_1", answers: [["JSON"]] },
          },
        }),
      "сбой edit не должен ронять event-hook",
    );

    assert.equal(await s.routes.getQuestionByRequestID("que_settle_1"), undefined, "маршрут удалён");
    assert.match(s.logText(), /event=question\.failed/);
    assert.match(s.logText(), /event=question\.settled action=replied handled=true/);
    assert.ok(!s.logText().includes("123:TESTTOKEN"), "токен не в логе ошибки");
  } finally {
    rmSync(s.dir, { recursive: true, force: true });
  }
});
