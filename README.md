# webhook-notifier

Small Node.js service that receives webhooks and forwards notifications to Discord and email. Zero dependencies (Node.js 18+ standard library only).

## Quick start

```bash
cp .env.example .env   # edit values
npm run demo           # dry-run on port 3000, nothing is sent
npm start              # production
npm test               # tests, outbound mocked
```

## API

### POST /webhook

Headers:
- `Content-Type: application/json`
- `Authorization: Bearer <WEBHOOK_TOKEN>` (required only when `WEBHOOK_TOKEN` is set)

Request body:

```json
{
  "title": "Deploy",
  "message": "v1.2.3 live",
  "level": "success"
}
```

Fields:
- `message` (required): non-empty string
- `title` (optional): string
- `level` (optional): `info`, `success`, `warning`, `error` — default `info`

Example request:

```bash
curl -X POST http://localhost:3000/webhook \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $WEBHOOK_TOKEN" \
  -d '{"title":"Deploy","message":"v1.2.3 live","level":"success"}'
```

Example response:

```json
{
  "ok": true,
  "dryRun": true,
  "results": [
    { "channel": "discord", "ok": true },
    { "channel": "email", "ok": true }
  ]
}
```

Channels that are not configured are skipped. The response always lists per-channel results.

### GET /health

```json
{ "ok": true, "dryRun": true, "channels": ["discord", "email"] }
```

## Configuration

All variables are listed in [`.env.example`](.env.example):

| Variable | Meaning |
|----------|---------|
| `PORT` | HTTP port (default `3000`) |
| `WEBHOOK_TOKEN` | Bearer token; if set, requests must send it |
| `DRY_RUN` | `true` = log instead of sending |
| `DISCORD_WEBHOOK_URL` | Discord webhook URL |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE` | SMTP server (465 = implicit TLS, else STARTTLS) |
| `SMTP_USER`, `SMTP_PASS` | SMTP credentials |
| `EMAIL_FROM`, `EMAIL_TO` | sender and recipient |

## Error handling

| Status | Meaning |
|--------|---------|
| 400 | invalid JSON or missing/empty `message` |
| 401 | bad or missing Bearer token |
| 404 | unknown path |
| 405 | method other than POST on `/webhook` |
| 413 | payload larger than 64 KB |
| 502 | every configured channel failed |
| 503 | no notification channels configured |

Per-channel failures are isolated: one failing channel does not block the others.

## Tests

```bash
npm test
```

Covers health, auth, payload validation, success path, all-channels-failed, and no-channels-configured. No network access; outbound delivery is mocked.

## Notes

- Discord messages are sent as embeds; email uses a minimal SMTP client (`AUTH LOGIN`).
- With `DRY_RUN=true` both channels log the payload instead of sending.
- Email delivery needs real SMTP credentials; without them use `npm run demo`.
