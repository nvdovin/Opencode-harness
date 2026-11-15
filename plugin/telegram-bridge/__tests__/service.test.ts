// Тесты service.ts — root/child, дедуп, повтор после ошибки отправки, never-reject.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeBridgeConfig, type BridgeConfig } from "../config.ts";
import { createLogger, type Logger } from "../logger.ts";
import { deliver, type NotifyPayload } from "../notify.ts";
import { createRoutes, type RoutesStore } from "../routes.ts";
import {
  createBridge,
  createEventHooks,
  IDLE_COOLDOWN_MS,
  type Bridge,
  type SessionClient,
} from "../service.ts";
import { TelegramError, type SendImpl } from "../telegram.ts";

const DIRECTORY = "/root/projects/opencode-telegram-notifier";
const SERVER_URL = "http://127.0.0.1:4100";

type MessageRow = { info: Record<string, unknown>; parts: Array<Record<string, unknown>> };

function rootSession(): Record<string, unknown> {
  return { id: "ses1", directory: DIRECTORY, time: { created: 1000 } };
}

function rootMessages(): MessageRow[] {
  return [
    {
      info: { id: "u1", role: "user", time: { created: 1000 } },
      parts: [{ type: "text", text: "ЗАДАЧА_ИЗ_TEST" }],
    },
    {
      info: {
        id: "a1",
        role: "assistant",
        parentID: "u1",
        time: { created: 1100, completed: 2100 },
        providerID: "anthropic",
        modelID: "claude-test",
      },
      parts: [{ type: "text", text: "ИТОГ_OK: итог из теста достаточно длинный, чтобы пройти фильтр trivial_result" }],
    },
  ];
}

function fakeClient(
  session: Record<string, unknown> | (() => never),
  messages: MessageRow[] = rootMessages(),
): SessionClient {
  return {
    session: {
      async get() {
        if (typeof session === "function") return session();
        return { data: session };
      },
      async messages() {
        return { data: messages };
      },
    },
  };
}

/** Сообщения с настраиваемым assistant-итогом/ошибкой (фильтры статусов, cooldown). */
function assistantMessages(
  text: string,
  options: { id?: string; error?: { name?: string; data?: { message?: string } } } = {},
): MessageRow[] {
  return [
    {
      info: { id: "u1", role: "user", time: { created: 1000 } },
      parts: [{ type: "text", text: "ЗАДАЧА_ИЗ_TEST" }],
    },
    {
      info: {
        id: options.id ?? "a1",
        role: "assistant",
        parentID: "u1",
        time: { created: 1100, completed: 2100 },
        providerID: "anthropic",
        modelID: "claude-test",
        error: options.error,
      },
      parts: [{ type: "text", text }],
    },
  ];
}

type Setup = {
  dir: string;
  config: BridgeConfig;
  routes: RoutesStore;
  logger: Logger;
  logFile: string;
  sent: string[];
  bridge: (client: SessionClient, send?: SendImpl) => Bridge;
  logText: () => string;
};

function setup(now?: () => number): Setup {
  const dir = mkdtempSync(join(tmpdir(), "tb-service-"));
  const config = makeBridgeConfig({ token: "123:TESTTOKEN", chatId: "-100123", stateDir: dir });
  const routes = createRoutes({ stateDir: dir });
  const logFile = join(dir, "notifier.log");
  const logger = createLogger({
    logFile,
    secrets: { token: config.token, chatId: config.chatId },
    silent: true,
  });
  const sent: string[] = [];
  const defaultSend: SendImpl = async ({ text }) => {
    sent.push(text);
    return { messageId: 4000 + sent.length };
  };
  // в тестах доставка выполняется in-process через ту же функцию deliver,
  // что и в дочернем процессе (без spawn и без реальной сети)
  const notifyWith =
    (send: SendImpl) =>
    async (payload: NotifyPayload): Promise<void> => {
      await deliver(payload, { config, routes, logger, sendImpl: send });
    };
  return {
    dir,
    config,
    routes,
    logger,
    logFile,
    sent,
    bridge: (client, send) =>
      createBridge({
        client,
        directory: DIRECTORY,
        serverUrl: SERVER_URL,
        config,
        routes,
        logger,
        notify: notifyWith(send ?? defaultSend),
        now,
      }),
    logText: () => {
      try {
        return readFileSync(logFile, "utf8");
      } catch {
        return "";
      }
    },
  };
}

test("test_root_session_sends", async () => {
  const s = setup();
  try {
    const bridge = s.bridge(fakeClient(rootSession()));
    await bridge.handleIdle("ses1");

    assert.equal(s.sent.length, 1, "роут-сессия должна отправить ровно одно сообщение");
    assert.match(s.sent[0], /✅ <b>Задача выполнена<\/b>/);
    assert.ok(s.sent[0].includes("ЗАДАЧА_ИЗ_TEST"));
    assert.ok(s.sent[0].includes("ИТОГ_OK"));

    const route = await s.routes.getMessage(4001);
    assert.ok(route, "маршрут message_id → сессия должен быть записан");
    assert.equal(route.sessionID, "ses1");
    assert.equal(route.serverUrl, SERVER_URL);
    assert.equal(route.directory, DIRECTORY);
    assert.equal(await s.routes.hasSent("ses1:a1"), true);

    const log = s.logText();
    assert.match(log, /event=telegram\.sent/);
    assert.match(log, /message_id=4001/);
    assert.ok(!log.includes("123:TESTTOKEN"), "токен не должен попадать в лог");
    assert.ok(!log.includes("-100123"), "chat_id не должен попадать в лог");
  } finally {
    rmSync(s.dir, { recursive: true, force: true });
  }
});

