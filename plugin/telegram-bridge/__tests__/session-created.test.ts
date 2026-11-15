// Тесты session.created — уведомление «Новая сессия», child-skip, дедуп, disabled, never-reject.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeBridgeConfig, type BridgeConfig } from "../config.ts";
import { createLogger, type Logger } from "../logger.ts";
import { deliver, type NotifyPayload } from "../notify.ts";
import { createRoutes, type RoutesStore } from "../routes.ts";
import { createBridge, createEventHooks, type Bridge, type SessionClient } from "../service.ts";
import type { SendImpl } from "../telegram.ts";
import { formatSessionCreated } from "../format.ts";

const DIRECTORY = "/root/projects/opencode-telegram-notifier";
const SERVER_URL = "http://127.0.0.1:4100";

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

type Setup = {
  dir: string;
  routes: RoutesStore;
  logger: Logger;
  sent: string[];
  logFile: string;
  bridge: (config?: Partial<BridgeConfig>) => Bridge;
  hooks: (config?: Partial<BridgeConfig>) => ReturnType<typeof createEventHooks>;
  logText(): string;
};

function setup(): Setup {
  const dir = mkdtempSync(join(tmpdir(), "tb-sesscreate-"));
  const routes = createRoutes({ stateDir: dir });
  const logFile = join(dir, "notifier.log");
  const baseConfig = makeBridgeConfig({
    token: "123:TESTTOKEN",
    chatId: "-100123",
    stateDir: dir,
    logFile,
  });
  const logger = createLogger({
    logFile,
    secrets: { token: baseConfig.token, chatId: baseConfig.chatId },
    silent: true,
  });
  const sent: string[] = [];
  const defaultSend: SendImpl = async ({ text }) => {
    sent.push(text);
    return { messageId: 5000 + sent.length };
  };
  const notifyWith =
    (send: SendImpl) =>
    async (payload: NotifyPayload): Promise<void> => {
      await deliver(payload, { config: baseConfig, routes, logger, sendImpl: send });
    };
  const makeBridge = (overrides?: Partial<BridgeConfig>) => {
    const config = overrides ? { ...baseConfig, ...overrides } : baseConfig;
    return createBridge({
      client: fakeClient(),
      directory: DIRECTORY,
      serverUrl: SERVER_URL,
      config,
      routes,
      logger,
      notify: notifyWith(defaultSend),
    });
  };
  return {
    dir,
    routes,
    logger,
    sent,
    logFile,
    bridge: makeBridge,
    hooks: (overrides) => createEventHooks({ bridge: makeBridge(overrides), logger }),
    logText: () => {
      try {
        return readFileSync(logFile, "utf8");
      } catch {
        return "";
      }
    },
  };
}

function createdEvent(info: Record<string, unknown> = {}) {
  return {
    event: {
      type: "session.created",
      properties: {
        info: {
          id: "ses_new_1",
          directory: DIRECTORY,
          title: "Новая задача",
          time: { created: 1793780000000 },
          ...info,
        },
      },
    },
  };
}

test("test_session_created_notifies", async () => {
  const s = setup();
  try {
    await s.hooks().event(createdEvent());
    assert.equal(s.sent.length, 1, "ровно одно сообщение");
    assert.match(s.sent[0], /🆕 <b>Новая сессия<\/b>/);
    assert.match(s.sent[0], /ses_new_/, "короткий id сессии");
    assert.match(s.sent[0], /opencode-telegram-notifier/, "проект из directory");
    assert.match(s.sent[0], /Новая задача/, "title");
    assert.ok(s.logText().includes("session_create.queued"), "событие в логе");
  } finally {
    rmSync(s.dir, { recursive: true, force: true });
  }
});

test("test_session_created_route_recorded", async () => {
  const s = setup();
  try {
    await s.hooks().event(createdEvent());
    // messageId = 5001 (первый send)
    const state = JSON.parse(readFileSync(join(s.dir, "routes.json"), "utf8"));
    const route = state.messages["5001"];
    assert.ok(route, "маршрут message_id записан");
    assert.equal(route.sessionID, "ses_new_1");
    assert.equal(route.serverUrl, SERVER_URL);
    assert.equal(route.directory, DIRECTORY);
  } finally {
    rmSync(s.dir, { recursive: true, force: true });
  }
});

test("test_session_created_child_skipped", async () => {
  const s = setup();
  try {
    await s.hooks().event(createdEvent({ id: "ses_child", parentID: "ses_parent" }));
    assert.equal(s.sent.length, 0, "child-сессия не уведомляется");
    assert.ok(s.logText().includes("child_session"), "причина в логе");
  } finally {
    rmSync(s.dir, { recursive: true, force: true });
  }
});

test("test_session_created_dedup", async () => {
  const s = setup();
  try {
    await s.hooks().event(createdEvent());
    await s.hooks().event(createdEvent());
    assert.equal(s.sent.length, 1, "повторный event не даёт второго сообщения");
    assert.ok(s.logText().includes("session_create.skipped"));
  } finally {
    rmSync(s.dir, { recursive: true, force: true });
  }
});

test("test_session_created_disabled", async () => {
  const s = setup();
  try {
    await s.hooks({ notifyOnSessionCreate: false }).event(createdEvent());
    assert.equal(s.sent.length, 0, "disabled → без отправки");
    assert.ok(s.logText().includes("session_create.skipped"));
  } finally {
    rmSync(s.dir, { recursive: true, force: true });
  }
});

test("test_session_created_event_never_rejects", async () => {
  const s = setup();
  try {
    const broken: SessionClient = {
      session: {
        async get() {
          throw new Error("down");
        },
        async messages() {
          throw new Error("down");
        },
      },
    };
    // handleSessionCreated не использует client, но хук не должен ронять при любых ошибках
    const bridge = createBridge({
      client: broken,
      directory: DIRECTORY,
      serverUrl: SERVER_URL,
      config: makeBridgeConfig({ token: "123:T", chatId: "-1", stateDir: s.dir }),
      routes: s.routes,
      logger: s.logger,
      notify: async () => {
        throw new Error("spawn failed");
      },
    });
    const hooks = createEventHooks({ bridge, logger: s.logger });
    await hooks.event(createdEvent()); // не должно бросить
    await hooks.event({ event: { type: "session.created" } }); // без info — не должно бросить
    await hooks.event({ event: { type: "session.created", properties: {} } });
    assert.ok(true, "не исключений");
  } finally {
    rmSync(s.dir, { recursive: true, force: true });
  }
});

test("test_format_session_created_html_safe", () => {
  const config = makeBridgeConfig({ token: "", chatId: "" });
  const html = formatSessionCreated(
    { sessionShort: "abcdef12", project: "proj", title: "<script>x</script>" },
    config,
  );
  assert.ok(html.includes("🆕 <b>Новая сессия</b>"));
  assert.ok(!html.includes("<script>"), "title экранирован");
  assert.ok(html.includes("&lt;script&gt;"));
  assert.ok(html.length <= 3900);
});
