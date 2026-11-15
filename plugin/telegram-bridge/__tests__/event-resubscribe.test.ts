// Тесты переподписки потока событий плагина (п. E): после закрытия потока
// (рестарт serve) плагин НЕ оглохает — логит event.stream_closed и подписывается
// заново с экспоненциальным backoff 1с…60с, без ограничения числа попыток.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  registryDirectories,
  runEventLoop,
  setupPlugin,
  streamRetryDelayMs,
} from "../../telegram-bridge.ts";
import { createLogger } from "../logger.ts";
import { makeBridgeConfig } from "../config.ts";

function silentLogger(logFile: string) {
  return createLogger({ logFile, silent: true });
}

/** Поток: отдаёт события и (опционально) падает вместо «штатного» завершения. */
function streamOf(events: unknown[], options: { throwAtEnd?: Error } = {}): AsyncIterable<unknown> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) yield event;
      if (options.throwAtEnd) throw options.throwAtEnd;
    },
  };
}

function tmpLog(): string {
  return join(mkdtempSync(join(tmpdir(), "tb-sub-")), "notifier.log");
}

test("test_stream_retry_delay_is_exponential_up_to_60s", () => {
  assert.equal(streamRetryDelayMs(1), 1000);
  assert.equal(streamRetryDelayMs(2), 2000);
  assert.equal(streamRetryDelayMs(3), 4000);
  assert.equal(streamRetryDelayMs(4), 8000);
  assert.equal(streamRetryDelayMs(5), 16000);
  assert.equal(streamRetryDelayMs(6), 32000);
  assert.equal(streamRetryDelayMs(7), 60000, "потолок 60с");
  assert.equal(streamRetryDelayMs(8), 60000, "дальше не растёт");
  assert.equal(streamRetryDelayMs(50), 60000, "лимита попыток нет — просто держим 60с");
  assert.equal(streamRetryDelayMs(0), 1000, "некорректное значение → базовая пауза");
});

test("test_event_loop_resubscribes_after_stream_closed", async () => {
  const logFile = tmpLog();
  const logger = silentLogger(logFile);
  const streams = [streamOf([]), streamOf([]), streamOf([])];
  let subscribeCalls = 0;

  const result = await runEventLoop({
    subscribe: () => {
      subscribeCalls += 1;
      return streams.shift();
    },
    context: {},
    dispatch: async () => {},
    logger,
    sleepImpl: async () => {},
    shouldContinue: () => subscribeCalls < 3,
  });

  assert.equal(result.subscriptions, 3, "три подписки: первая + две переподписки");
  assert.deepEqual(result.delays, [1000, 2000, 4000], "backoff 1с → 2с → 4с");
  const log = readFileSync(logFile, "utf8");
  assert.equal(log.split("event=event.stream_closed").length - 1, 3, "закрытие каждого потока залогировано");
  assert.ok(log.includes("delay_ms=1000"), log);
  assert.ok(log.includes("delay_ms=4000"), log);
  assert.ok(!log.includes("event=plugin.init.failed"), "цикл не упал");
});

test("test_event_loop_resubscribes_when_stream_throws", async () => {
  const logFile = tmpLog();
  const logger = silentLogger(logFile);
  const idle = { type: "session.idle", data: { sessionID: "ses_loop01" } };
  const streams = [
    streamOf([idle], { throwAtEnd: new Error("socket hang up") }),
    streamOf([]),
  ];
  let subscribeCalls = 0;
  const dispatched: unknown[] = [];

  const result = await runEventLoop({
    subscribe: () => {
      subscribeCalls += 1;
      return streams.shift();
    },
    context: {},
    dispatch: async (event) => {
      dispatched.push(event);
    },
    logger,
    sleepImpl: async () => {},
    shouldContinue: () => subscribeCalls < 2,
  });

  assert.equal(result.subscriptions, 2, "после падения потока была переподписка");
  assert.equal(result.events, 1, "принятое событие учтено");
  assert.equal(dispatched.length, 1, "событие дошло до обработчика");
  assert.deepEqual(dispatched[0], { type: "session.idle", properties: { sessionID: "ses_loop01" } });
  const log = readFileSync(logFile, "utf8");
  assert.ok(log.includes("event=event.stream_closed"), log);
  assert.ok(log.includes("detail=socket hang up"), log);
  assert.ok(log.includes("consumed=1"), log);
  // принятое событие сбросило backoff: первая переподписка после него — через 1с
  assert.deepEqual(result.delays, [1000, 1000]);
});

test("test_event_loop_resets_backoff_after_successful_stream", async () => {
  const logFile = tmpLog();
  const logger = silentLogger(logFile);
  // 2 пустых (failures 1,2) → событие (сброс) → пустой (1) → стоп
  const streams = [streamOf([]), streamOf([]), streamOf([{ type: "unknown.event" }]), streamOf([])];
  let subscribeCalls = 0;

  const result = await runEventLoop({
    subscribe: () => {
      subscribeCalls += 1;
      return streams.shift();
    },
    context: {},
    dispatch: async () => {},
    logger,
    sleepImpl: async () => {},
    shouldContinue: () => subscribeCalls < 4,
  });

  assert.deepEqual(result.delays, [1000, 2000, 1000, 1000], "после успеха backoff начинается заново с 1с");
  assert.equal(result.events, 1);
});