test("test_child_session_skipped", async () => {
  const s = setup();
  try {
    const childSession = { ...rootSession(), id: "child1", parentID: "ses1" };
    const bridge = s.bridge(fakeClient(childSession));
    await bridge.handleIdle("child1");

    assert.equal(s.sent.length, 0, "дочерняя сессия не должна слать уведомления");
    assert.equal(await s.routes.getMessage(4001), undefined);
    assert.match(s.logText(), /event=idle\.skipped/);
    assert.match(s.logText(), /reason=child_session/);
  } finally {
    rmSync(s.dir, { recursive: true, force: true });
  }
});

test("test_duplicate_idle_sends_once", async () => {
  const s = setup();
  try {
    const bridge = s.bridge(fakeClient(rootSession()));
    await bridge.handleIdle("ses1");
    await bridge.handleIdle("ses1");
    await bridge.handleIdle("ses1");

    assert.equal(s.sent.length, 1, "повторный idle с тем же assistantMessageID не шлёт второе сообщение");
    const state = await s.routes.readState();
    assert.equal(Object.keys(state.messages).length, 1);
    assert.equal((s.logText().match(/event=telegram\.sent/g) ?? []).length, 1);
    assert.equal((s.logText().match(/reason=duplicate/g) ?? []).length, 2);
  } finally {
    rmSync(s.dir, { recursive: true, force: true });
  }
});

test("test_send_failure_allows_retry", async () => {
  const s = setup();
  try {
    let failures = 0;
    const flakySend: SendImpl = async ({ text }) => {
      s.sent.push(text);
      if (failures === 0) {
        failures += 1;
        throw new TelegramError("telegram request failed (http 500, code 500)", {
          httpStatus: 500,
          telegramCode: 500,
          retryable: true,
          kind: "api",
        });
      }
      return { messageId: 7777 };
    };
    const bridge = s.bridge(fakeClient(rootSession()), flakySend);

    await assert.rejects(() => bridge.handleIdle("ses1"), TelegramError);
    assert.equal(await s.routes.hasSent("ses1:a1"), false, "ошибка отправки не помечает ключ дедупа");
    assert.equal(await s.routes.getMessage(7777), undefined, "маршрут не записан при ошибке");

    // следующий idle повторяет попытку и преуспевает
    await bridge.handleIdle("ses1");
    assert.equal(s.sent.length, 2, "вторая попытка отправки выполнена");
    assert.equal(await s.routes.hasSent("ses1:a1"), true);
    assert.equal((await s.routes.getMessage(7777))?.sessionID, "ses1");
    assert.match(s.logText(), /event=telegram\.sent/);
    assert.match(s.logText(), /message_id=7777/);
  } finally {
    rmSync(s.dir, { recursive: true, force: true });
  }
});

test("test_event_never_rejects", async () => {
  const s = setup();
  try {
    // (а) client.session.get бросает исключение → hook завершается без reject
    const brokenClient: SessionClient = {
      session: {
        async get() {
          throw new Error("client is down");
        },
        async messages() {
          return { data: rootMessages() };
        },
      },
    };
    const bridge = s.bridge(brokenClient);
    const hooks = createEventHooks({ bridge, logger: s.logger });

    await assert.doesNotReject(
      () => hooks.event({ event: { type: "session.idle", properties: { sessionID: "ses1" } } }),
      "event-hook не должен отклоняться",
    );
    assert.match(s.logText(), /event=idle\.failed/);
    assert.ok(s.sent.length === 0);

    // (б) исключение прямо из handleIdle
    const throwingBridge: Bridge = {
      async handleIdle() {
        throw new Error("boom");
      },
    };
    const hooks2 = createEventHooks({ bridge: throwingBridge, logger: s.logger });
    await assert.doesNotReject(() =>
      hooks2.event({ event: { type: "session.idle", properties: { sessionID: "ses2" } } }),
    );

    // (в) не-idle события и отсутствие sessionID игнорируются без ошибок
    await assert.doesNotReject(() =>
      hooks2.event({ event: { type: "session.status", properties: {} } }),
    );
    await assert.doesNotReject(() => hooks2.event({ event: { type: "session.idle" } }));

    // (г) ошибки сети/fetch тоже перехватываются
    const failingSend: SendImpl = async () => {
      throw new Error("network down");
    };
    const bridge2 = s.bridge(fakeClient(rootSession()), failingSend);
    const hooks3 = createEventHooks({ bridge: bridge2, logger: s.logger });
    await assert.doesNotReject(() =>
      hooks3.event({ event: { type: "session.idle", properties: { sessionID: "ses3" } } }),
    );
    const failures = (s.logText().match(/event=idle\.failed/g) ?? []).length;
    assert.equal(failures, 3, "каждый сбой пишет event=idle.failed");
    assert.equal(await s.routes.hasSent("ses3:a1"), false);
  } finally {
    rmSync(s.dir, { recursive: true, force: true });
  }
});

