// Тесты спринта 3 — обработчик permission.updated в event-hook:
// три кнопки в payload, дедуп по permissionID, запись маршрута, disabled, never-reject.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeBridgeConfig, type BridgeConfig } from "../config.ts";
import { createLogger, type Logger } from "../logger.ts";
import { createRoutes, type RoutesStore } from "../routes.ts";
import { createBridge, createEventHooks, type SessionClient } from "../service.ts";
import type { FetchLike, FetchLikeResponse } from "../telegram.ts";

const DIRECTORY = "/root/projects/opencode-telegram-notifier";
const SERVER_URL = "http://127.0.0.1:4100";

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
  const dir = mkdtempSync(join(tmpdir(), "tb-perm-"));
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

function permissionEvent(properties: Record<string, unknown> = {}) {
  return {
    event: {
      type: "permission.updated",
      properties: {
        id: "perm_test_1",
        sessionID: "ses1",
        title: "Run command: git push",
        pattern: "**/git push*",
        metadata: {},
        time: { created: 1793780000000 },
        ...properties,
      },
    },
  };
}

test("test_permission_sends_three_buttons", async () => {
  const s = setup();
  try {
    await s.hooks.event(permissionEvent());

    assert.equal(s.calls.length, 1, "ровно один fetch");
    const body = s.calls[0].body;
    assert.ok(String(s.calls[0].url).endsWith("/sendMessage"));
    assert.ok(body.text, "тело сообщения передано");
    assert.match(String(body.text), /🔐 Запрос разрешения/);

    const markup = body.reply_markup as { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> } | undefined;
    assert.ok(markup, "payload содержит reply_markup");
    assert.equal(markup.inline_keyboard.length, 1, "одна строка кнопок");
    const buttons = markup.inline_keyboard[0];
    assert.equal(buttons.length, 3, "ровно три кнопки");
    const actions = buttons.map((b) => b.callback_data);
    for (const data of actions) {
      const parts = data.split(":");
      assert.equal(parts.length, 3);
      assert.equal(parts[0], "perm");
      assert.equal(parts[1].length, 12, "rid из 12 символов");
      assert.ok(["once", "always", "reject"].includes(parts[2]));
      assert.ok(Buffer.byteLength(data, "utf8") <= 64, `${data} > 64 байт`);
    }
    assert.deepEqual(
      buttons.map((b) => b.callback_data.split(":")[2]),
      ["once", "always", "reject"],
    );
    assert.deepEqual(
      buttons.map((b) => b.text),
      ["✅ Разрешить", "🔁 Всегда", "❌ Отклонить"],
    );
    assert.match(s.logText(), /event=permission\.sent/);
    assert.ok(!s.logText().includes("123:TESTTOKEN"), "токен не попадает в лог");
  } finally {
    rmSync(s.dir, { recursive: true, force: true });
  }
});

test("test_permission_dedup_by_permission_id", async () => {
  const s = setup();
  try {
    await s.hooks.event(permissionEvent({ id: "perm_same" }));
    await s.hooks.event(permissionEvent({ id: "perm_same" }));

    assert.equal(s.calls.length, 1, "второй fetch не выполняется");
    const state = await s.routes.readState();
    assert.equal(Object.keys(state.permissions).length, 1, "записана ровно одна запись");
    assert.equal(
      (s.logText().match(/event=permission\.sent/g) ?? []).length,
      1,
      "одна отправка",
    );
    assert.match(s.logText(), /reason=duplicate/);
  } finally {
    rmSync(s.dir, { recursive: true, force: true });
  }
});

