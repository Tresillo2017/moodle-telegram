# moodle-telegram

Telegram bot that notifies users of new Moodle assignments and announcements, for any Moodle site.

## Setup

1. Create a Telegram bot via [@BotFather](https://t.me/BotFather), grab the token.
2. Install deps: `npm install`
3. Create the D1 database:
   ```
   npx wrangler d1 create moodle-telegram
   ```
   Copy the `database_id` into `wrangler.toml`.
4. Apply the schema:
   ```
   npx wrangler d1 execute moodle-telegram --file=schema.sql --remote
   ```
5. Set secrets:
   ```
   npx wrangler secret put TELEGRAM_BOT_TOKEN
   npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
   ```
   `TELEGRAM_WEBHOOK_SECRET` can be any random string you generate yourself (e.g. `openssl rand -hex 32`) — it's used to verify incoming webhook calls actually come from Telegram.
6. Set `PUBLIC_URL` in `wrangler.toml` `[vars]` to your Worker's URL (get it after first deploy, then redeploy), e.g.:
   ```toml
   [vars]
   PUBLIC_URL = "https://moodle-telegram.<your-subdomain>.workers.dev"
   ```
7. Deploy:
   ```
   npm run deploy
   ```
8. Register the Telegram webhook, passing the same secret so Telegram sends it back on every call:
   ```
   curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://<your-worker>.workers.dev/webhook&secret_token=<TELEGRAM_WEBHOOK_SECRET>"
   ```

## Flow

1. User DMs the bot `/start` → bot replies with a one-time link to `/connect?code=...`.
2. User enters their Moodle site URL + username/password on that page.
3. Worker exchanges those credentials for a Moodle web service token via `login/token.php`, stores only the token, and never persists the password.
4. Every 15 minutes (cron trigger) the Worker checks each connected account for new assignments and course announcements and DMs the user.

## Requirements on the Moodle side

The user's Moodle site must have web services + the mobile app service enabled (this is on by default on most modern Moodle installs). If token retrieval fails, that's usually why.