test("test_double_registered_hooks_send_once", async () => {
  // opencode может вызвать функцию плагина дважды → два хука на одно событие;
  // модульный лок по ключу дедупа обязан дать ровно одну отправку
  const s = setup();
  try {
    const hooksA = createEventHooks({ bridge: s.bridge(fakeClient(rootSession())), logger: s.logger });
    const hooksB = createEventHooks({ bridge: s.bridge(fakeClient(rootSession())), logger: s.logger });
    const event = { event: { type: "session.idle", properties: { sessionID: "ses1" } } };

    await Promise.all([hooksA.event(event), hooksB.event(event)]);

    assert.equal(s.sent.length, 1, "двойная регистрация хука не должна слать два сообщения");
    const state = await s.routes.readState();
    assert.equal(Object.keys(state.messages).length, 1);
    assert.equal((s.logText().match(/event=telegram\.sent/g) ?? []).length, 1);
  } finally {
    rmSync(s.dir, { recursive: true, force: true });
  }
});

// --- спринт 6: фильтр тривиального итога (minResultChars) ---

test("test_trivial_result_skipped", async () => {
  const s = setup();
  try {
    const bridge = s.bridge(
      fakeClient(rootSession(), assistantMessages("Готово.")),
    );
    await bridge.handleIdle("ses1");

    assert.equal(s.sent.length, 0, "короткий success-итог не уведомляется");
    assert.equal(await s.routes.getMessage(4001), undefined);
    assert.match(s.logText(), /event=idle\.skipped/);
    assert.match(s.logText(), /reason=trivial_result/);
    assert.ok(!s.logText().includes("event=telegram.sent"));
  } finally {
    rmSync(s.dir, { recursive: true, force: true });
  }
});

test("test_error_and_abort_not_filtered_by_min_result", async () => {
  // error с пустым итогом — minResultChars не применяется
  const sErr = setup();
  try {
    const bridge = sErr.bridge(
      fakeClient(
        rootSession(),
        assistantMessages("", { error: { name: "ProviderError", data: { message: "boom" } } }),
      ),
    );
    await bridge.handleIdle("ses1");
    assert.equal(sErr.sent.length, 1, "error с пустым итогом отправляется");
    assert.ok(!sErr.logText().includes("trivial_result"));
  } finally {
    rmSync(sErr.dir, { recursive: true, force: true });
  }

  // abort с коротким итогом — тоже отправляется
  const sAbort = setup();
  try {
    const bridge = sAbort.bridge(
      fakeClient(
        rootSession(),
        assistantMessages("Отмена.", {
          error: { name: "MessageAbortedError", data: { message: "aborted" } },
        }),
      ),
    );
    await bridge.handleIdle("ses1");
    assert.equal(sAbort.sent.length, 1, "abort с коротким итогом отправляется");
    assert.ok(!sAbort.logText().includes("trivial_result"));
  } finally {
    rmSync(sAbort.dir, { recursive: true, force: true });
  }
});

// --- спринт 6: cooldown idle-уведомлений ---

test("test_idle_cooldown_between_messages", async () => {
  let clock = 1_000_000;
  const s = setup(() => clock);
  try {
    let current = assistantMessages("ИТОГ_OK: первое сообщение достаточно длинное для отправки", {
      id: "a1",
    });
    const client: SessionClient = {
      session: {
        async get() {
          return { data: rootSession() };
        },
        async messages() {
          return { data: current };
        },
      },
    };
    const bridge = s.bridge(client);

    // первое idle (msg a1) — отправляется
    await bridge.handleIdle("ses1");
    assert.equal(s.sent.length, 1, "первое idle-уведомление уходит");

    // второе idle через 1 с с НОВЫМ assistantMessageID — cooldown → пропуск
    clock += 1000;
    current = assistantMessages("ИТОГ_OK: второе сообщение тоже достаточно длинное для отправки", {
      id: "a2",
    });
    await bridge.handleIdle("ses1");
    assert.equal(s.sent.length, 1, "второе сообщение в окне cooldown не отправляется");
    assert.match(s.logText(), /reason=cooldown/);

    // то же idle спустя окно cooldown (>8 с с момента первой отправки) — проходит
    clock += IDLE_COOLDOWN_MS + 1000;
    await bridge.handleIdle("ses1");
    assert.equal(s.sent.length, 2, "после окна cooldown повторное idle уведомляет");
    assert.equal((s.logText().match(/event=telegram\.sent/g) ?? []).length, 2);
  } finally {
    rmSync(s.dir, { recursive: true, force: true });
  }
});
