const dotenv = require("dotenv");
const { PostgresDatabase } = require("./postgres-database");
const { LessonAnalyzer } = require("./analyzer");
const { createApp } = require("./app");
const { createBot } = require("./telegram");
const { MtsLinkService } = require("./mts-link");
const { MoyKlassService } = require("./moy-klass");

dotenv.config();

const port = Number(process.env.PORT || 3001);

async function start() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required.");
  const database = new PostgresDatabase(process.env.DATABASE_URL);
  await database.initialize();

  const isOpenRouter = Boolean(process.env.OPENROUTER_API_KEY);
  const analyzer = new LessonAnalyzer({
    apiKey: process.env.OPENROUTER_API_KEY || process.env.OPENAI_API_KEY,
    model: process.env.OPENROUTER_MODEL || process.env.OPENAI_MODEL,
    provider: isOpenRouter ? "openrouter" : "openai",
  });
  const moyKlass = new MoyKlassService({ apiKey: process.env.MOYKLASS_API_KEY });
  if (moyKlass.isConfigured()) {
    try { console.log("Moy Klass sync", await moyKlass.sync(database)); }
    catch (error) { console.error("Moy Klass sync failed", error); }
  }
  const mtsLink = new MtsLinkService({
    database,
    apiToken: process.env.MTS_LINK_API_TOKEN,
    webhookSecret: process.env.MTS_LINK_WEBHOOK_SECRET,
  });
  const telegramBot = createBot({ token: process.env.TELEGRAM_BOT_TOKEN, database, analyzer });
  const telegramWebhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
  const app = createApp({ database, analyzer, mtsLink, moyKlass, telegramBot, telegramWebhookSecret, moyKlassSyncSecret: process.env.MOYKLASS_SYNC_SECRET });
  app.listen(port, "0.0.0.0", () => {
    console.log(`EDmeAssistant backend running on port ${port}`);
    const baseUrl = process.env.TELEGRAM_WEBHOOK_URL || process.env.RENDER_EXTERNAL_URL;
    if (telegramBot && baseUrl) {
      telegramBot.setWebhook(`${baseUrl.replace(/\/$/, "")}/webhooks/telegram`, { secret_token: telegramWebhookSecret })
        .then(() => console.log("Telegram webhook configured"))
        .catch((error) => console.error("Telegram webhook configuration failed", error));
    }
  });
}

start().catch((error) => {
  console.error("Failed to start EDmeAssistant", error);
  process.exit(1);
});
