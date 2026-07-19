const test = require("node:test");
const assert = require("node:assert/strict");
const { createCallbackHandler } = require("../src/telegram/callback-handler");
const { AiCallGuard } = require("../src/telegram/rate-limiter");

test("students callback delegates to the injected list handler and answers the callback", async () => {
  const calls = [];
  const handler = createCallbackHandler({
    bot: { answerCallbackQuery: () => ({ catch: () => {} }), sendMessage: async () => {} },
    database: { getTutorByTelegramId: async () => ({ id: 7 }) },
    analyzer: null,
    generator: null,
    sessions: null,
    logout: async () => {},
    refreshStudents: async () => {},
    sendStudentList: async (tutor, chatId) => calls.push([tutor.id, chatId]),
    sendGeneration: async () => {},
    formatDate: () => "",
    studentCardText: () => "",
    cardFieldValueText: () => "",
    materialsText: () => "",
    HELP_TEXT: "",
    FEEDBACK_REASONS: {},
    CARD_FIELDS: {},
    GENERATION_TYPES: {},
    studentVersion: () => "",
    runLessonAnalysis: async () => {},
  });

  await handler({ id: "callback-1", data: "students", from: { id: 42 }, message: { chat: { id: 99 } } });
  assert.deepEqual(calls, [[7, 99]]);
});

test("analysis callback notifies the user before invoking AI", async () => {
  const calls = [];
  const handler = createCallbackHandler({
    bot: {
      answerCallbackQuery: () => ({ catch: () => {} }),
      sendMessage: async (...args) => calls.push(["send", ...args]),
    },
    database: {
      getTutorByTelegramId: async () => ({ id: 7 }),
      getTranscript: async () => ({ id: 5, studentId: 11, text: "Текст" }),
      getStudent: async () => ({ id: 11 }),
    },
    analyzer: {},
    generator: null,
    sessions: null,
    aiGuard: new AiCallGuard(),
    logout: async () => {},
    refreshStudents: async () => {},
    sendStudentList: async () => {},
    sendGeneration: async () => {},
    sendChunked: async () => {},
    sendDraft: async (chatId, draft) => calls.push(["draft", chatId, draft.id]),
    formatDate: () => "",
    studentCardText: () => "",
    cardFieldValueText: () => "",
    draftFieldValueText: () => "",
    materialsText: () => "",
    HELP_TEXT: "",
    FEEDBACK_REASONS: {},
    CARD_FIELDS: {},
    DRAFT_FIELDS: {},
    GENERATION_TYPES: {},
    studentVersion: () => "",
    runLessonAnalysis: async () => {
      calls.push(["ai"]);
      return { id: 12, changes: { lessonTopic: "Тема", gaps: [], recommendations: [] } };
    },
  });

  await handler({ id: "callback-2", data: "analyze:5", from: { id: 42 }, message: { chat: { id: 99 } } });

  assert.equal(calls[0][0], "send");
  assert.match(calls[0][2], /Анализирую расшифровку/);
  assert.equal(calls[1][0], "ai");
  assert.deepEqual(calls[2], ["draft", 99, 12]);
});

test("a second AI action while one is running is rejected by the busy guard", async () => {
  const calls = [];
  let resolveAnalysis;
  const analysisStarted = new Promise((resolve) => { resolveAnalysis = resolve; });
  const handler = createCallbackHandler({
    bot: {
      answerCallbackQuery: () => ({ catch: () => {} }),
      sendMessage: async (...args) => calls.push(["send", args[1]]),
    },
    database: {
      getTutorByTelegramId: async () => ({ id: 7 }),
      getTranscript: async () => ({ id: 5, studentId: 11, text: "Текст" }),
      getStudent: async () => ({ id: 11 }),
    },
    analyzer: {},
    generator: null,
    sessions: null,
    aiGuard: new AiCallGuard(),
    logout: async () => {},
    refreshStudents: async () => {},
    sendStudentList: async () => {},
    sendGeneration: async () => {},
    sendChunked: async () => {},
    sendDraft: async () => calls.push(["draft"]),
    formatDate: () => "",
    studentCardText: () => "",
    cardFieldValueText: () => "",
    draftFieldValueText: () => "",
    materialsText: () => "",
    HELP_TEXT: "",
    FEEDBACK_REASONS: {},
    CARD_FIELDS: {},
    DRAFT_FIELDS: {},
    GENERATION_TYPES: {},
    studentVersion: () => "",
    runLessonAnalysis: () => analysisStarted.then(() => ({ id: 12, changes: {} })),
  });

  const first = handler({ id: "cb-1", data: "analyze:5", from: { id: 42 }, message: { chat: { id: 99 } } });
  await new Promise((resolve) => setImmediate(resolve));
  await handler({ id: "cb-2", data: "analyze:5", from: { id: 42 }, message: { chat: { id: 99 } } });
  resolveAnalysis();
  await first;

  assert.ok(calls.some(([, text]) => /ещё выполняется/.test(String(text))), `expected busy message, got ${JSON.stringify(calls)}`);
  assert.equal(calls.filter(([type]) => type === "draft").length, 1);
});

