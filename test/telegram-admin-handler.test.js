const test = require("node:test");
const assert = require("node:assert/strict");
const { createAdminHandler } = require("../src/telegram/admin-handler");
const { menuKeyboard } = require("../src/telegram");

test("main menu shows the admin button only to admins", () => {
  const adminButtons = menuKeyboard({ is_admin: true }).inline_keyboard.flat().map((b) => b.callback_data);
  assert.ok(adminButtons.includes("adm:menu"));

  const tutorButtons = menuKeyboard({ is_admin: false }).inline_keyboard.flat().map((b) => b.callback_data);
  assert.ok(!tutorButtons.includes("adm:menu"));

  const anonButtons = menuKeyboard().inline_keyboard.flat().map((b) => b.callback_data);
  assert.ok(!anonButtons.includes("adm:menu"));
});

function makeBot(calls) {
  return { sendMessage: async (...args) => { calls.push(["send", ...args]); } };
}

test("admin callback is refused for a non-admin tutor", async () => {
  const calls = [];
  const handler = createAdminHandler({ bot: makeBot(calls), database: {}, sessions: {} });
  const consumed = await handler.handleCallback(
    { data: "adm:menu", from: { id: 1 }, message: { chat: { id: 9 } } },
    { id: 1, is_admin: false },
    9,
  );
  assert.equal(consumed, true);
  assert.equal(calls[0][2], "Доступ к админ-панели закрыт.");
});

test("non-admin callbacks are ignored (returns false so main handler continues)", async () => {
  const handler = createAdminHandler({ bot: makeBot([]), database: {}, sessions: {} });
  const consumed = await handler.handleCallback(
    { data: "students", from: { id: 1 }, message: { chat: { id: 9 } } },
    { id: 1, is_admin: true },
    9,
  );
  assert.equal(consumed, false);
});

test("adm:menu renders the admin menu for an admin", async () => {
  const calls = [];
  const handler = createAdminHandler({ bot: makeBot(calls), database: {}, sessions: {} });
  await handler.handleCallback(
    { data: "adm:menu", from: { id: 1 }, message: { chat: { id: 9 } } },
    { id: 1, is_admin: true },
    9,
  );
  assert.match(calls[0][2], /Админ-панель/);
  const buttons = calls[0][3].reply_markup.inline_keyboard.flat().map((b) => b.callback_data);
  assert.ok(buttons.includes("adm:tutors"));
  assert.ok(buttons.includes("adm:grant"));
  assert.ok(buttons.includes("adm:materials"));
});

test("submitting a phone shows the tutor's card with a confirmation button instead of granting blind", async () => {
  const calls = [];
  const lookupCalls = [];
  const sessions = { set: async () => {}, delete: async () => {} };
  const database = {
    getTutorForAdminByPhone: async (phone) => { lookupCalls.push(phone); return { id: 5, fullName: "Ирина", phone, email: null, myKlassId: null, studentCount: 2, telegramId: null, isActive: true, isAdmin: false }; },
    getTutorForAdmin: async () => ({ id: 5, fullName: "Ирина", phone: "375445839141", email: null, myKlassId: null, studentCount: 2, telegramId: null, isActive: true, isAdmin: false }),
    setTutorAdminByPhone: async () => { throw new Error("must not grant without explicit button confirmation"); },
  };
  const handler = createAdminHandler({ bot: makeBot(calls), database, sessions });
  const consumed = await handler.handleTextSession(
    { text: "+375 (44) 583-91-41", from: { id: 1 }, chat: { id: 9 } },
    { action: "adminGrantPhone" },
    { id: 1, is_admin: true },
  );
  assert.equal(consumed, true);
  assert.deepEqual(lookupCalls, ["375445839141"]);
  assert.match(calls[0][2], /Ирина/);
  const buttons = calls[0][3].reply_markup.inline_keyboard.flat();
  assert.ok(buttons.some((b) => b.text === "Сделать админом" && b.callback_data === "adm:setAdmin:5:1"));
});

test("submitting the phone of an existing admin says so instead of a silent no-op", async () => {
  const calls = [];
  const database = {
    getTutorForAdminByPhone: async () => ({ id: 5, fullName: "Ирина", phone: "375445839141", email: null, myKlassId: null, studentCount: 2, telegramId: null, isActive: true, isAdmin: true }),
    getTutorForAdmin: async () => ({ id: 5, fullName: "Ирина", phone: "375445839141", email: null, myKlassId: null, studentCount: 2, telegramId: null, isActive: true, isAdmin: true }),
  };
  const handler = createAdminHandler({ bot: makeBot(calls), database, sessions: { delete: async () => {} } });
  await handler.handleTextSession(
    { text: "375445839141", from: { id: 1 }, chat: { id: 9 } },
    { action: "adminGrantPhone" },
    { id: 1, is_admin: true },
  );
  assert.match(calls[0][2], /уже администратор/);
  assert.match(calls[1][2], /Ирина/);
  const buttons = calls[1][3].reply_markup.inline_keyboard.flat();
  assert.ok(buttons.some((b) => b.text === "Снять админа"));
});

