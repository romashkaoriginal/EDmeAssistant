const test = require("node:test");
const assert = require("node:assert/strict");
const { ContentGenerator, GENERATION_TYPES, ADJUSTMENTS, studentVersion, ANSWERS_MARKER, testQualityIssues, normalizeFreeformLatex, normalizeOptionLineBreaks, normalizeTestOptionLineBreaks, richMarkdownIssues } = require("../src/generator");

const student = { full_name: "Ivan Petrov", subject: "Russian language", grade: 8 };
const card = { currentLevel: "middle", strengths: ["reads carefully"], weaknesses: [], gaps: [], learningGoal: "test" };

function mockedGenerator(reply) {
  const generator = new ContentGenerator({ apiKey: "test-key", provider: "openrouter", model: "qwen/qwen3-32b" });
  const requests = [];
  const replies = Array.isArray(reply) ? reply : [reply];
  generator.client = { chat: { completions: { create: async (payload, options) => {
    requests.push({ ...payload, requestOptions: options });
    return { choices: [{ message: { content: replies[Math.min(requests.length - 1, replies.length - 1)] } }] };
  } } } };
  return { generator, requests };
}

function validTest() {
  const questions = Array.from({ length: 8 }, (_, index) => `${index + 1}. Choose the correct answer.\nA. First\nB. Second\nC. Third\nD. Fourth`).join("\n\n");
  const answers = Array.from({ length: 8 }, (_, index) => `${index + 1}. A — explanation`).join("\n");
  return `# Test\n\n${questions}\n\n## ${ANSWERS_MARKER}\n${answers}`;
}

function validFractionTest() {
  const question = "1. Calculate $\\frac{2}{3} \\cdot \\frac{5}{7}$.\nA. $\\frac{7}{10}$\nB. $\\frac{10}{21}$\nC. $\\frac{12}{35}$\nD. $1$";
  return `# Test: fractions\n\n${question}\n\n## ${ANSWERS_MARKER}\n1. B — $\\frac{10}{21}$`;
}

test("generator exposes all generation types", () => {
  assert.deepEqual(Object.keys(GENERATION_TYPES), ["homework", "test", "tasks"]);
  assert.equal(typeof ADJUSTMENTS.easier, "string");
  assert.equal(new ContentGenerator({ apiKey: "test-key", provider: "openrouter" }).model, "google/gemini-2.5-pro");
});

test("each user action sends exactly one request without a client timeout", async () => {
  const material = "# Material\n\nWrite a short explanation.";
  const { generator, requests } = mockedGenerator([material, validTest(), material, material, "Brief answer."]);
  await generator.generate({ type: "homework", student, card, topic: "topic" });
  await generator.generate({ type: "test", student, card, topic: "topic" });
  await generator.generate({ type: "tasks", student, card, topic: "topic" });
  await generator.solutions({ student, topic: "topic", previousResult: material });
  await generator.freeform({ question: "How should I explain this topic?" });
  assert.equal(requests.length, 5);
  for (const request of requests) {
    assert.equal(request.model, "qwen/qwen3-32b");
    assert.equal(request.requestOptions, undefined);
    assert.equal(request.response_format, undefined);
  }
});

test("invalid generated material receives one same-model repair attempt", async () => {
  const broken = "# Test\n\n1. Incomplete question\nA. One";
  const { generator, requests } = mockedGenerator([broken, validTest()]);
  const { result } = await generator.generate({ type: "test", student, card, topic: "topic" });
  assert.equal(result, validTest());
  assert.equal(requests.length, 2);
  assert.equal(requests[1].model, requests[0].model);
  assert.match(requests[1].messages.at(-1).content, /Ответы для репетитора/);
});

test("Gemini Flash receives a bounded thinking budget in the same request", async () => {
  const { generator, requests } = mockedGenerator("Brief answer.");
  generator.model = "google/gemini-2.5-flash";
  await generator.freeform({ question: "How should I explain this topic?" });
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].reasoning, { max_tokens: 2048, exclude: true });
});