test("menu callback delegates to the injected menu handler", async () => {
  const calls = [];
  const handler = createCallbackHandler({
    bot: { answerCallbackQuery: () => ({ catch: () => {} }), sendMessage: async () => {} },
    database: { getTutorByTelegramId: async () => ({ id: 7 }) },
    analyzer: null,
    generator: null,
    sessions: null,
    logout: async () => {},
    refreshStudents: async () => {},
    sendStudentList: async () => {},
    sendGeneration: async () => {},
    menu: async (chatId) => calls.push(["menu", chatId]),
    formatDate: () => "",
    studentCardText: () => "",
    cardFieldValueText: () => "",
    materialsText: () => "",
    HELP_TEXT: "",
    FEEDBACK_REASONS: {},
    CARD_FIELDS: {},
    GENERATION_TYPES: {},
    studentVersion: () => "",
    runLessonAnalysis: async () => {},
  });

  await handler({ id: "callback-menu", data: "menu", from: { id: 42 }, message: { chat: { id: 99 } } });
  assert.deepEqual(calls, [["menu", 99]]);
});

test("deep profile callback analyzes only new transcripts from oldest to newest and shows a draft", async () => {
  const calls = [];
  const transcripts = [
    { id: 2, lessonDate: "2026-07-02", text: "Новый урок" },
    { id: 1, lessonDate: "2026-07-01", text: "Старый урок" },
  ];
  const handler = createCallbackHandler({
    bot: {
      answerCallbackQuery: () => ({ catch: () => {} }),
      sendMessage: async (...args) => calls.push(["send", ...args]),
    },
    database: {
      getTutorByTelegramId: async () => ({ id: 7 }),
      getStudent: async () => ({ id: 11, full_name: "Ученик" }),
      listTranscripts: async () => transcripts,
      getCard: async () => ({ currentLevel: null, sourceTranscriptIds: [1] }),
    },
    analyzer: {},
    generator: null,
    sessions: null,
    aiGuard: new AiCallGuard(),
    logout: async () => {},
    refreshStudents: async () => {},
    sendStudentList: async () => {},
    sendGeneration: async () => {},
    sendProfileDraft: async (chatId, draft) => calls.push(["draft", chatId, draft.id]),
    backToStudentRow: () => [],
    CARD_FIELDS: {},
    DRAFT_FIELDS: {},
    PROFILE_DRAFT_FIELDS: {},
    GENERATION_TYPES: {},
    runProfileAnalysis: async ({ transcripts: ordered }) => {
      calls.push(["ai", ordered.map((item) => item.id)]);
      return { id: 31 };
    },
  });

  await handler({ id: "profile-callback", data: "deepProfile:11", from: { id: 42 }, message: { chat: { id: 99 } } });

  assert.match(calls[0][2], /1 новых расшифровок/);
  assert.deepEqual(calls[1], ["ai", [2]]);
  assert.deepEqual(calls[2], ["draft", 99, 31]);
});