test("granting admin to an unknown phone reports not found", async () => {
  const calls = [];
  const database = { getTutorForAdminByPhone: async () => null };
  const handler = createAdminHandler({ bot: makeBot(calls), database, sessions: { delete: async () => {} } });
  await handler.handleTextSession(
    { text: "000", from: { id: 1 }, chat: { id: 9 } },
    { action: "adminGrantPhone" },
    { id: 1, is_admin: true },
  );
  assert.match(calls[0][2], /не найден/);
});

test("confirming the same admin flag twice does not re-apply it silently", async () => {
  const calls = [];
  const setCalls = [];
  const database = {
    getTutorForAdmin: async () => ({ id: 5, fullName: "Ирина", phone: "375445839141", isAdmin: true }),
    setTutorAdminByPhone: async (...a) => { setCalls.push(a); },
  };
  const handler = createAdminHandler({ bot: makeBot(calls), database, sessions: {} });
  await handler.handleCallback(
    { data: "adm:setAdmin:5:1", from: { id: 1 }, message: { chat: { id: 9 } } },
    { id: 1, is_admin: true },
    9,
  );
  assert.equal(setCalls.length, 0);
  assert.match(calls[0][2], /уже администратор/);
});

test("admin cannot revoke their own admin flag", async () => {
  const calls = [];
  const setCalls = [];
  const database = {
    getTutorForAdmin: async () => ({ id: 5, fullName: "Я", phone: "375440000000", isAdmin: true }),
    setTutorAdminByPhone: async (...a) => { setCalls.push(a); },
  };
  const handler = createAdminHandler({ bot: makeBot(calls), database, sessions: {} });
  await handler.handleCallback(
    { data: "adm:setAdmin:5:0", from: { id: 1 }, message: { chat: { id: 9 } } },
    { id: 5, is_admin: true },
    9,
  );
  assert.equal(setCalls.length, 0);
  assert.match(calls[0][2], /самого себя/);
});

test("editing a material metadata field persists and re-renders the card", async () => {
  const calls = [];
  const updates = [];
  const database = {
    updateMaterialMetadata: async (id, patch) => { updates.push([id, patch]); return { id, name: "Новое имя", subject: "Математика", grade: 8, topic: null, materialType: "тест", url: "u" }; },
    getMaterial: async (id) => ({ id, name: "Новое имя", subject: "Математика", grade: 8, topic: null, materialType: "тест", url: "u" }),
  };
  const handler = createAdminHandler({ bot: makeBot(calls), database, sessions: { delete: async () => {} } });
  await handler.handleTextSession(
    { text: "Новое имя", from: { id: 1 }, chat: { id: 9 } },
    { action: "adminEditMaterialField", materialId: 3, field: "name" },
    { id: 1, is_admin: true },
  );
  assert.deepEqual(updates, [[3, { name: "Новое имя" }]]);
  assert.match(calls[0][2], /обновлено/);
});

test("editing the numeric grade field rejects non-integers", async () => {
  const calls = [];
  const database = { updateMaterialMetadata: async () => { throw new Error("should not update"); } };
  const handler = createAdminHandler({ bot: makeBot(calls), database, sessions: { delete: async () => {} } });
  await handler.handleTextSession(
    { text: "восемь", from: { id: 1 }, chat: { id: 9 } },
    { action: "adminEditMaterialField", materialId: 3, field: "grade" },
    { id: 1, is_admin: true },
  );
  assert.match(calls[0][2], /целым числом/);
});

test("clearing a field with '-' stores an empty value", async () => {
  const updates = [];
  const database = {
    updateMaterialMetadata: async (id, patch) => { updates.push(patch); return { id, name: null, subject: "x", grade: null, topic: null, materialType: "x", url: "x" }; },
    getMaterial: async (id) => ({ id, name: null, subject: "x", grade: null, topic: null, materialType: "x", url: "x" }),
  };
  const handler = createAdminHandler({ bot: makeBot([]), database, sessions: { delete: async () => {} } });
  await handler.handleTextSession(
    { text: "-", from: { id: 1 }, chat: { id: 9 } },
    { action: "adminEditMaterialField", materialId: 3, field: "topic" },
    { id: 1, is_admin: true },
  );
  assert.deepEqual(updates, [{ topic: "" }]);
});
