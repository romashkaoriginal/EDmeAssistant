const dotenv = require("dotenv");
const { PostgresDatabase } = require("./postgres-database");
const { LessonAnalyzer } = require("./analyzer");
const { ContentGenerator } = require("./generator");
const { createApp } = require("./app");
const { createBot } = require("./telegram");
const { MtsLinkService } = require("./mts-link");
const { MoyKlassService } = require("./moy-klass");

dotenv.config({ override: true, quiet: true });

const port = Number(process.env.PORT || 3001);

// The Telegram library emits handlers synchronously, so a rejection that
// slips past the per-handler guards must not take the whole service down.
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled promise rejection", reason);
});
process.on("uncaughtException", (error) => {
  // State may be corrupt after an uncaught exception: log and let the
  // platform restart the process.
  console.error("Uncaught exception, exiting", error);
  process.exit(1);
});

async function configureTelegramTransport(telegramBot, telegramWebhookSecret) {
  const baseUrl = process.env.TELEGRAM_WEBHOOK_URL || process.env.RENDER_EXTERNAL_URL;
  const forcePolling = process.env.TELEGRAM_POLLING === "true";
  if (!forcePolling && baseUrl) {
    if (!telegramWebhookSecret) {
      console.error("Telegram webhook is disabled: TELEGRAM_WEBHOOK_SECRET is required");
      return;
    }
    await telegramBot.setWebhook(`${baseUrl.replace(/\/$/, "")}/webhooks/telegram`, { secret_token: telegramWebhookSecret });
    console.log("Telegram webhook configured");
    return;
  }
  // Local development fallback: without a public URL the webhook can never be
  // reached, so poll instead of silently staying deaf.
  await telegramBot.deleteWebhook().catch(() => {});
  await telegramBot.startPolling();
  console.log(forcePolling ? "Telegram polling started (TELEGRAM_POLLING=true)" : "Telegram polling started (no webhook URL configured)");
}

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
  const generator = new ContentGenerator({
    apiKey: process.env.OPENROUTER_API_KEY || process.env.OPENAI_API_KEY,
    model: process.env.OPENROUTER_MODEL || process.env.OPENAI_MODEL,
    verifierModel: process.env.OPENROUTER_VERIFIER_MODEL || process.env.OPENAI_VERIFIER_MODEL,
    provider: isOpenRouter ? "openrouter" : "openai",
  });
  const moyKlass = new MoyKlassService({ apiKey: process.env.MOYKLASS_API_KEY });
  const mtsLink = new MtsLinkService({
    database,
    apiToken: process.env.MTS_LINK_API_TOKEN,
    webhookSecret: process.env.MTS_LINK_WEBHOOK_SECRET,
  });
  const telegramBot = createBot({ token: process.env.TELEGRAM_BOT_TOKEN, database, analyzer, moyKlass, generator });
  const telegramWebhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
  const app = createApp({ database, analyzer, mtsLink, moyKlass, telegramBot, telegramWebhookSecret, apiSecret: process.env.INTERNAL_API_SECRET });
  const server = app.listen(port, "0.0.0.0", () => {
    console.log(`EDmeAssistant backend running on port ${port}`);
    if (moyKlass.isConfigured()) {
      // Full company sync is heavy and links by join.managerId (often OP).
      // Teachers refresh their own students on login via lessons API.
      console.log("Moy Klass configured; teacher student sync runs on login/refresh");
    }
    if (telegramBot) {
      configureTelegramTransport(telegramBot, telegramWebhookSecret)
        .catch((error) => console.error("Telegram transport configuration failed", error));
    }
  });

  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`${signal} received, shutting down`);
    // Force-exit if in-flight work (long AI calls) does not drain in time.
    const deadline = setTimeout(() => {
      console.error("Shutdown timed out, forcing exit");
      process.exit(1);
    }, 15_000);
    deadline.unref();
    const stopBot = telegramBot?.isPolling?.() ? telegramBot.stopPolling() : Promise.resolve();
    Promise.resolve(stopBot)
      .catch((error) => console.error("Failed to stop Telegram polling", error))
      .then(() => new Promise((resolve) => server.close(resolve)))
      .then(() => database.close())
      .catch((error) => console.error("Shutdown cleanup failed", error))
      .finally(() => process.exit(0));
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

start().catch((error) => {
  console.error("Failed to start EDmeAssistant", error);
  process.exit(1);
});