test("test_permission_route_recorded", async () => {
  const s = setup();
  try {
    // serverUrl в payload события злонамеренно подделан — записан быть не должен
    await s.hooks.event(
      permissionEvent({ id: "perm_route_1", serverUrl: "http://evil.example:1234/steal" }),
    );

    const state = await s.routes.readState();
    const entries = Object.entries(state.permissions);
    assert.equal(entries.length, 1);
    const [rid, route] = entries[0];
    assert.equal(rid.length, 12, "rid длиной 12");
    assert.match(rid, /^[0-9a-f]{12}$/);
    assert.ok(route.sessionID, "sessionID непустой");
    assert.ok(route.permissionID, "permissionID непустой");
    assert.ok(route.serverUrl, "serverUrl непустой");
    assert.ok(route.messageId, "messageId непустой");
    assert.equal(route.sessionID, "ses1");
    assert.equal(route.permissionID, "perm_route_1");
    assert.equal(route.serverUrl, SERVER_URL, "serverUrl берётся из PluginInput, не из payload");
    assert.match(route.serverUrl, /^http:\/\/127\.0\.0\.1:[0-9]+$/);
    assert.equal(route.directory, DIRECTORY);
    assert.equal(typeof route.createdAt, "number");

    // то же самое видно в самом файле routes.json
    const raw = JSON.parse(readFileSync(join(s.dir, "routes.json"), "utf8")) as {
      permissions: Record<string, typeof route>;
    };
    assert.ok(raw.permissions[rid]);
    assert.equal(raw.permissions[rid].permissionID, "perm_route_1");

    // второй permissionID — отдельная запись
    await s.hooks.event(permissionEvent({ id: "perm_route_2" }));
    const after = await s.routes.readState();
    assert.equal(Object.keys(after.permissions).length, 2);
  } finally {
    rmSync(s.dir, { recursive: true, force: true });
  }
});

test("test_permission_disabled_no_send", async () => {
  const s = setup({ config: { enabled: false } });
  try {
    await s.hooks.event(permissionEvent());
    await s.hooks.event(permissionEvent({ id: "perm_second" }));

    assert.equal(s.calls.length, 0, "fetch не вызывается при enabled=false");
    const state = await s.routes.readState();
    assert.equal(Object.keys(state.permissions).length, 0, "записей нет");
    assert.ok(!s.logText().includes("event=permission.sent"));
  } finally {
    rmSync(s.dir, { recursive: true, force: true });
  }
});

test("test_permission_event_never_rejects", async () => {
  // (а) client.session.get бросает исключение
  const s1 = setup({ client: brokenClient(), fetchImpl: failingFetch([]) });
  try {
    await assert.doesNotReject(
      () => s1.hooks.event(permissionEvent({ id: "perm_broken_client" })),
      "event-hook не должен отклоняться",
    );
    assert.match(s1.logText(), /event=permission\.failed/);
    const state1 = await s1.routes.readState();
    assert.equal(Object.keys(state1.permissions).length, 0, "записи нет при сбое");
  } finally {
    rmSync(s1.dir, { recursive: true, force: true });
  }

  // (б) fetch бросает исключение (клиент исправен) — записи после неудачной отправки нет
  const calls2: FetchCall[] = [];
  const s2 = setup({ fetchImpl: failingFetch(calls2), config: { retries: 0 } });
  try {
    await assert.doesNotReject(
      () => s2.hooks.event(permissionEvent({ id: "perm_broken_fetch" })),
      "event-hook не должен отклоняться при падении fetch",
    );
    assert.match(s2.logText(), /event=permission\.failed/);
    assert.ok(calls2.length >= 1, "fetch действительно вызывался и упал");
    const state2 = await s2.routes.readState();
    assert.equal(
      Object.keys(state2.permissions).length,
      0,
      "ошибка отправки не оставляет осиротевшую запись",
    );
    assert.ok(!s2.logText().includes("123:TESTTOKEN"), "токен не в логе ошибки");

    // после сбоя повторный event с тем же permissionID может пройти заново
    // (записи нет → дедуп не срабатывает)
    const found = await s2.routes.findPermissionByPermissionID("perm_broken_fetch");
    assert.equal(found, undefined);
  } finally {
    rmSync(s2.dir, { recursive: true, force: true });
  }

  // (в) не-permission события игнорируются без ошибок
  const s3 = setup();
  try {
    await assert.doesNotReject(() => s3.hooks.event({ event: { type: "session.status" } }));
    await assert.doesNotReject(() => s3.hooks.event({ event: { type: "permission.updated" } }));
    assert.equal(s3.calls.length, 0, "без id/sessionID отправки нет");
    assert.match(s3.logText(), /event=permission\.skipped/);
  } finally {
    rmSync(s3.dir, { recursive: true, force: true });
  }
});

// --- opencode ≥1.19: событие permission.asked (v2-формат свойств) ---

function askedEvent(properties: Record<string, unknown> = {}) {
  return {
    event: {
      type: "permission.asked",
      properties: {
        id: "per_asked_1",
        sessionID: "ses1",
        permission: "external_directory",
        patterns: ["/etc/*"],
        metadata: { filepath: "/etc/hostname", parentDir: "/etc" },
        always: ["/etc/*"],
        tool: { messageID: "msg_1", callID: "call_1" },
        ...properties,
      },
    },
  };
}

