// Тесты telegram.ts — отправка/правка сообщений, политика повторов, отсутствие токена в ошибках.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  editTelegramMessage,
  sendTelegramMessage,
  TelegramError,
  type FetchLike,
  type FetchLikeResponse,
} from "../telegram.ts";

const TOKEN = "777000111:AA-secret-TOKEN-value";
const CHAT_ID = "-100999888777";

function okResponse(messageId: number): FetchLikeResponse {
  return {
    ok: true,
    status: 200,
    json: async () => ({ ok: true, result: { message_id: messageId } }),
  };
}

function errorResponse(
  status: number,
  body: Record<string, unknown>,
): FetchLikeResponse {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function noSleep(): void {
  /* в тестах время не тратится */
}

test("test_send_success", async () => {
  const calls: Array<{ url: string; init: { method: string; body: string; headers: Record<string, string> } }> = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, init: { method: init.method, body: init.body, headers: init.headers } });
    return okResponse(4242);
  };
  const result = await sendTelegramMessage({
    token: TOKEN,
    chatId: CHAT_ID,
    text: "<b>привет</b>",
    fetchImpl,
    sleepImpl: noSleep,
  });
  assert.equal(result.messageId, 4242);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `https://api.telegram.org/bot${TOKEN}/sendMessage`);
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers["content-type"], "application/json");
  const body = JSON.parse(calls[0].init.body) as Record<string, unknown>;
  assert.equal(body.chat_id, CHAT_ID);
  assert.equal(body.text, "<b>привет</b>");
  assert.equal(body.parse_mode, "HTML");
  assert.equal(body.disable_web_page_preview, true);
});

test("test_401_no_retry", async () => {
  let calls = 0;
  const sleeps: number[] = [];
  const fetchImpl: FetchLike = async () => {
    calls += 1;
    return errorResponse(401, { ok: false, error_code: 401, description: "Unauthorized" });
  };
  let caught: unknown;
  try {
    await sendTelegramMessage({
      token: TOKEN,
      chatId: CHAT_ID,
      text: "x",
      retries: 2,
      fetchImpl,
      sleepImpl: async (ms) => {
        sleeps.push(ms);
      },
    });
  } catch (e) {
    caught = e;
  }
  assert.ok(caught instanceof TelegramError, `ожидался TelegramError: ${String(caught)}`);
  assert.equal((caught as TelegramError).httpStatus, 401);
  assert.equal((caught as TelegramError).retryable, false);
  assert.equal(calls, 1, "401 не должен повторяться");
  assert.equal(sleeps.length, 0, "401 не должен ждать перед повтором");
  assert.ok(!(caught as Error).message.includes(TOKEN));
});

test("test_429_retry_after", async () => {
  let calls = 0;
  const sleeps: number[] = [];
  const fetchImpl: FetchLike = async () => {
    calls += 1;
    if (calls === 1) {
      return errorResponse(429, {
        ok: false,
        error_code: 429,
        description: "Too Many Requests",
        parameters: { retry_after: 2 },
      });
    }
    return okResponse(7);
  };
  const result = await sendTelegramMessage({
    token: TOKEN,
    chatId: CHAT_ID,
    text: "x",
    retries: 2,
    fetchImpl,
    sleepImpl: async (ms) => {
      sleeps.push(ms);
    },
  });
  assert.equal(result.messageId, 7);
  assert.equal(calls, 2, "после 429 выполняется ровно один повтор");
  assert.equal(sleeps.length, 1);
  assert.equal(sleeps[0], 2000, "retry_after=2 c → 2000 мс");

  // retry_after больше потолка → 5000 мс
  let calls2 = 0;
  const sleeps2: number[] = [];
  const fetchImpl2: FetchLike = async () => {
    calls2 += 1;
    if (calls2 === 1) {
      return errorResponse(429, {
        ok: false,
        error_code: 429,
        parameters: { retry_after: 60 },
      });
    }
    return okResponse(8);
  };
  await sendTelegramMessage({
    token: TOKEN,
    chatId: CHAT_ID,
    text: "x",
    retries: 1,
    fetchImpl: fetchImpl2,
    sleepImpl: async (ms) => {
      sleeps2.push(ms);
    },
  });
  assert.equal(calls2, 2);
  assert.equal(sleeps2[0], 5000, "retry_after ограничен 5000 мс");
});

test("test_timeout_retries_then_fails", async () => {
  let calls = 0;
  const sleeps: number[] = [];
  const fetchImpl: FetchLike = (_url, init) => {
    calls += 1;
    return new Promise<FetchLikeResponse>((_resolve, reject) => {
      init.signal.addEventListener("abort", () => {
        const error = new Error("This operation was aborted");
        error.name = "AbortError";
        reject(error);
      });
    });
  };
  let caught: unknown;
  try {
    await sendTelegramMessage({
      token: TOKEN,
      chatId: CHAT_ID,
      text: "x",
      timeoutMs: 15,
      retries: 2,
      fetchImpl,
      sleepImpl: async (ms) => {
        sleeps.push(ms);
      },
    });
  } catch (e) {
    caught = e;
  }
  assert.ok(caught instanceof TelegramError, `ожидался TelegramError: ${String(caught)}`);
  assert.equal((caught as TelegramError).kind, "timeout");
  assert.equal((caught as TelegramError).retryable, true);
  assert.equal(calls, 3, "attempts = min(retries+1, 3)");
  assert.equal(sleeps.length, 2, "две паузы между тремя попытками");
  assert.ok(!(caught as Error).message.includes(TOKEN));
  assert.ok(!(caught as Error).stack?.includes(TOKEN));
});

