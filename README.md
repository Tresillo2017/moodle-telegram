# moodle-telegram

Telegram bot that notifies users of new Moodle assignments and announcements, for any Moodle site.

## Setup

1. Create a Telegram bot via [@BotFather](https://t.me/BotFather), grab the token.
2. Install deps: `bun install`
3. Create the D1 database:
   ```
   bunx wrangler d1 create moodle-telegram
   ```
   Copy the `database_id` into `wrangler.toml`.
4. Apply the schema:
   ```
   bunx wrangler d1 execute moodle-telegram --file=schema.sql --remote
   ```
5. Set secrets:
   ```
   bunx wrangler secret put TELEGRAM_BOT_TOKEN
   bunx wrangler secret put TELEGRAM_WEBHOOK_SECRET
   ```
   `TELEGRAM_WEBHOOK_SECRET` can be any random string you generate yourself (e.g. `openssl rand -hex 32`) — it's used to verify incoming webhook calls actually come from Telegram.
6. Set `PUBLIC_URL` in `wrangler.toml` `[vars]` to your Worker's URL (get it after first deploy, then redeploy), e.g.:
   ```toml
   [vars]
   PUBLIC_URL = "https://moodle-telegram.<your-subdomain>.workers.dev"
   ```
7. Deploy:
   ```
   bun run deploy
   ```
8. Register the Telegram webhook, passing the same secret so Telegram sends it back on every call:
   ```
   curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://<your-worker>.workers.dev/webhook&secret_token=<TELEGRAM_WEBHOOK_SECRET>"
   ```

## Flow

1. User DMs the bot `/start` → bot replies with a one-time link to `/connect?code=...`.
2. User enters their Moodle site URL + username/password on that page.
3. Worker exchanges those credentials for a Moodle web service token via `login/token.php`, stores only the token, and never persists the password.
4. (Optional) User can also enter their Alexia (school attendance system) username/password on the same page for absence alerts.
5. Every 15 minutes (cron trigger) the Worker checks each connected account for new assignments, course announcements, and (if Alexia is connected) updated absence status, then DMs the user.

## Requirements on the Moodle side

The user's Moodle site must have web services + the mobile app service enabled (this is on by default on most modern Moodle installs). If token retrieval fails, that's usually why.

## Alexia absence alerts

Users can optionally connect their Alexia (school attendance tracking system) account to receive alerts when their absences reach critical thresholds. This is done on the same `/connect` page where they enter their Moodle credentials — the Alexia username and password fields are optional.

**How it works:**
- When Alexia credentials are provided, the Worker verifies them immediately and stores them for future polls.
- Every 15 minutes, the Worker logs back in to Alexia and fetches per-subject absence totals.
- If a subject's absence hours reach 80% of the semester limit, you get a ⚠️ warning.
- If absences reach 100% or more, you get a 🚨 critical alert (you've exceeded the limit for continuous evaluation in that subject).
- The `/faltas` command lets you check your current absence status per subject on demand.

**Important limitations:**

⚠️ **Password storage:** Alexia does not provide long-lived API tokens like Moodle does. Because the Worker must re-authenticate on every 15-minute poll cycle, your Alexia **password is stored unencrypted in the D1 database**. Anyone with access to your D1 database can read it. If this is a security concern, do not connect your Alexia account.

⚠️ **Manual subject configuration:** The mapping between subject names and weekly class hours (used to calculate semester absence limits) is hardcoded in `src/alexia.ts` under `SUBJECT_HOURS`, keyed to a specific academic year. If your school's course structure changes (new subjects, different weekly hours), the code must be manually updated and redeployed. Subject matching against Alexia's data is case-insensitive and ignores trailing periods, so exact capitalization is not required.

⚠️ **Single-tenant only:** The Alexia absence-alerts feature only works correctly for the one student whose GUID is hardcoded as `ALEXIA_GUID_ALUMNO` in `src/alexia.ts`, tied to one specific institution (`ALEXIA_INSTITUTION_KEY`). `getAbsences` always fetches attendance for that hardcoded student regardless of which Telegram user's poll cycle is running or whose Alexia credentials were used to log in. There is no allowlist, so any Telegram user could go through `/connect` with their own Alexia credentials and still only see the hardcoded student's absence data. This feature is **not safe to expose to multiple Telegram users with different Alexia accounts** without further work to derive the GUID from the authenticated session.
