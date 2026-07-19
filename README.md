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
- `OPENROUTER_API_KEY` and `OPENROUTER_MODEL` for AI analysis and generation.
- `OPENROUTER_VERIFIER_MODEL` for the independent second-pass test audit (falls back to `OPENROUTER_MODEL`).
- `MOYKLASS_API_KEY` for read-only synchronization of tutors, students, and group membership from "Мой Класс".
- `MTS_LINK_API_TOKEN`
- `MTS_LINK_WEBHOOK_SECRET`
- `INTERNAL_API_SECRET` protects every `/api/*` route. Send it in the `x-api-secret` header. If it is absent, the internal API returns `503` and remains closed.

Each AI attempt is stored in `ai_analysis_logs`: provider, model, token usage, estimated cost, response duration, raw response, and error message. The log is linked to its transcript and is created for both successful and failed analyses.

Set the MTS Link webhook URL to:

```text
https://<render-service>.onrender.com/webhooks/mts-link
```

Create it for the `transcription.ready` event and use the same `signatureSecret` as `MTS_LINK_WEBHOOK_SECRET`. Incoming requests are verified with the official `X-Webhook-Signature` HMAC-SHA256 signature.

The application stores a ready transcript as `new`; it never applies an AI result to a student card without tutor confirmation.

Telegram updates are accepted only when `TELEGRAM_WEBHOOK_SECRET` matches. Do not remove this variable: without it the Telegram webhook deliberately returns `503`.

## Admin panel

Admins are tutors with the `is_admin` flag. In the bot they get a "🛠 Админ-панель" entry in the main menu (and the `/admin` command) covering spec section 20: browse tutors and students, view any student card, list stale cards, integration errors and generation logs, edit material metadata, grant/revoke admin by phone, and enable/disable tutor access.

The bootstrap admin is seeded by phone in `db/migrations/012_admin_role.sql` (`375445839141`). The flag is (re)applied whenever that number is synced from "Мой Класс" or logs in, so it works even if the tutor row does not exist yet. One phone maps to one account: a phone binds to a single Telegram profile via Telegram's shared-contact login. Existing admins can grant the flag to any tutor by entering their phone number.
