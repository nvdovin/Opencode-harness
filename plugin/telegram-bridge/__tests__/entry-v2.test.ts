// Тесты точки входа v2: трансляция событий opencode v2 → внутренние события
// service.ts, маппинг сообщений/сессий v2 → типы extract.ts, полей формы → кнопок.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  fetchPendingForms,
  fieldsToQuestions,
  formToQuestionEvent,
  resolvePassword,
  resetPasswordCache,
  toBridgeEvent,
  toExtractedMessages,
  toExtractedSession,
} from "../../telegram-bridge.ts";

type Ctx = {
  session?: { get?: (input: { sessionID: string }) => Promise<unknown> };
};

/** Контекст без session.get — события, требующие сессии, отрабатывают деградацией. */
const bareContext: Ctx = {};

// --- session.idle ---

test("test_idle_event_maps_data_to_properties", async () => {
  const translated = await toBridgeEvent(bareContext, {
    type: "session.idle",
    data: { sessionID: "ses_abc" },
  });
  assert.deepEqual(translated, { type: "session.idle", properties: { sessionID: "ses_abc" } });
});

test("test_idle_event_without_session_is_dropped", async () => {
  assert.equal(await toBridgeEvent(bareContext, { type: "session.idle", data: {} }), undefined);
  assert.equal(await toBridgeEvent(bareContext, { type: "session.idle" }), undefined);
});

// --- permission.asked ---

test("test_permission_asked_maps_v2_payload", async () => {
  const translated = await toBridgeEvent(bareContext, {
    type: "permission.asked",
    data: {
      id: "per_1",
      sessionID: "ses_abc",
      action: "edit",
      resources: ["/root/a.ts", "/root/b.ts"],
      metadata: { filepath: "/root/a.ts" },
      message: "Изменить файл",
    },
  });
  assert.ok(translated);
  assert.equal(translated.type, "permission.asked");
  assert.equal(translated.properties.id, "per_1");
  assert.equal(translated.properties.sessionID, "ses_abc");
  // v1-обработатель читает permission/patterns/title — именно они нужны
  assert.equal(translated.properties.permission, "edit");
  assert.deepEqual(translated.properties.patterns, ["/root/a.ts", "/root/b.ts"]);
  assert.equal(translated.properties.title, "Изменить файл");
  assert.deepEqual(translated.properties.metadata, { filepath: "/root/a.ts" });
});

test("test_permission_asked_minimal_payload", async () => {
  const translated = await toBridgeEvent(bareContext, {
    type: "permission.asked",
    data: { id: "per_2", sessionID: "ses_abc" },
  });
  assert.ok(translated);
  assert.equal(translated.properties.id, "per_2");
  assert.equal(translated.properties.permission, undefined, "action отсутствует → не добавляем");
  assert.equal(translated.properties.patterns, undefined);
});

test("test_permission_asked_requires_id_and_session", async () => {
  assert.equal(
    await toBridgeEvent(bareContext, { type: "permission.asked", data: { sessionID: "s" } }),
    undefined,
  );
  assert.equal(
    await toBridgeEvent(bareContext, { type: "permission.asked", data: { id: "p" } }),
    undefined,
  );
});

// --- form.created → question.asked ---

const FIELDS = [
  {
    key: "first",
    type: "multiselect",
    title: "Первый",
    // v2 question: title = короткий header, description = текст вопроса
    description: "Первый вопрос",
    options: [
      { value: "a", label: "Вариант A", description: "перый" },
      { value: "b", label: "Вариант B" },
    ],
  },
  { key: "second", type: "string", title: "Второй вопрос" },
];

test("test_form_created_becomes_question_asked", async () => {
  const translated = await toBridgeEvent(bareContext, {
    type: "form.created",
    data: {
      form: { id: "frm_1", sessionID: "ses_abc", title: "Опрос", fields: FIELDS },
      location: { directory: "/root/projects/x" },
    },
  });
  assert.ok(translated);
  assert.equal(translated.type, "question.asked");
  // id → requestID формы: по нему бридж строит /api/session/<sid>/form/<formID>/reply
  assert.equal(translated.properties.id, "frm_1");
  assert.equal(translated.properties.sessionID, "ses_abc");
  assert.deepEqual(translated.properties.fields, FIELDS, "raw-поля формы сохраняются для ответа");
  assert.deepEqual(
    translated.properties.location,
    { directory: "/root/projects/x" },
    "location из form.created — fallback, если session.get недоступен",
  );

  const questions = translated.properties.questions as Array<Record<string, unknown>>;
  assert.equal(questions.length, 2);
  assert.equal(questions[0].question, "Первый вопрос", "description — текст вопроса агента");
  assert.equal(questions[0].header, "Первый", "title — короткий header");
  assert.equal(questions[0].multiple, true, "multiselect → multiple");
  assert.equal(questions[0].custom, false, "есть варианты → не custom");
  assert.deepEqual(questions[0].options, [
    { label: "Вариант A", description: "перый" },
    { label: "Вариант B", description: "" },
  ]);
  assert.equal(questions[1].question, "Второй вопрос", "нет description → fallback на title");
  assert.equal(questions[1].header, "", "без description header не дублирует вопрос");
  assert.equal(questions[1].custom, true, "строка без вариантов → текстовый ответ");
});

