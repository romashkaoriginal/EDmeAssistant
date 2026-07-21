const test = require("node:test");
const assert = require("node:assert/strict");
const { escapeHtml, normalizeRichMarkdown, richMarkdownToPlainText } = require("../src/telegram/text");
const { sendRichMarkdown } = require("../src/telegram");

test("escapeHtml neutralizes Telegram HTML control characters", () => {
  assert.equal(escapeHtml('<tag attr="x">Tom & Jerry</tag>'), "&lt;tag attr=&quot;x&quot;&gt;Tom &amp; Jerry&lt;/tag&gt;");
});

test("richMarkdownToPlainText keeps formulas readable in a fallback message", () => {
  assert.equal(richMarkdownToPlainText(String.raw`# Fractions\n\n$\frac{3}{4}$`), "Fractions\\n\\n(3)/(4)");
});

test("normalizeRichMarkdown trims padding inside LaTeX delimiters", () => {
  assert.equal(normalizeRichMarkdown("$ x^2 - 4 \\leq 0 $"), "$x^2 - 4 \\leq 0$");
});

test("sendRichMarkdown sends Rich Markdown and preserves the keyboard", async () => {
  const calls = [];
  const bot = { sendRichMessage: async (...args) => calls.push(args) };
  const keyboard = { inline_keyboard: [] };
  await sendRichMarkdown(bot, 42, "# Title", { reply_markup: keyboard });
  assert.deepEqual(calls, [[42, { markdown: "# Title" }, { reply_markup: keyboard }]]);
});

test("sendRichMarkdown renders inline options as separate Markdown blocks", async () => {
  const calls = [];
  const bot = { sendRichMessage: async (...args) => calls.push(args) };
  await sendRichMarkdown(bot, 42, "1. Choose. A. one B. two C. three D. four");
  assert.equal(calls[0][1].markdown, "1. Choose.\n- **A.** one\n- **B.** two\n- **C.** three\n- **D.** four");
});

test("sendRichMarkdown falls back to readable plain text when markup is rejected", async () => {
  const calls = [];
  const bot = {
    sendRichMessage: async () => { throw new Error("bad rich message"); },
    sendMessage: async (...args) => calls.push(args),
  };
  await sendRichMarkdown(bot, 42, String.raw`$\frac{3}{4}$`);
  assert.deepEqual(calls, [[42, "(3)/(4)", undefined]]);
});
