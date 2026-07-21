const test = require("node:test");
const assert = require("node:assert/strict");
const { escapeHtml, normalizeRichMarkdown, richMarkdownToPlainText } = require("../src/telegram/text");
const { sendRichMarkdown } = require("../src/telegram");

test("escapeHtml neutralizes Telegram HTML control characters", () => {
  assert.equal(escapeHtml('<tag attr="x">Tom & Jerry\'s</tag>'), "&lt;tag attr=&quot;x&quot;&gt;Tom &amp; Jerry&#39;s&lt;/tag&gt;");
  assert.equal(escapeHtml(null), "");
});

test("richMarkdownToPlainText keeps formulas readable in a fallback message", () => {
  const markdown = String.raw`# Дроби

**Пример:** $\frac{3}{4} + \frac{1}{8} = \frac{7}{8}$`;
  assert.equal(richMarkdownToPlainText(markdown), "Дроби\n\nПример: (3)/(4) + (1)/(8) = (7)/(8)");
});

test("normalizeRichMarkdown trims padding inside LaTeX delimiters", () => {
  const markdown = String.raw`- $ y = x^2 $
- $ x^2 - 4 \leq 0 $
Решения: $ (-\infty; -2) $, $ [-2; 2] $

$$ \frac{a}{b} = c $$`;
  assert.equal(
    normalizeRichMarkdown(markdown),
    String.raw`- $y = x^2$
- $x^2 - 4 \leq 0$
Решения: $(-\infty; -2)$, $[-2; 2]$

$$\frac{a}{b} = c$$`,
  );
});

test("normalizeRichMarkdown leaves inline code untouched", () => {
  const markdown = String.raw`Формула \`$ x^2 $\` как пример и обычная $ y = x + 1 $`;
  assert.equal(normalizeRichMarkdown(markdown), String.raw`Формула \`$ x^2 $\` как пример и обычная $y = x + 1$`);
});

test("normalizeRichMarkdown turns unsupported LaTeX arrays into Telegram-safe list items", () => {
  const markdown = String.raw`Решение:

$\left\{\begin{array}{l} h(x) > 1 \vee f(x) < g(x) \text{(если знак)} \\ h(x) < 1 \vee g(x) > 0 \text{(строгий)} \end{array}\right.$`;

  assert.equal(
    normalizeRichMarkdown(markdown),
    String.raw`Решение:

- $h(x) > 1 \vee f(x) < g(x)$ — (если знак)
- $h(x) < 1 \vee g(x) > 0$ — (строгий)`,
  );
});

test("sendRichMarkdown sends normalized LaTeX through Telegram rich messages and keeps the keyboard", async () => {
  const calls = [];
  const bot = {
    sendRichMessage: async (...args) => calls.push(args),
    sendMessage: async () => { throw new Error("plain fallback must not be used"); },
  };
  const keyboard = { inline_keyboard: [[{ text: "Готово", callback_data: "done" }]] };
  const markdown = String.raw`# Дроби

 $ \frac{3}{4} + \frac{1}{8} $`;

  await sendRichMarkdown(bot, 42, markdown, { reply_markup: keyboard });

  assert.deepEqual(calls, [[42, { markdown: String.raw`# Дроби

 $\frac{3}{4} + \frac{1}{8}$` }, { reply_markup: keyboard }]]);
});

test("sendRichMarkdown falls back to readable plain text when Telegram rejects markup", async () => {
  const calls = [];
  const bot = {
    sendRichMessage: async () => { throw new Error("bad rich message"); },
    sendMessage: async (...args) => calls.push(args),
  };

  await sendRichMarkdown(bot, 42, String.raw`$\frac{3}{4}$`);

  assert.deepEqual(calls, [[42, "(3)/(4)", undefined]]);
});