test("test_error_message_without_token", async () => {
  let calls = 0;
  const fetchImpl: FetchLike = async () => {
    calls += 1;
    throw new Error(`POST https://api.telegram.org/bot${TOKEN}/sendMessage failed: ECONNREFUSED`);
  };
  let caught: unknown;
  try {
    await sendTelegramMessage({
      token: TOKEN,
      chatId: CHAT_ID,
      text: "x",
      retries: 2,
      fetchImpl,
      sleepImpl: noSleep,
    });
  } catch (e) {
    caught = e;
  }
  assert.ok(caught instanceof TelegramError, `ожидался TelegramError: ${String(caught)}`);
  const error = caught as TelegramError;
  assert.ok(!error.message.includes(TOKEN), "сообщение не содержит токен");
  assert.ok(!error.stack?.includes(TOKEN), "stack не содержит токен");
  assert.ok(!error.message.includes(`bot${TOKEN}`), "сообщение не содержит bot<token>");
  assert.equal(error.kind, "network");
  assert.equal(calls, 3, "сетевая ошибка повторяется до attempts");
  // при этом исходная причина не потеряна (URL обезличен)
  assert.match(error.message, /telegram network error/);
  assert.match(error.message, /api\.telegram\.org\/bot\[REDACTED\]/);
});

// --- editTelegramMessage: правка сообщения вопроса без reply_markup ---

test("test_edit_success_without_reply_markup", async () => {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) as Record<string, unknown> });
    return okResponse(55);
  };
  await editTelegramMessage({
    token: TOKEN,
    chatId: CHAT_ID,
    messageId: 4242,
    text: "<b>✅ Вопрос отвечен</b>",
    fetchImpl,
    sleepImpl: noSleep,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `https://api.telegram.org/bot${TOKEN}/editMessageText`);
  const body = calls[0].body;
  assert.equal(body.chat_id, CHAT_ID);
  assert.equal(body.message_id, 4242);
  assert.equal(body.text, "<b>✅ Вопрос отвечен</b>");
  assert.equal(body.parse_mode, "HTML");
  assert.equal(body.disable_web_page_preview, true);
  assert.equal(body.reply_markup, undefined, "без reply_markup — кнопки исчезают");
});

test("test_edit_not_modified_is_success", async () => {
  let calls = 0;
  const sleeps: number[] = [];
  const fetchImpl: FetchLike = async () => {
    calls += 1;
    return errorResponse(400, {
      ok: false,
      error_code: 400,
      description: "Bad Request: message is not modified: message is not modified",
    });
  };
  // не бросает и не повторяет: HTTP 400 «message is not modified» — это успех
  await editTelegramMessage({
    token: TOKEN,
    chatId: CHAT_ID,
    messageId: 4242,
    text: "<b>тот же текст</b>",
    retries: 2,
    fetchImpl,
    sleepImpl: async (ms) => {
      sleeps.push(ms);
    },
  });
  assert.equal(calls, 1, "без повторов");
  assert.equal(sleeps.length, 0, "без ожидания перед повтором");
});

test("test_edit_401_no_retry_without_token", async () => {
  let calls = 0;
  const fetchImpl: FetchLike = async () => {
    calls += 1;
    return errorResponse(401, { ok: false, error_code: 401, description: "Unauthorized" });
  };
  let caught: unknown;
  try {
    await editTelegramMessage({
      token: TOKEN,
      chatId: CHAT_ID,
      messageId: 4242,
      text: "x",
      retries: 2,
      fetchImpl,
      sleepImpl: noSleep,
    });
  } catch (e) {
    caught = e;
  }
  assert.ok(caught instanceof TelegramError, `ожидался TelegramError: ${String(caught)}`);
  assert.equal((caught as TelegramError).httpStatus, 401);
  assert.equal(calls, 1, "401 не должен повторяться");
  assert.ok(!(caught as Error).message.includes(TOKEN));
  assert.ok(!(caught as Error).stack?.includes(TOKEN));
  assert.ok(!(caught as Error).message.includes(`bot${TOKEN}`));
});

test("test_edit_network_error_redacted", async () => {
  const fetchImpl: FetchLike = async () => {
    throw new Error(`POST https://api.telegram.org/bot${TOKEN}/editMessageText failed: ECONNREFUSED`);
  };
  let caught: unknown;
  try {
    await editTelegramMessage({
      token: TOKEN,
      chatId: CHAT_ID,
      messageId: 1,
      text: "x",
      retries: 0,
      fetchImpl,
      sleepImpl: noSleep,
    });
  } catch (e) {
    caught = e;
  }
  assert.ok(caught instanceof TelegramError);
  const error = caught as TelegramError;
  assert.ok(!error.message.includes(TOKEN), "сообщение не содержит токен");
  assert.match(error.message, /api\.telegram\.org\/bot\[REDACTED\]/);
});