test("test_form_to_question_event_matches_form_created", () => {
  const translated = formToQuestionEvent(
    { id: "frm_2", sessionID: "ses_abc", title: "Опрос", fields: FIELDS },
    { directory: "/root/projects/y" },
  );
  assert.ok(translated);
  assert.equal(translated.type, "question.asked");
  assert.equal(translated.properties.id, "frm_2");
  assert.deepEqual(translated.properties.location, { directory: "/root/projects/y" });
  const questions = translated.properties.questions as Array<Record<string, unknown>>;
  assert.equal(questions[0].question, "Первый вопрос");
  assert.equal(questions[0].header, "Первый");
  assert.equal(formToQuestionEvent({ id: "", sessionID: "s", fields: FIELDS }), undefined);
  assert.equal(formToQuestionEvent({ id: "f", sessionID: "s", fields: [] }), undefined);
});

test("test_fetch_pending_forms_queries_location_with_auth", async () => {
  const saved = process.env.OPENCODE_PASSWORD;
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  try {
    resetPasswordCache();
    process.env.OPENCODE_PASSWORD = "secret-pass";
    const forms = await fetchPendingForms("http://127.0.0.1:4100/", "/root/proj x", (async (url, init) => {
      calls.push({
        url: String(url),
        headers: (init?.headers ?? {}) as Record<string, string>,
      });
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: [{ id: "frm_1" }] }),
      };
    }) as unknown as typeof fetch);
    assert.deepEqual(forms, [{ id: "frm_1" }]);
    assert.equal(calls.length, 1);
    assert.equal(
      calls[0].url,
      "http://127.0.0.1:4100/api/form?location%5Bdirectory%5D=%2Froot%2Fproj%20x",
      "слэш в конце serverUrl не даёт двойного //",
    );
    assert.equal(
      calls[0].headers.authorization,
      `Basic ${Buffer.from("opencode:secret-pass", "utf8").toString("base64")}`,
      "запрос авторизован тем же паролем, что и message API",
    );

    await assert.rejects(
      () =>
        fetchPendingForms("http://127.0.0.1:4100", "/root", (async () => ({
          ok: false,
          status: 500,
          json: async () => ({}),
        })) as unknown as typeof fetch),
      /opencode: forms http 500/,
    );
  } finally {
    if (saved === undefined) delete process.env.OPENCODE_PASSWORD;
    else process.env.OPENCODE_PASSWORD = saved;
    resetPasswordCache();
  }
});

test("test_form_created_requires_form_and_id", async () => {
  assert.equal(await toBridgeEvent(bareContext, { type: "form.created", data: {} }), undefined);
  assert.equal(
    await toBridgeEvent(bareContext, { type: "form.created", data: { form: { sessionID: "s" } } }),
    undefined,
  );
  assert.equal(
    await toBridgeEvent(bareContext, {
      type: "form.created",
      data: { form: { id: "f", sessionID: "s", fields: [] } },
    }),
    undefined,
    "форма без валидных полей не даёт кнопок → событие не нужно",
  );
});

// --- form.replied / form.cancelled ---

test("test_form_replied_becomes_question_replied", async () => {
  const translated = await toBridgeEvent(bareContext, {
    type: "form.replied",
    data: { id: "frm_1", sessionID: "ses_abc", answer: { first: "a", second: "текст" } },
  });
  assert.ok(translated);
  assert.equal(translated.type, "question.replied");
  assert.equal(translated.properties.requestID, "frm_1");
  assert.equal(translated.properties.sessionID, "ses_abc");
  assert.deepEqual(translated.properties.answer, { first: "a", second: "текст" });
});

test("test_form_cancelled_becomes_question_rejected", async () => {
  const translated = await toBridgeEvent(bareContext, {
    type: "form.cancelled",
    data: { id: "frm_1", sessionID: "ses_abc" },
  });
  assert.ok(translated);
  assert.equal(translated.type, "question.rejected");
  assert.equal(translated.properties.requestID, "frm_1");
  assert.equal(translated.properties.sessionID, "ses_abc");
});

