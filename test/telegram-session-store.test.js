const test = require("node:test");
const assert = require("node:assert/strict");
const { TelegramSessionStore } = require("../src/telegram/session-store");
const { TelegramSessionRepository } = require("../src/database/repositories");

test("TelegramSessionStore persists and clears a session through the database", async () => {
  const calls = [];
  const database = {
    setTelegramSession: async (...args) => calls.push(["set", ...args]),
    getTelegramSession: async (...args) => {
      calls.push(["get", ...args]);
      return { action: "identity" };
    },
    deleteTelegramSession: async (...args) => calls.push(["delete", ...args]),
  };
  const sessions = new TelegramSessionStore(database, 120);

  await sessions.set(42, { action: "identity" });
  assert.deepEqual(await sessions.get(42), { action: "identity" });
  await sessions.delete(42);

  assert.deepEqual(calls, [
    ["set", 42, { action: "identity" }, 120],
    ["get", 42],
    ["delete", 42],
  ]);
});

test("TelegramSessionRepository clears expired sessions before saving a new one", async () => {
  const calls = [];
  const repository = new TelegramSessionRepository({
    query: async (sql, values) => {
      calls.push([sql, values]);
      return { rows: [] };
    },
  });

  await repository.set(42, { action: "identity" }, 120);

  assert.match(calls[0][0], /DELETE FROM telegram_sessions WHERE expires_at <= NOW/);
  assert.match(calls[1][0], /INSERT INTO telegram_sessions/);
  assert.deepEqual(calls[1][1], ["42", '{"action":"identity"}', 120]);
});
