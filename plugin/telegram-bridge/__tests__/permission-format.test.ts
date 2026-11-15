// Тесты format.ts (спринт 3) — permission-уведомление:
// три кнопки, callback_data ≤64 байт, экранирование title/pattern, лимит 3900.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeBridgeConfig } from "../config.ts";
import {
  buildPermissionKeyboard,
  formatPermission,
  MAX_MESSAGE_CHARS,
} from "../format.ts";

const config = () => makeBridgeConfig({ token: "", chatId: "" });
const RID = "abc123def456";

test("test_three_buttons", () => {
  const markup = buildPermissionKeyboard(RID);
  assert.equal(markup.inline_keyboard.length, 1, "ровно одна строка кнопок");
  const buttons = markup.inline_keyboard[0];
  assert.equal(buttons.length, 3, "ровно три кнопки");
  assert.deepEqual(
    buttons.map((b) => b.callback_data),
    [`perm:${RID}:once`, `perm:${RID}:always`, `perm:${RID}:reject`],
  );
  assert.deepEqual(
    buttons.map((b) => b.text),
    ["✅ Разрешить", "🔁 Всегда", "❌ Отклонить"],
  );
  for (const button of buttons) {
    assert.match(button.callback_data, /^perm:[0-9a-f]{12}:(once|always|reject)$/);
  }
});

test("test_callback_data_within_64", () => {
  const buttons = buildPermissionKeyboard(RID).inline_keyboard[0];
  for (const button of buttons) {
    const bytes = Buffer.byteLength(button.callback_data, "utf8");
    assert.ok(bytes <= 64, `${button.callback_data} = ${bytes} байт > 64`);
  }
  // длина: perm:(5) + rid(12) + :(1) + action → once=22, always/reject=24 байта ≤ 64
  assert.equal(Buffer.byteLength(`perm:${RID}:once`, "utf8"), 22);
  assert.equal(Buffer.byteLength(`perm:${RID}:always`, "utf8"), 24);
  assert.equal(Buffer.byteLength(`perm:${RID}:reject`, "utf8"), 24);
  assert.equal(RID.length, 12, "rid ровно 12 символов");
});

test("test_title_html_escaped", () => {
  const html = formatPermission(
    {
      title: 'Run <script> & "cmd" > x',
      pattern: "**/a&b<c>?",
      sessionShort: "abcd1234",
      rid: RID,
    },
    config(),
  );
  assert.ok(html.includes("&lt;script&gt;"), "< экранирован в title");
  assert.ok(html.includes("&amp;"), "& экранирован в title/pattern");
  assert.ok(html.includes("&gt;"), "> экранирован в title");
  assert.ok(!html.includes("<script>"), "сырой тег не попадает в текст");
  assert.ok(html.includes("<b>🔐 Запрос разрешения</b>"));
  assert.ok(html.includes("<b>Сессия:</b> <code>abcd1234</code>"));
  assert.ok(html.includes("<b>Действие:</b>"));
  assert.ok(html.includes("a&amp;b&lt;c&gt;"), "pattern тоже экранирован");
});

test("test_total_length_le_3900", () => {
  const html = formatPermission(
    {
      title: "&".repeat(5000),
      pattern: "<".repeat(5000),
      sessionShort: "x".repeat(500),
      rid: RID,
    },
    config(),
  );
  assert.ok(html.length <= MAX_MESSAGE_CHARS, `длина ${html.length} > ${MAX_MESSAGE_CHARS}`);
  for (const tag of ["b", "code"]) {
    const open = (html.match(new RegExp(`<${tag}>`, "g")) ?? []).length;
    const close = (html.match(new RegExp(`</${tag}>`, "g")) ?? []).length;
    assert.equal(open, close, `тег ${tag} не закрыт`);
  }
  assert.ok(html.startsWith("<b>🔐 Запрос разрешения</b>"));
});