test("deep profile callback skips AI when every transcript is already in the card", async () => {
  const calls = [];
  const handler = createCallbackHandler({
    bot: {
      answerCallbackQuery: () => ({ catch: () => {} }),
      sendMessage: async (...args) => calls.push(args),
    },
    database: {
      getTutorByTelegramId: async () => ({ id: 7 }),
      getStudent: async () => ({ id: 11 }),
      listTranscripts: async () => [{ id: 2, text: "Урок" }, { id: 1, text: "Урок" }],
      getCard: async () => ({ sourceTranscriptIds: [1, 2] }),
    },
    analyzer: {}, generator: null, sessions: null,
    aiGuard: new AiCallGuard(), logout: async () => {}, refreshStudents: async () => {},
    sendStudentList: async () => {}, sendGeneration: async () => {}, sendProfileDraft: async () => {},
    backToStudentRow: () => [], CARD_FIELDS: {}, DRAFT_FIELDS: {}, PROFILE_DRAFT_FIELDS: {}, GENERATION_TYPES: {},
    runProfileAnalysis: async () => { throw new Error("AI must not run"); },
  });

  await handler({ id: "profile-current", data: "deepProfile:11", from: { id: 42 }, message: { chat: { id: 99 } } });

  assert.match(calls[0][1], /Новых уроков для анализа нет/);
});

test("editCard menu offers a way back to the student's card instead of a dead end", async () => {
  const calls = [];
  const handler = createCallbackHandler({
    bot: {
      answerCallbackQuery: () => ({ catch: () => {} }),
      sendMessage: async (...args) => calls.push(args),
    },
    database: {
      getTutorByTelegramId: async () => ({ id: 7 }),
      getStudent: async () => ({ id: 11, full_name: "Ученик" }),
    },
    analyzer: null,
    generator: null,
    sessions: null,
    logout: async () => {},
    refreshStudents: async () => {},
    sendStudentList: async () => {},
    sendGeneration: async () => {},
    backToStudentRow: (studentId) => [{ text: "⬅️ К карточке", callback_data: `student:${studentId}` }, { text: "🏠 Меню", callback_data: "menu" }],
    formatDate: () => "",
    studentCardText: () => "",
    cardFieldValueText: () => "",
    materialsText: () => "",
    HELP_TEXT: "",
    FEEDBACK_REASONS: {},
    CARD_FIELDS: { currentLevel: { label: "Уровень ученика", type: "text" } },
    GENERATION_TYPES: {},
    studentVersion: () => "",
    runLessonAnalysis: async () => {},
  });

  await handler({ id: "callback-editcard", data: "editCard:11", from: { id: 42 }, message: { chat: { id: 99 } } });

  const [, , options] = calls[0];
  const flatButtons = options.reply_markup.inline_keyboard.flat();
  assert.ok(flatButtons.some((button) => button.callback_data === "student:11"), "expected a back-to-card button");
  assert.ok(flatButtons.some((button) => button.callback_data === "menu"), "expected a back-to-menu button");
});

test("student menu no longer offers the manual transcript upload button", async () => {
  const { createBot } = require("../src/telegram");
  // studentMenuKeyboard is internal to createBot; exercise it indirectly via
  // a stubbed database/bot so no network or Telegram token is needed.
  const sentKeyboards = [];
  const bot = createBot({
    token: "123:test-token",
    database: {
      getTutorByTelegramId: async () => ({ id: 7 }),
      getStudent: async () => ({ id: 11, full_name: "Ученик", subject: "Математика", grade: 8 }),
      getCard: async () => ({}),
      listRecentLessons: async () => [],
      getUpcomingLesson: async () => null,
    },
    analyzer: null,
    moyKlass: { isConfigured: () => false },
    generator: null,
  });
  bot.sendMessage = async (chatId, text, options) => { sentKeyboards.push(options); return {}; };
  bot.answerCallbackQuery = async () => {};

  const handler = bot.listeners("callback_query")[0];
  await handler({ id: "cb", data: "student:11", from: { id: 42 }, message: { chat: { id: 99 } } });

  const keyboardTexts = sentKeyboards.flatMap((options) => options.reply_markup.inline_keyboard.flat().map((button) => button.text));
  assert.ok(!keyboardTexts.includes("Добавить расшифровку"), `expected no manual transcript button, got ${JSON.stringify(keyboardTexts)}`);
  assert.ok(keyboardTexts.includes("🧠 Собрать карточку по всем урокам"), "expected the deep profile analysis button");
  assert.ok(keyboardTexts.some((text) => text.includes("К ученикам")), "expected a back-to-list button");
  assert.ok(keyboardTexts.some((text) => text.includes("Меню")), "expected a back-to-menu button");
});