// --- session.created ---

test("test_session_created_enriches_from_session_get", async () => {
  const context: Ctx = {
    session: {
      async get() {
        return {
          id: "ses_child",
          parentID: "ses_parent",
          title: "Дочерняя",
          location: { directory: "/root/projects/x" },
          time: { created: 1700000000000 },
        };
      },
    },
  };
  const translated = await toBridgeEvent(context, {
    type: "session.created",
    data: { sessionID: "ses_child", location: { directory: "/root" } },
  });
  assert.ok(translated);
  assert.equal(translated.type, "session.created");
  const info = translated.properties.info as Record<string, unknown>;
  assert.equal(info.id, "ses_child");
  assert.equal(info.parentID, "ses_parent", "parentID нужен для детекта child-сессии");
  assert.equal(info.title, "Дочерняя");
  assert.equal(info.directory, "/root/projects/x", "directory берётся из самой сессии");
});

test("test_session_created_without_session_get_falls_back_to_event", async () => {
  const translated = await toBridgeEvent(bareContext, {
    type: "session.created",
    data: { sessionID: "ses_new", location: { directory: "/root" } },
  });
  assert.ok(translated);
  const info = translated.properties.info as Record<string, unknown>;
  assert.equal(info.id, "ses_new");
  assert.equal(info.directory, "/root");
  assert.equal(info.parentID, undefined);
});

test("test_session_created_survives_failing_session_get", async () => {
  const context: Ctx = {
    session: {
      async get() {
        throw new Error("boom");
      },
    },
  };
  const translated = await toBridgeEvent(context, {
    type: "session.created",
    data: { sessionID: "ses_x", location: { directory: "/root" } },
  });
  assert.ok(translated, "ошибка session.get не должна ронять трансляцию");
  assert.equal((translated.properties.info as Record<string, unknown>).id, "ses_x");
});

// --- отбраковка ---

test("test_unknown_and_malformed_events_are_dropped", async () => {
  assert.equal(await toBridgeEvent(bareContext, { type: "provider.updated", data: {} }), undefined);
  assert.equal(await toBridgeEvent(bareContext, { type: "session.tool.delta" }), undefined);
  assert.equal(await toBridgeEvent(bareContext, undefined), undefined);
  assert.equal(await toBridgeEvent(bareContext, "not-an-object"), undefined);
  assert.equal(await toBridgeEvent(bareContext, {}), undefined);
});

// --- toExtractedMessages ---

test("test_assistant_message_mapping", () => {
  const [message] = toExtractedMessages(
    [
      {
        id: "msg_1",
        type: "assistant",
        time: { created: 100, completed: 200 },
        model: { id: "mimo-v2.6-flash", providerID: "opencode-go" },
        content: [
          { type: "reasoning", text: "рассуждаю" },
          { type: "text", text: "готово" },
        ],
      },
    ],
    undefined,
  );
  assert.ok(message);
  assert.equal(message.info.id, "msg_1");
  assert.equal(message.info.role, "assistant", "v2 type → v1 role");
  assert.equal(message.info.time?.completed, 200);
  assert.equal(message.info.providerID, "opencode-go");
  assert.equal(message.info.modelID, "mimo-v2.6-flash");
  assert.equal(message.info.error, undefined);
  // content передаётся как есть: joinTextParts возьмёт только type==="text"
  assert.equal((message.parts ?? []).length, 2);
});

test("test_user_message_parts_from_text_field", () => {
  const [message] = toExtractedMessages(
    [{ id: "msg_u", type: "user", time: { created: 1 }, text: "сделай отчёт" }],
    undefined,
  );
  assert.ok(message);
  assert.equal(message.info.role, "user");
  assert.deepEqual(message.parts, [{ type: "text", text: "сделай отчёт" }]);
});

test("test_message_error_passthrough_and_finish_error", () => {
  const messages = toExtractedMessages(
    [
      { id: "m1", type: "assistant", time: { created: 1 }, error: { name: "ProviderAuthError" } },
      { id: "m2", type: "assistant", time: { created: 2 }, finish: "error" },
    ],
    undefined,
  );
  assert.equal(messages[0].info.error?.name, "ProviderAuthError", "ошибка v2 сохраняется");
  assert.equal(messages[1].info.error?.name, "AssistantError", "finish=error → ошибка");
});

test("test_outcome_failed_injects_error_on_latest_assistant", () => {
  const messages = toExtractedMessages(
    [
      { id: "m1", type: "user", time: { created: 1 }, text: "задача" },
      { id: "m2", type: "assistant", time: { created: 2, completed: 100 }, content: [] },
      { id: "m3", type: "assistant", time: { created: 3, completed: 300 }, content: [] },
    ],
    "failed",
  );
  assert.equal(messages[1].info.error, undefined, "старое сообщение не трогаем");
  assert.equal(messages[2].info.error?.name, "AssistantError", "ошибка доставляется последнему");
});

