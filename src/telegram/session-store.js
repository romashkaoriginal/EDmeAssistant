const DEFAULT_TTL_SECONDS = 30 * 60;

class TelegramSessionStore {
  constructor(database, ttlSeconds = DEFAULT_TTL_SECONDS) {
    this.database = database;
    this.ttlSeconds = ttlSeconds;
  }

  async set(telegramUserId, session) {
    await this.database.setTelegramSession(telegramUserId, session, this.ttlSeconds);
  }

  async get(telegramUserId) {
    return this.database.getTelegramSession(telegramUserId);
  }

  async delete(telegramUserId) {
    await this.database.deleteTelegramSession(telegramUserId);
  }
}

module.exports = { DEFAULT_TTL_SECONDS, TelegramSessionStore };