test("test_permission_asked_v2_sends", async () => {
  const s = setup();
  try {
    await s.hooks.event(askedEvent());

    assert.equal(s.calls.length, 1, "ровно один fetch");
    const body = s.calls[0].body;
    assert.ok(String(s.calls[0].url).endsWith("/sendMessage"));
    assert.match(String(body.text), /🔐 Запрос разрешения/);
    assert.match(String(body.text), /external_directory/, "тип разрешения в тексте");
    assert.match(String(body.text), /\/etc\/\*/, "паттерн в тексте");
    assert.match(String(body.text), /\/etc\/hostname/, "filepath из metadata");

    const markup = body.reply_markup as { inline_keyboard: Array<Array<{ callback_data: string }>> } | undefined;
    assert.ok(markup, "кнопки есть");
    assert.equal(markup.inline_keyboard[0].length, 3);
    const rid = markup.inline_keyboard[0][0].callback_data.split(":")[1];
    const state = JSON.parse(readFileSync(join(s.dir, "routes.json"), "utf8"));
    const route = state.permissions[rid];
    assert.ok(route, "маршрут permissions записан");
    assert.equal(route.permissionID, "per_asked_1");
    assert.equal(route.sessionID, "ses1");
    assert.equal(route.serverUrl, SERVER_URL);
    assert.ok(s.logText().includes("permission.sent"));
    assert.ok(s.logText().includes("permission.received"));
  } finally {
    rmSync(s.dir, { recursive: true, force: true });
  }
});

test("test_permission_asked_dedup", async () => {
  const s = setup();
  try {
    await s.hooks.event(askedEvent());
    await s.hooks.event(askedEvent());
    assert.equal(s.calls.length, 1, "дубль не отправляется");
    assert.ok(s.logText().includes("permission.skipped"));
  } finally {
    rmSync(s.dir, { recursive: true, force: true });
  }
});

test("test_permission_asked_never_rejects", async () => {
  const s = setup();
  try {
    await assert.doesNotReject(() =>
      s.hooks.event({ event: { type: "permission.asked" } }),
    );
    await assert.doesNotReject(() =>
      s.hooks.event({ event: { type: "permission.asked", properties: {} } }),
    );
  } finally {
    rmSync(s.dir, { recursive: true, force: true });
  }
});

// --- спринт 6: атомарный claimPermission ---

test("test_permission_parallel_events_single_send", async () => {
  const s = setup();
  try {
    const event = permissionEvent({ id: "perm_parallel" });
    await Promise.all([s.hooks.event(event), s.hooks.event(event)]);

    assert.equal(s.calls.length, 1, "два параллельных handlePermission → ровно 1 telegram-send");
    const state = await s.routes.readState();
    assert.equal(Object.keys(state.permissions).length, 1, "одна запись маршрута");
    assert.equal(
      (s.logText().match(/event=permission\.sent/g) ?? []).length,
      1,
      "одна отправка в логе",
    );
    assert.match(s.logText(), /reason=duplicate/);
  } finally {
    rmSync(s.dir, { recursive: true, force: true });
  }
});

test("test_permission_retry_after_send_failure", async () => {
  // первая отправка падает → pending снимается → повторный event проходит заново
  const calls: FetchCall[] = [];
  let shouldFail = true;
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) as Record<string, unknown> });
    if (shouldFail) {
      shouldFail = false;
      throw new Error("network down");
    }
    return jsonResponse(200, { ok: true, result: { message_id: 9500 } });
  };
  const s = setup({ fetchImpl, config: { retries: 0 } });
  try {
    await assert.doesNotReject(() =>
      s.hooks.event(permissionEvent({ id: "perm_retry_1" })),
      "упавшая отправка не роняет event-hook",
    );
    assert.match(s.logText(), /event=permission\.failed/);

    // повторный event с тем же permissionID: pending снят → claim проходит
    await s.hooks.event(permissionEvent({ id: "perm_retry_1" }));
    assert.equal(calls.length, 2, "повтор после сбоя дошёл до telegram");
    const state = await s.routes.readState();
    assert.equal(Object.keys(state.permissions).length, 1, "маршрут записан со второй попытки");
    assert.match(s.logText(), /event=permission\.sent/);
  } finally {
    rmSync(s.dir, { recursive: true, force: true });
  }
});