test("test_outcome_interrupted_maps_to_aborted", () => {
  const messages = toExtractedMessages(
    [
      { id: "m1", type: "assistant", time: { created: 1, completed: 100 }, content: [] },
      { id: "m2", type: "assistant", time: { created: 2, completed: 200 }, content: [] },
    ],
    "interrupted",
  );
  assert.equal(messages[0].info.error, undefined);
  assert.equal(messages[1].info.error?.name, "MessageAbortedError", "interrupted → abort");
});

test("test_outcome_success_does_not_inject_error_and_keeps_existing", () => {
  const messages = toExtractedMessages(
    [
      { id: "m1", type: "assistant", time: { created: 1, completed: 100 }, error: { name: "X" } },
      { id: "m2", type: "assistant", time: { created: 2, completed: 200 }, content: [] },
    ],
    "succeeded",
  );
  assert.equal(messages[0].info.error?.name, "X", "существующая ошибка не затирается");
  assert.equal(messages[1].info.error, undefined);
});

test("test_malformed_messages_are_skipped", () => {
  const messages = toExtractedMessages(
    [null, "string", { type: "assistant" }, { id: "ok", type: "assistant", content: [] }],
    undefined,
  );
  assert.equal(messages.length, 1, "без id запись отбрасывается");
  assert.equal(messages[0].info.id, "ok");
});

// --- toExtractedSession ---

test("test_session_mapping_moves_directory_from_location", () => {
  const session = toExtractedSession({
    id: "ses_1",
    parentID: "ses_p",
    location: { directory: "/root/projects/x" },
    time: { created: 1700000000000, updated: 1700000001000 },
    title: "Заголовок",
  });
  assert.deepEqual(session, {
    id: "ses_1",
    parentID: "ses_p",
    directory: "/root/projects/x",
    time: { created: 1700000000000 },
  });
  assert.equal(toExtractedSession(undefined).id, undefined, "битые входы не роняют маппинг");
});

// --- fieldsToQuestions ---

test("test_fields_to_questions_shapes", () => {
  assert.deepEqual(fieldsToQuestions(undefined), [], "не-массив → пусто");
  assert.deepEqual(fieldsToQuestions("nope"), []);

  const questions = fieldsToQuestions([
    { key: "k1", type: "string", title: "Короткий", description: "Без вариантов" },
    { key: "k2", type: "string", title: "", options: [{ value: "1", label: "Один" }] },
    { key: "", type: "string", title: "   " },
    { key: "k4", type: "multiselect", title: "Мульти", options: [{ value: "x", label: "X" }] },
  ]);
  assert.equal(questions.length, 3, "поле без title и key отбрасывается");
  assert.equal(questions[0].question, "Без вариантов", "description приоритетнее title");
  assert.equal(questions[0].header, "Короткий");
  assert.equal(questions[0].custom, true, "нет вариантов → текстовый ответ");
  assert.deepEqual(questions[0].options, []);
  assert.equal(questions[1].question, "k2", "пустой title → берётся key");
  assert.equal(questions[1].header, "", "без description header пустой");
  assert.equal(questions[1].custom, false);
  assert.deepEqual(questions[1].options, [{ label: "Один", description: "" }]);
  assert.equal(questions[2].question, "Мульти");
  assert.equal(questions[2].header, "");
  assert.equal(questions[2].multiple, true);

  // fieldIndex — индекс в ИСХОДНОМ массиве: пропуск поля (k2 title-less, index 2)
  // не сдвигает соответствие questions ↔ fields (бага позиционного маппинга нет)
  assert.equal(questions[0].fieldIndex, 0);
  assert.equal(questions[1].fieldIndex, 1);
  assert.equal(questions[2].fieldIndex, 3, "пропущенное поле не «сдвигает» индекс");
});

// --- resolvePassword ---

test("test_resolve_password_prefers_env", () => {
  const saved = process.env.OPENCODE_PASSWORD;
  try {
    resetPasswordCache();
    process.env.OPENCODE_PASSWORD = "env-password-123";
    assert.equal(resolvePassword(), "env-password-123");
    resetPasswordCache();
    delete process.env.OPENCODE_PASSWORD;
    assert.notEqual(resolvePassword(), "env-password-123", "без env берётся файл");
  } finally {
    if (saved === undefined) delete process.env.OPENCODE_PASSWORD;
    else process.env.OPENCODE_PASSWORD = saved;
    resetPasswordCache();
  }
});
