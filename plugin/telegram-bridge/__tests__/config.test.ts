// Тесты config.ts — парсинг .env, приоритет process.env, валидация секретов, дефолты, clamp.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError, loadBridgeConfig, loadEnvFile } from "../config.ts";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "tb-config-"));
}

test("test_env_parsing", () => {
  const dir = tmp();
  try {
    const envFile = join(dir, ".env");
    writeFileSync(
      envFile,
      [
        "# комментарий",
        "",
        'export TG_BOT_TOKEN="123456:ABC-DEF_secret"',
        "TG_CHAT_ID='-100123'",
        "PLAIN=without-quotes",
        "  SPACED = value with spaces  ",
        "NO_EQUALS_SIGN",
        "EMPTY_VALUE=",
        "WEIRD=has=equals=inside",
        "BAD KEY=1",
        "",
      ].join("\n"),
      "utf8",
    );
    const parsed = loadEnvFile(envFile);
    assert.equal(parsed.TG_BOT_TOKEN, "123456:ABC-DEF_secret");
    assert.equal(parsed.TG_CHAT_ID, "-100123");
    assert.equal(parsed.PLAIN, "without-quotes");
    assert.equal(parsed.SPACED, "value with spaces");
    assert.equal(parsed.EMPTY_VALUE, "");
    assert.equal(parsed.WEIRD, "has=equals=inside");
    assert.equal("NO_EQUALS_SIGN" in parsed, false);
    assert.equal("BAD KEY" in parsed, false);
    assert.deepEqual(loadEnvFile(join(dir, "missing.env")), {});
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("test_process_env_precedence", () => {
  const dir = tmp();
  try {
    const envFile = join(dir, ".env");
    writeFileSync(envFile, "TG_BOT_TOKEN=file-token\nTG_CHAT_ID=111222333\n", "utf8");
    const config = loadBridgeConfig({
      configDir: dir,
      envFile,
      env: { TG_BOT_TOKEN: "env-token", TG_CHAT_ID: "444555666" },
    });
    assert.equal(config.token, "env-token");
    assert.equal(config.chatId, "444555666");
    assert.notEqual(config.token, "file-token");

    // пустая строка в process.env не перекрывает значение из файла
    const fromFile = loadBridgeConfig({
      configDir: dir,
      envFile,
      env: { TG_BOT_TOKEN: "", TG_CHAT_ID: "" },
    });
    assert.equal(fromFile.token, "file-token");
    assert.equal(fromFile.chatId, "111222333");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("test_missing_token_returns_config_error", () => {
  const dir = tmp();
  try {
    const envFile = join(dir, ".env");
    writeFileSync(envFile, "TG_CHAT_ID=999888777\n", "utf8");
    let caught: unknown;
    try {
      loadBridgeConfig({ configDir: dir, envFile, env: {} });
    } catch (e) {
      caught = e;
    }
    assert.ok(caught instanceof ConfigError, `ожидался ConfigError, получено: ${String(caught)}`);
    const message = (caught as Error).message;
    assert.match(message, /TG_BOT_TOKEN/);
    // текст ошибки не содержит значений секретов
    assert.ok(!message.includes("999888777"), "сообщение не должно содержать TG_CHAT_ID");
    assert.ok(!message.includes("file-token"), "сообщение не должно содержать токен");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("test_invalid_chat_id_rejected", () => {
  const dir = tmp();
  try {
    let caught: unknown;
    try {
      loadBridgeConfig({
        configDir: dir,
        envFile: join(dir, "missing.env"),
        env: { TG_BOT_TOKEN: "123:abc", TG_CHAT_ID: "not-a-number" },
      });
    } catch (e) {
      caught = e;
    }
    assert.ok(caught instanceof ConfigError, `ожидался ConfigError, получено: ${String(caught)}`);
    const message = (caught as Error).message;
    assert.match(message, /TG_CHAT_ID/);
    assert.ok(!message.includes("not-a-number"), "значение секрета не должно попадать в текст ошибки");

    // допустимые форматы
    const ok = loadBridgeConfig({
      configDir: dir,
      envFile: join(dir, "missing.env"),
      env: { TG_BOT_TOKEN: "123:abc", TG_CHAT_ID: "-100123456" },
    });
    assert.equal(ok.chatId, "-100123456");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("test_notifier_defaults", () => {
  const dir = tmp();
  try {
    const config = loadBridgeConfig({
      configDir: dir,
      envFile: join(dir, "missing.env"),
      env: { TG_BOT_TOKEN: "123:abc", TG_CHAT_ID: "7" },
    });
    assert.equal(config.enabled, true);
    assert.equal(config.notifyOnError, true);
    assert.equal(config.notifyOnAbort, true);
    assert.equal(config.notifyOnQuestion, true);
    assert.equal(config.includeModel, true);
    assert.equal(config.includeProject, true);
    assert.equal(config.includeDuration, true);
    assert.equal(config.maxTaskChars, 120);
    assert.equal(config.maxResultChars, 800);
    assert.equal(config.minResultChars, 40);
    assert.equal(config.timeoutMs, 5000);
    assert.equal(config.retries, 2);
    assert.equal(config.stateTtlDays, 7);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("test_values_clamped", () => {
  const dir = tmp();
  try {
    writeFileSync(
      join(dir, "telegram-bridge.json"),
      JSON.stringify({
        enabled: false,
        includeModel: false,
        timeoutMs: 5,
        retries: 99,
        maxTaskChars: 1,
        maxResultChars: 5,
        minResultChars: -5,
        stateTtlDays: 1000,
      }),
      "utf8",
    );
    const low = loadBridgeConfig({
      configDir: dir,
      envFile: join(dir, "missing.env"),
      env: { TG_BOT_TOKEN: "123:abc", TG_CHAT_ID: "7" },
    });
    assert.equal(low.timeoutMs, 1000);
    assert.equal(low.retries, 5);
    assert.equal(low.maxTaskChars, 20);
    assert.equal(low.maxResultChars, 100);
    assert.equal(low.minResultChars, 0, "minResultChars зажимается снизу до 0");
    assert.equal(low.stateTtlDays, 30);
    assert.equal(low.enabled, false, "булевы значения не подвергаются clamp");
    assert.equal(low.includeModel, false);

    writeFileSync(
      join(dir, "telegram-bridge.json"),
      JSON.stringify({ timeoutMs: 999999, retries: -7, maxTaskChars: 5000, maxResultChars: 99999, minResultChars: 99999999, stateTtlDays: 0 }),
      "utf8",
    );
    const high = loadBridgeConfig({
      configDir: dir,
      envFile: join(dir, "missing.env"),
      env: { TG_BOT_TOKEN: "123:abc", TG_CHAT_ID: "7" },
    });
    assert.equal(high.timeoutMs, 30000);
    assert.equal(high.retries, 0);
    assert.equal(high.maxTaskChars, 300);
    assert.equal(high.maxResultChars, 3500);
    assert.equal(high.minResultChars, 100000, "minResultChars зажимается сверху до 100000");
    assert.equal(high.stateTtlDays, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("test_min_result_chars_custom_value", () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, "telegram-bridge.json"), JSON.stringify({ minResultChars: 150 }), "utf8");
    const custom = loadBridgeConfig({
      configDir: dir,
      envFile: join(dir, "missing.env"),
      env: { TG_BOT_TOKEN: "123:abc", TG_CHAT_ID: "7" },
    });
    assert.equal(custom.minResultChars, 150);

    // не-число → дефолт, дробное → округление (как у прочих clamp-опций)
    writeFileSync(join(dir, "telegram-bridge.json"), JSON.stringify({ minResultChars: "abc" }), "utf8");
    const fallback = loadBridgeConfig({
      configDir: dir,
      envFile: join(dir, "missing.env"),
      env: { TG_BOT_TOKEN: "123:abc", TG_CHAT_ID: "7" },
    });
    assert.equal(fallback.minResultChars, 40);

    writeFileSync(join(dir, "telegram-bridge.json"), JSON.stringify({ minResultChars: 42.6 }), "utf8");
    const rounded = loadBridgeConfig({
      configDir: dir,
      envFile: join(dir, "missing.env"),
      env: { TG_BOT_TOKEN: "123:abc", TG_CHAT_ID: "7" },
    });
    assert.equal(rounded.minResultChars, 43);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
