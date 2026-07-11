const dotenv = require("dotenv");
const { PostgresDatabase } = require("./postgres-database");
const { LessonAnalyzer } = require("./analyzer");
const { createApp } = require("./app");
const { createBot } = require("./telegram");
const { MtsLinkService } = require("./mts-link");

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
  const mtsLink = new MtsLinkService({
    database,
    apiToken: process.env.MTS_LINK_API_TOKEN,
    webhookSecret: process.env.MTS_LINK_WEBHOOK_SECRET,
    webhookSecretHeader: process.env.MTS_LINK_WEBHOOK_SECRET_HEADER,
  });
  const app = createApp({ database, analyzer, mtsLink });
  app.listen(port, "0.0.0.0", () => {
    console.log(`EDmeAssistant backend running on port ${port}`);
    createBot({ token: process.env.TELEGRAM_BOT_TOKEN, accessCode: process.env.TUTOR_ACCESS_CODE, database, analyzer });
  });
}

start().catch((error) => {
  console.error("Failed to start EDmeAssistant", error);
  process.exit(1);
});
