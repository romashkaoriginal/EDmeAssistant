# EDmeAssistant

Telegram MVP for tutors: student cards, lesson transcripts, AI analysis drafts, and MTS Link transcript ingestion.

## Architecture

- Local and production runtime: Supabase Postgres via `DATABASE_URL`.
- Deployment definition: `render.yaml`.
- Database schema: `db/migrations/001_initial.sql`.

## Local run

```bash
npm install
npm start
```

`GET /health` verifies the service. `DATABASE_URL` is required in every environment.

## Production configuration

Set these secrets in Render, never in Git:

- `DATABASE_URL` - Supabase Session Pooler connection string.
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_WEBHOOK_SECRET`
- `OPENROUTER_API_KEY` and `OPENROUTER_MODEL` for AI analysis.
- `MTS_LINK_API_TOKEN`
- `MTS_LINK_WEBHOOK_SECRET`

Set the MTS Link webhook URL to:

```text
https://<render-service>.onrender.com/webhooks/mts-link
```

The application stores a ready transcript as `new`; it never applies an AI result to a student card without tutor confirmation.
