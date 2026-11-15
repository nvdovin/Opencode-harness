// Тесты догрузки pending-форм: вопрос, созданный без живого form.created
// (поздняя подписка / «тихий» разрыв SSE), должен уйти в Telegram.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registryDirectories, setupPlugin } from "../../telegram-bridge.ts";
import { makeBridgeConfig } from "../config.ts";

const FORM = {
  id: "frm_hydrate_1",
  sessionID: "ses_hydrate_1",
  title: "Questions",
  fields: [
    {
      key: "q0",
      title: "DFG",
      description: "Удалить вкладку DFG и мини-граф?",
      type: "string",
      options: [
        { value: "yes", label: "Да", description: "" },
        { value: "no", label: "Нет", description: "" },
      ],
      custom: true,
    },
  ],
};

/** Поток событий, который остаётся открытым: плагин ждёт form.created. */
function openStream(): AsyncIterable<unknown> {
  return {
    async *[Symbol.asyncIterator]() {
      await new Promise(() => {});
    },
  };
}

type SentMessage = { url: string; body: Record<string, unknown> };

test("test_pending_form_is_hydrated_by_timer", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tb-hydrate-"));
  const config = makeBridgeConfig({
    stateDir: dir,
    logFile: join(dir, "notifier.log"),
    routesFile: join(dir, "routes.json"),
    token: "123:TESTTOKEN",
    chatId: "-100123",
    enabled: true,
    notifyOnQuestion: true,
    timeoutMs: 1000,
    retries: 0,
  });

  const originalFetch = globalThis.fetch;
  const sent: SentMessage[] = [];
  try {
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const target = String(url);
      if (target.includes("api.telegram.org")) {
        sent.push({
          url: target,
          body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
        });
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true, result: { message_id: 4242 } }),
        };
      }
      return { ok: true, status: 200, json: async () => ({ data: [] }) };
    }) as typeof fetch;

    let formCalls = 0;
    let done = false;
    // Своя локация + каталоги oc-сессий: первый проход onSubscribed пустой,
    // форма появляется только на следующем тике таймера.
    const firstPassCalls = 1 + registryDirectories().length;
    await setupPlugin(
      {
        location: { directory: dir },
        session: {
          async get() {
            return { id: FORM.sessionID, location: { directory: dir } };
          },
        },
        event: { subscribe: () => openStream() },
      },
      {
        config,
        hydrateIntervalMs: 20,
        fetchImpl: (async () => {
          if (done) return new Promise(() => {});
          formCalls += 1;
          // Первый вызов — onSubscribed (пусто), затем таймер отдаёт форму.
          return {
            ok: true,
            status: 200,
            json: async () => ({
              location: { directory: dir },
              data: formCalls > firstPassCalls ? [FORM] : [],
            }),
          };
        }) as unknown as typeof fetch,
      },
    );

    const logPath = join(dir, "notifier.log");
    const logText = (): string => {
      try {
        return readFileSync(logPath, "utf8");
      } catch {
        return "";
      }
    };
    const deadline = Date.now() + 5_000;
    while (
      (sent.length === 0 || !logText().includes("event=question.hydrated")) &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    assert.ok(formCalls > firstPassCalls, "периодическая догрузка вызвала /api/form ещё раз");
    assert.equal(sent.length, 1, "pending-вопрос отправлен в Telegram");
    const text = String(sent[0].body.text);
    assert.match(text, /<i>DFG<\/i>/, "header из form.field.title");
    assert.match(text, /Удалить вкладку DFG и мини-граф\?/, "текст вопроса из form.field.description");
    assert.match(text, /❓ <b>Вопрос агента · 1\/1<\/b>/);
    const log = logText();
    assert.match(log, /event=question\.hydrated count=1/);
    assert.match(log, /event=question\.sent/);

    // Останавливаем периодическую догрузку до удаления temp-каталога: иначе
    // следующий тик попытается писать в уже удалённый routes.json.
    done = true;
    await new Promise((resolve) => setTimeout(resolve, 80));
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(dir, { recursive: true, force: true });
  }
});