test("test_event_loop_stops_when_subscribe_unavailable", async () => {
  const logFile = tmpLog();
  const logger = silentLogger(logFile);

  // subscribe вернул не-итерируемое значение → как раньше: warn и выход (без цикла)
  const result = await runEventLoop({
    subscribe: () => undefined,
    context: {},
    dispatch: async () => {},
    logger,
    sleepImpl: async () => {},
  });

  assert.equal(result.subscriptions, 0, "подписки не было");
  assert.deepEqual(result.delays, []);
  const log = readFileSync(logFile, "utf8");
  assert.ok(log.includes("event=event.subscribe_unavailable"), log);
});

test("test_event_loop_survives_subscribe_throwing", async () => {
  const logFile = tmpLog();
  const logger = silentLogger(logFile);
  let calls = 0;

  const result = await runEventLoop({
    subscribe: () => {
      calls += 1;
      if (calls === 1) throw new Error("server restarting");
      return streamOf([]);
    },
    context: {},
    dispatch: async () => {},
    logger,
    sleepImpl: async () => {},
    shouldContinue: () => calls < 2,
  });

  assert.equal(result.subscriptions, 1, "после сбоя подписки — успешная попытка");
  const log = readFileSync(logFile, "utf8");
  assert.ok(log.includes("event=event.subscribe_failed"), log);
  assert.ok(log.includes("event=event.stream_closed"), log);
});

test("test_event_loop_hydrates_after_each_subscription_and_survives_error", async () => {
  const logFile = tmpLog();
  const logger = silentLogger(logFile);
  const streams = [streamOf([]), streamOf([]), streamOf([])];
  let subscribeCalls = 0;
  let hydrations = 0;

  const result = await runEventLoop({
    subscribe: () => {
      subscribeCalls += 1;
      return streams.shift();
    },
    context: {},
    dispatch: async () => {},
    onSubscribed: async () => {
      hydrations += 1;
      if (hydrations === 2) throw new Error("forms api down");
    },
    logger,
    sleepImpl: async () => {},
    shouldContinue: () => subscribeCalls < 3,
  });

  assert.equal(result.subscriptions, 3);
  assert.equal(hydrations, 3, "догрузка вызывается на каждой подписке");
  const log = readFileSync(logFile, "utf8");
  assert.ok(log.includes("event=event.hydrate_failed"), "сбой догрузки залогирован");
  assert.ok(!log.includes("event=plugin.init.failed"), "сбой догрузки не рвёт цикл");
});

// --- интеграция через setupPlugin -------------------------------------------

test("test_setup_plugin_keeps_subscribing_after_stream_closed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tb-sub-int-"));
  const logFile = join(dir, "notifier.log");
  const config = makeBridgeConfig({
    stateDir: dir,
    logFile,
    routesFile: join(dir, "routes.json"),
    token: "TEST_TOKEN_NOT_REAL",
    chatId: "7770001",
    enabled: true,
  });

  // Сырые события без перевода → без побочных эффектов (TG не вызывается).
  const streams = [streamOf([{ type: "not.a.real.event" }]), streamOf([])];
  let subscribeCalls = 0;
  let hydrations = 0;
  await setupPlugin(
    {
      location: { directory: dir },
      event: {
        subscribe: () => {
          subscribeCalls += 1;
          // Третий вызов — сигнал циклу, что подписываться больше нечем.
          return subscribeCalls > 2 ? undefined : streams.shift();
        },
      },
    },
    {
      config,
      fetchImpl: (async () => {
        hydrations += 1;
        return { ok: true, status: 200, json: async () => ({ data: [] }) };
      }) as unknown as typeof fetch,
    },
  );

  // Цикл асинхронный (void) — дождаемся завершения (паузы 1с + 2с).
  const deadline = Date.now() + 10_000;
  while (subscribeCalls < 3 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  assert.equal(subscribeCalls, 3, "плагин переподписался после закрытия потока");
  // Каждая догрузка обходит свою локацию + каталоги oc-сессий.
  const perHydration = 1 + registryDirectories().length;
  assert.equal(
    hydrations,
    2 * perHydration,
    "pending-формы догружаются после каждой успешной подписки",
  );
  const log = readFileSync(logFile, "utf8");
  assert.ok(log.includes("event=plugin.loaded"), log);
  assert.ok(log.includes("event=event.stream_closed"), log);
  assert.ok(log.includes("event=event.subscribe_unavailable"), "цикл корректно завершился");
  assert.ok(!log.includes("event=plugin.init.failed"), log);
});
