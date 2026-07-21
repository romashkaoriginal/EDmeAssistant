const test = require("node:test");
const assert = require("node:assert/strict");
const { createMessageHandler, generationErrorText } = require("../src/telegram/message-handler");

test("generation failures are explained without exposing provider internals", () => {
  assert.match(generationErrorText({ code: "AI_EMPTY_RESPONSE" }), /не вернул материал/);
  assert.match(generationErrorText({ code: "AI_GENERATION_VALIDATION_FAILED" }), /неподдерживаемом формате/);
  assert.match(generationErrorText({ status: 429 }), /перегружен/);
});

test("login scenario uses the shared contact's phone number and clears the persisted session", async () => {
  const calls = [];
  const handler = createMessageHandler({
    bot: { sendMessage: async (...args) => calls.push(["send", ...args]) },
    database: {
      getTutorByPhone: async (phone) => { calls.push(["lookup", phone]); return { id: 7 }; },
      bindTutorTelegramId: async () => ({ id: 7, full_name: "Ирина" }),
      getTutorByTelegramId: async () => ({ id: 7, full_name: "Ирина", is_admin: false }),
    },
    generator: null,
    sessions: {
      get: async () => ({ action: "identity" }),
      delete: async (id) => calls.push(["delete", id]),
    },
    handleFreeform: async () => {},
    menu: async (chatId, tutor) => calls.push(["menu", chatId, tutor?.id]),
    refreshStudents: async (tutor, chatId) => calls.push(["refresh", tutor.id, chatId]),
    sendGeneration: async () => {},
    CARD_FIELDS: {},
    cardFieldValueText: () => "",
    materialsText: () => "",
  });

  await handler({ contact: { phone_number: "+375291234567", user_id: 42 }, from: { id: 42 }, chat: { id: 99 } });

  assert.deepEqual(calls, [
    ["lookup", "+375291234567"],
    ["delete", 42],
    ["send", 99, "Вы вошли как Ирина.", { reply_markup: { remove_keyboard: true } }],
    ["menu", 99, 7],
    ["refresh", 7, 99],
  ]);
});

test("a shared contact belonging to someone else is rejected", async () => {
  const calls = [];
  const handler = createMessageHandler({
    bot: { sendMessage: async (...args) => calls.push(["send", ...args]) },
    database: {
      getTutorByPhone: async () => { throw new Error("should not be called"); },
      bindTutorTelegramId: async () => { throw new Error("should not be called"); },
    },
    generator: null,
    sessions: { get: async () => ({ action: "identity" }) },
    handleFreeform: async () => {},
    menu: async () => {},
    refreshStudents: async () => {},
    sendGeneration: async () => {},
    CARD_FIELDS: {},
    cardFieldValueText: () => "",
    materialsText: () => "",
  });

  await handler({ contact: { phone_number: "+375291234567", user_id: 999 }, from: { id: 42 }, chat: { id: 99 } });

  assert.equal(calls.length, 1);
  assert.match(calls[0][2], /своим собственным номером/);
});

test("typing text while waiting for a shared contact does not fall through to freeform", async () => {
  const calls = [];
  const handler = createMessageHandler({
    bot: { sendMessage: async (...args) => calls.push(["send", ...args]) },
    database: {},
    generator: null,
    sessions: { get: async () => ({ action: "identity" }) },
    handleFreeform: async () => calls.push(["freeform"]),
    menu: async () => {},
    refreshStudents: async () => {},
    sendGeneration: async () => {},
    CARD_FIELDS: {},
    cardFieldValueText: () => "",
    materialsText: () => "",
  });

  await handler({ text: "tutor@example.com", from: { id: 42 }, chat: { id: 99 } });

  assert.equal(calls.length, 1);
  assert.match(calls[0][2], /Поделиться номером телефона/);
});

test("profile draft field edit updates only the draft and shows it again", async () => {
  const calls = [];
  const handler = createMessageHandler({
    bot: { sendMessage: async (...args) => calls.push(["send", ...args]) },
    database: {
      getTutorByTelegramId: async () => ({ id: 7 }),
      updateProfileDraft: async (draftId, tutorId, changes) => {
        calls.push(["update", draftId, tutorId, changes]);
        return { id: draftId, changes };
      },
    },
    generator: null,
    sessions: {
      get: async () => ({ action: "editProfileDraftField", draftId: 12, field: "topics" }),
      delete: async (id) => calls.push(["delete", id]),
    },
    handleFreeform: async () => {},
    sendProfileDraft: async (chatId, draft) => calls.push(["draft", chatId, draft.id]),
    PROFILE_DRAFT_FIELDS: { topics: { label: "Изученные темы", type: "list" } },
    CARD_FIELDS: {},
    DRAFT_FIELDS: {},
  });

  await handler({ text: "Дроби\nУравнения", from: { id: 42 }, chat: { id: 99 } });

  assert.deepEqual(calls, [
    ["delete", 42],
    ["update", 12, 7, { topics: ["Дроби", "Уравнения"] }],
    ["draft", 99, 12],
  ]);
});