test("Gemini Pro reserves output space and retries only an empty provider error", async () => {
  const generator = new ContentGenerator({ apiKey: "test-key", provider: "openrouter", model: "google/gemini-2.5-pro" });
  const requests = [];
  generator.client = { chat: { completions: { create: async (payload) => {
    requests.push(payload);
    if (requests.length === 1) {
      return {
        model: payload.model,
        choices: [{ finish_reason: "error", message: { content: "", reasoning: "internal" } }],
        usage: { prompt_tokens: 100, completion_tokens: 2000, total_tokens: 2100 },
      };
    }
    return { model: payload.model, choices: [{ finish_reason: "stop", message: { content: "Brief answer." } }] };
  } } } };

  const { result } = await generator.freeform({ question: "Explain a school topic." });
  assert.equal(result, "Brief answer.");
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[0].reasoning, { max_tokens: 2048, exclude: true });
  assert.deepEqual(requests[1].reasoning, { max_tokens: 1024, exclude: true });
});

test("generation prompt includes the card, topic, adjustment and self-check", async () => {
  const { generator, requests } = mockedGenerator("# Material\n\nText.");
  await generator.generate({ type: "tasks", student, card, topic: "subordinate clauses", adjustment: "easier", previousResult: "old result" });
  const [request] = requests;
  assert.equal(request.messages[2].content, "old result");
  assert.equal(request.messages[3].content, ADJUSTMENTS.easier);
  assert.match(request.messages[0].content, /Работай в два внутренних этапа/);
  assert.match(request.messages[1].content, /subordinate clauses/);
});

test("local validators reject bad keys and unsupported formatting", () => {
  const invalidKey = validFractionTest().replace("B. $\\frac{10}{21}$", "B. $\\frac{2}{3}$");
  assert.match(testQualityIssues(invalidKey).join("; "), /ключ/);
  assert.match(richMarkdownIssues({ text: "# Title\n\n$\\begin{array}x\\end{array}$", type: "homework", student, topic: "topic" }).join("; "), /LaTeX/);
});

test("option normalizers put choices on separate lines", () => {
  assert.equal(normalizeOptionLineBreaks("Question. A) one B) two C) three D) four"), "Question.\n\nA) one\n\nB) two\n\nC) three\n\nD) four");
  assert.equal(
    normalizeOptionLineBreaks("Question. \u0410) one \u0411) two \u0412) three \u0413) four"),
    "Question.\n\nA) one\n\nB) two\n\nC) three\n\nD) four",
  );
  assert.match(normalizeTestOptionLineBreaks("1. Question\nA. One B. Two C. Three D. Four"), /A\. One\n\nB\. Two\n\nC\. Three\n\nD\. Four/);
});

test("empty provider output has safe diagnostics", async () => {
  const { generator } = mockedGenerator("");
  generator.client.chat.completions.create = async () => ({ model: "deepseek/deepseek-v4-pro", choices: [{ finish_reason: "length", message: { content: "", reasoning: "internal reasoning" } }], usage: { prompt_tokens: 120, completion_tokens: 4000, total_tokens: 4120, completion_tokens_details: { reasoning_tokens: 3900 } } });
  await assert.rejects(() => generator.generate({ type: "homework", student, card, topic: "topic" }), (error) => error.code === "AI_EMPTY_RESPONSE" && error.aiResponse.finishReason === "length" && error.aiResponse.contentLength === 0);
});

test("freeform normalizes LaTeX and never performs a verifier request", async () => {
  const { generator, requests } = mockedGenerator(String.raw`Example: $ \frac{2}{5} \div \frac{4}{10} = 1 $.`);
  const { result } = await generator.freeform({ question: "How to divide fractions?" });
  assert.equal(result, String.raw`Example: $\frac{2}{5} \div \frac{4}{10} = 1$.`);
  assert.equal(requests.length, 1);
  assert.equal(normalizeFreeformLatex(String.raw`$$ \\frac{3}{4} $$`), String.raw`$$\frac{3}{4}$$`);
});

test("student version strips the answer key and configuration errors are explicit", async () => {
  const source = `# Test\n\n1. Question\nA. Yes\n\n${ANSWERS_MARKER}\n1. A`;
  assert.equal(studentVersion(source), "# Test\n\n1. Question\nA. Yes");
  const generator = new ContentGenerator({ apiKey: null, provider: "openrouter" });
  await assert.rejects(() => generator.generate({ type: "homework", student, card, topic: "topic" }), (error) => error.code === "AI_NOT_CONFIGURED");
});
