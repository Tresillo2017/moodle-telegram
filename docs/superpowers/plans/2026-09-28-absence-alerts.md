# Alertas de faltas de asistencia (Alexia) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Notify the user via Telegram when their Alexia-tracked absence hours reach 80% or 100% of the 30%-of-lecture-hours limit that causes loss of continuous evaluation, for each DAM 2nd-year subject.

**Architecture:** A new `src/alexia.ts` module handles ASP.NET WebForms login to Alexia and parses the attendance page with `HTMLRewriter`. `src/index.ts` gains a second credentials step in `/connect`, integrates an absence check into the existing 15-minute poll (`checkUser`/`runPoll`), and adds a `/faltas` command. New D1 columns/table persist Alexia credentials (unencrypted — Alexia has no long-lived API token, see spec) and per-subject-per-threshold alert dedup state.

**Tech Stack:** Cloudflare Workers (TypeScript), D1 (SQLite), native `fetch`, native `HTMLRewriter` (Workers runtime), no new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-28-absence-alerts-design.md`

## Global Constraints

- No new npm dependencies — use only `fetch` and `HTMLRewriter`, both native to the Workers runtime (spec: Architecture).
- Absence limit formula, fixed: `limit_horas = horas_semanales * 19.5 * 0.30` (spec: Regla de negocio).
- `SUBJECT_HOURS` map lives in code (`src/alexia.ts`), not in D1 (spec: Arquitectura).
- Alexia password is persisted **unencrypted** in D1 — this is a documented limitation, not a bug to "fix" during implementation (spec: Flujo de credenciales).
- Alert thresholds are exactly two: 80% and 100% of the limit (spec: Flujo de polling).
- An unrecognized subject name from Alexia is silently skipped, never throws (spec: Manejo de errores).
- One user's Alexia failure must never block their own Moodle checks or any other user's poll cycle (spec: Manejo de errores).
- No automated test framework is being added — this repo has none today; verification is manual against the real Alexia account (spec: Fuera de alcance).

## Review Focus

- Alexia session cookie expiring mid-poll (not just at login) — a request to the attendance page that itself gets redirected to `LogOn.aspx` must be treated as "not logged in" and retried once via a fresh login, not parsed as if it were the attendance page.
- A subject appearing in Alexia with trailing/leading whitespace or a diacritic-normalization mismatch against `SUBJECT_HOURS` keys — must not silently produce a `NaN` limit or a false "0% used" alert; needs exact-match-or-skip, not a crash.
- Absence hours reported as a decimal with a comma (`23,4`) instead of a dot, which is standard in Spanish locale HTML — the parser must normalize `,` to `.` before `parseFloat`, or every ratio will be wrong.
- Re-running the same poll cycle twice in quick succession (Cloudflare cron can double-fire) must not send duplicate 80%/100% alerts — the `absence_alerts` dedup insert must happen before or atomically with the send, following the same `INSERT` pattern `seen_items` already uses.
- A user who has connected Moodle but never completed the Alexia step (`alexia_username IS NULL`) must be skipped entirely by the absence-check code path without logging an error every 15 minutes.

---

## File Structure

- **Modify:** `schema.sql` — add `alexia_username`/`alexia_password` columns to `users`, add `absence_alerts` table.
- **Create:** `src/alexia.ts` — Alexia login, attendance parsing, `SUBJECT_HOURS`, limit/ratio calculation.
- **Modify:** `src/types.ts` — no changes needed (no new `Env` bindings; credentials live in D1).
- **Modify:** `src/connect.html` — add a second form step for Alexia username/password.
- **Modify:** `src/index.ts` — extend `handleApiConnect` to accept and verify Alexia credentials, add `checkAbsences`, wire it into `checkUser`, add `/faltas` command and `sendAbsenceStatus`.
- **Modify:** `README.md` — document the Alexia connection step and the unencrypted-password limitation.

---

### Task 1: D1 schema for Alexia credentials and alert dedup

**Files:**
- Modify: `schema.sql`

**Interfaces:**
- Produces: columns `users.alexia_username TEXT`, `users.alexia_password TEXT` (both nullable — a user may have connected Moodle only); table `absence_alerts(chat_id INTEGER, subject TEXT, threshold TEXT, PRIMARY KEY(chat_id, subject, threshold))`.

- [ ] **Step 1: Add the migration statements to `schema.sql`**

Append to the end of `schema.sql`:

```sql
ALTER TABLE users ADD COLUMN alexia_username TEXT;
ALTER TABLE users ADD COLUMN alexia_password TEXT;

CREATE TABLE IF NOT EXISTS absence_alerts (
  chat_id INTEGER NOT NULL,
  subject TEXT NOT NULL,
  threshold TEXT NOT NULL,
  PRIMARY KEY (chat_id, subject, threshold)
);
```

- [ ] **Step 2: Apply the migration to the remote D1 database**

Run: `bunx wrangler d1 execute moodle-telegram --file=schema.sql --remote`

Expected: command completes without error. `ALTER TABLE ADD COLUMN` and `CREATE TABLE IF NOT EXISTS` are both safe to re-run against an already-migrated `users` table for the parts that are new; if you've already run the older `schema.sql` once, D1 will error on re-adding an existing column — in that case run only the three new statements above by hand via `bunx wrangler d1 execute moodle-telegram --command="<statement>" --remote` for each.

- [ ] **Step 3: Verify the new columns and table exist**

Run: `bunx wrangler d1 execute moodle-telegram --command="SELECT alexia_username, alexia_password FROM users LIMIT 1;" --remote`
Expected: no error (empty result is fine if no rows yet).

Run: `bunx wrangler d1 execute moodle-telegram --command="SELECT * FROM absence_alerts LIMIT 1;" --remote`
Expected: no error, empty result set.

- [ ] **Step 4: Commit**

```bash
git add schema.sql
git commit -m "feat: add D1 schema for Alexia credentials and absence alert dedup"
```

---

### Task 2: Alexia login (ASP.NET WebForms auth)

**Files:**
- Create: `src/alexia.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `interface AlexiaAuth { cookies: string }`
  - `async function loginAlexia(username: string, password: string): Promise<AlexiaAuth>` — throws `Error` with a human-readable message on bad credentials or unexpected page shape.
  - `const ALEXIA_INSTITUTION_KEY = "NS2IrX8Iq04%3d"` (exported for reuse if the attendance-page fetch needs to re-login).

- [ ] **Step 1: Write the cookie-jar and VIEWSTATE-extraction helpers**

Create `src/alexia.ts` with:

```ts
const ALEXIA_BASE = "https://web2.alexiaedu.com/ACWeb";
const ALEXIA_INSTITUTION_KEY = "NS2IrX8Iq04%3d";

export interface AlexiaAuth {
  cookies: string;
}

function mergeCookies(existing: string, setCookieHeaders: string[]): string {
  const jar = new Map<string, string>();
  for (const pair of existing.split(";").map((s) => s.trim()).filter(Boolean)) {
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    jar.set(pair.slice(0, eq), pair.slice(eq + 1));
  }
  for (const header of setCookieHeaders) {
    const cookiePart = header.split(";")[0];
    const eq = cookiePart.indexOf("=");
    if (eq === -1) continue;
    jar.set(cookiePart.slice(0, eq).trim(), cookiePart.slice(eq + 1).trim());
  }
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}

function extractHiddenFields(html: string): Record<string, string> {
  const fields: Record<string, string> = {};
  const re = /<input[^>]+type="hidden"[^>]+name="([^"]+)"[^>]*value="([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    fields[m[1]] = m[2].replace(/&quot;/g, '"').replace(/&amp;/g, "&");
  }
  return fields;
}
```

- [ ] **Step 2: Write `loginAlexia`**

Append to `src/alexia.ts`:

```ts
export async function loginAlexia(username: string, password: string): Promise<AlexiaAuth> {
  const loginUrl = `${ALEXIA_BASE}/LogOn.aspx?key=${ALEXIA_INSTITUTION_KEY}`;
  const getRes = await fetch(loginUrl, { redirect: "manual" });
  let cookies = mergeCookies("", getRes.headers.getSetCookie?.() ?? []);
  const html = await getRes.text();

  const hidden = extractHiddenFields(html);
  const formActionMatch = html.match(/<form[^>]+action="([^"]+)"/);
  if (!formActionMatch) throw new Error("Alexia login page did not return the expected form");
  const actionUrl = new URL(formActionMatch[1].replace(/&amp;/g, "&"), loginUrl).toString();

  const body = new URLSearchParams({
    ...hidden,
    txtUsuario: username,
    txtPassword: password,
  });

  const postRes = await fetch(actionUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: cookies,
    },
    body: body.toString(),
    redirect: "manual",
  });
  cookies = mergeCookies(cookies, postRes.headers.getSetCookie?.() ?? []);

  const postHtml = await postRes.text();
  const stillOnLogin = postRes.status === 200 && /name="txtPassword"/.test(postHtml);
  if (stillOnLogin) {
    throw new Error("Alexia login failed — check username/password");
  }

  return { cookies };
}
```

- [ ] **Step 3: Verify manually against the real account**

This cannot be unit-tested (no mock of Alexia's live form exists, and the repo has no test framework — see Global Constraints). Verify by hand:

Run (replace `USER`/`PASS` with real Alexia credentials, keep quotes):
```bash
bun run -e '
import { loginAlexia } from "./src/alexia.ts";
const auth = await loginAlexia("USER", "PASS");
console.log("cookies:", auth.cookies);
'
```
Expected: prints a `cookies:` line containing an authenticated session cookie (not just `LogOnToken`/`AC_SessionId` from the anonymous GET — a login-specific cookie should be added or updated after the POST). If it throws "Alexia login failed", double check the credentials manually in a browser first before debugging the code.

- [ ] **Step 4: Commit**

```bash
git add src/alexia.ts
git commit -m "feat: add Alexia login (ASP.NET WebForms auth)"
```

---

### Task 3: Alexia attendance parsing

**Files:**
- Modify: `src/alexia.ts`

**Interfaces:**
- Consumes: `AlexiaAuth` from Task 2.
- Produces: `interface AbsenceRecord { subject: string; absenceHours: number }` and `async function getAbsences(auth: AlexiaAuth): Promise<AbsenceRecord[]>`.

- [ ] **Step 1: Fetch and save the real attendance page HTML for inspection**

The exact markup of the "ficha del alumno" attendance table is unknown until inspected live (flagged as an open risk in the spec). Run, with real credentials and the real `GuidAlumno` from the URL given by the user:

```bash
bun run -e '
import { loginAlexia } from "./src/alexia.ts";
const auth = await loginAlexia("USER", "PASS");
const res = await fetch(
  "https://web2.alexiaedu.com/ACWeb/paginas/Fichas/FichaAlumno.aspx?GuidAlumno=02a900a1-3637-03c7-ae68-9ce58eb1dd08",
  { headers: { Cookie: auth.cookies } }
);
await Bun.write("/tmp/alexia_ficha.html", await res.text());
console.log("saved, status:", res.status);
'
```

Then inspect `/tmp/alexia_ficha.html` for the section listing absences per subject (look for the subject names from `SUBJECT_HOURS` in Task 4, and for hour values — Spanish-locale decimals use a comma, e.g. `23,4`). Note the surrounding HTML tags (table id/class, row structure, which `<td>` holds the subject name vs. the hour count) — this determines the `HTMLRewriter` selectors in Step 2.

- [ ] **Step 2: Implement `getAbsences` using `HTMLRewriter`, based on the real markup found in Step 1**

Append to `src/alexia.ts`, adjusting the CSS selectors below to match what Step 1 revealed (the pattern shown assumes a table where each row has a subject-name cell and an absence-hours cell — replace the selectors with the real ones before considering this step done):

```ts
export interface AbsenceRecord {
  subject: string;
  absenceHours: number;
}

export async function getAbsences(auth: AlexiaAuth): Promise<AbsenceRecord[]> {
  const url =
    "https://web2.alexiaedu.com/ACWeb/paginas/Fichas/FichaAlumno.aspx?GuidAlumno=02a900a1-3637-03c7-ae68-9ce58eb1dd08";
  const res = await fetch(url, { headers: { Cookie: auth.cookies } });
  const html = await res.text();

  if (/name="txtPassword"/.test(html)) {
    throw new Error("Alexia session expired");
  }

  const records: AbsenceRecord[] = [];
  let currentSubject: string | null = null;

  await new HTMLRewriter()
    .on("table.asistencia tr", {
      element() {
        currentSubject = null;
      },
    })
    .on("table.asistencia tr td.asignatura", {
      text(text) {
        if (text.text.trim()) currentSubject = (currentSubject ?? "") + text.text.trim();
      },
    })
    .on("table.asistencia tr td.faltas", {
      text(text) {
        const raw = text.text.trim();
        if (!raw || currentSubject === null) return;
        const hours = parseFloat(raw.replace(",", "."));
        if (!Number.isNaN(hours)) {
          records.push({ subject: currentSubject, absenceHours: hours });
        }
      },
    })
    .transform(new Response(html))
    .text();

  return records;
}
```

- [ ] **Step 3: Re-run against the real account and verify parsed output**

Run:
```bash
bun run -e '
import { loginAlexia, getAbsences } from "./src/alexia.ts";
const auth = await loginAlexia("USER", "PASS");
console.log(await getAbsences(auth));
'
```
Expected: an array of `{ subject, absenceHours }` objects whose subject names and hour counts match what you see in `/tmp/alexia_ficha.html` and in the browser. If empty, re-check the selectors from Step 1 against the actual saved HTML — the row/cell classes are almost certainly named differently in the real markup than the placeholder `table.asistencia`/`td.asignatura`/`td.faltas` used above.

- [ ] **Step 4: Commit**

```bash
git add src/alexia.ts
git commit -m "feat: parse Alexia attendance page into per-subject absence hours"
```

---

### Task 4: Subject hour limits and ratio calculation

**Files:**
- Modify: `src/alexia.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `const SUBJECT_HOURS: Record<string, number>`
  - `function absenceLimitHours(weeklyHours: number): number`
  - `interface SubjectAbsenceStatus { subject: string; absenceHours: number; limitHours: number; ratio: number }`
  - `function computeAbsenceStatus(records: AbsenceRecord[]): SubjectAbsenceStatus[]` — records whose `subject` has no entry in `SUBJECT_HOURS` are dropped from the result.

- [ ] **Step 1: Write the failing manual check (no test framework — verify via a scratch script)**

Create a scratch file (not committed) `/tmp/absence_calc_check.ts`:

```ts
import { computeAbsenceStatus, SUBJECT_HOURS } from "/home/tomas/Documents/Github/moodle-telegram/src/alexia.ts";

const result = computeAbsenceStatus([
  { subject: "Acceso a Datos", absenceHours: 29.25 },
  { subject: "Nombre Que No Existe", absenceHours: 5 },
]);

console.assert(result.length === 1, "unknown subject must be dropped");
console.assert(result[0].subject === "Acceso a Datos");
console.assert(Math.abs(result[0].limitHours - 29.25) < 0.001, `expected 29.25, got ${result[0].limitHours}`);
console.assert(Math.abs(result[0].ratio - 1.0) < 0.001, `expected ratio 1.0, got ${result[0].ratio}`);
console.log("all checks passed");
```

Run: `bun run /tmp/absence_calc_check.ts`
Expected: FAIL — `computeAbsenceStatus`/`SUBJECT_HOURS` are not exported yet.

- [ ] **Step 2: Implement `SUBJECT_HOURS`, `absenceLimitHours`, `computeAbsenceStatus`**

Append to `src/alexia.ts`:

```ts
export const SUBJECT_HOURS: Record<string, number> = {
  "Acceso a Datos": 5,
  "Desarrollo de Interfaces": 6,
  "Programación Multimedia y Dispositivos Móviles": 4,
  "Programación de Servicios y Procesos": 4,
  "Principios de Ciberseguridad": 2,
  "Sistemas de Gestión Empresarial": 5,
};

const WEEKS_PER_TERM = 19.5;
const CONTINUOUS_EVAL_THRESHOLD = 0.3;

export function absenceLimitHours(weeklyHours: number): number {
  return weeklyHours * WEEKS_PER_TERM * CONTINUOUS_EVAL_THRESHOLD;
}

export interface SubjectAbsenceStatus {
  subject: string;
  absenceHours: number;
  limitHours: number;
  ratio: number;
}

export function computeAbsenceStatus(records: AbsenceRecord[]): SubjectAbsenceStatus[] {
  const out: SubjectAbsenceStatus[] = [];
  for (const r of records) {
    const weeklyHours = SUBJECT_HOURS[r.subject];
    if (weeklyHours === undefined) continue;
    const limitHours = absenceLimitHours(weeklyHours);
    out.push({ subject: r.subject, absenceHours: r.absenceHours, limitHours, ratio: r.absenceHours / limitHours });
  }
  return out;
}
```

- [ ] **Step 3: Re-run the manual check to verify it passes**

Run: `bun run /tmp/absence_calc_check.ts`
Expected: prints `all checks passed` with no assertion errors.

- [ ] **Step 4: Delete the scratch file and commit**

```bash
rm /tmp/absence_calc_check.ts
git add src/alexia.ts
git commit -m "feat: compute per-subject absence limits and ratios"
```

---

### Task 5: Alexia credentials step in `/connect`

**Files:**
- Modify: `src/connect.html`
- Modify: `src/index.ts` (`handleApiConnect`, around `src/index.ts:223-267`)

**Interfaces:**
- Consumes: `loginAlexia` from Task 2 (`src/alexia.ts`).
- Produces: `users.alexia_username`/`users.alexia_password` populated after a successful `/connect` flow that includes Alexia fields.

- [ ] **Step 1: Read the current `connect.html` to see its existing form structure**

Run: view `src/connect.html` in full before editing (it's the page the user already has working for Moodle — match its existing style/JS patterns rather than introducing a new pattern).

- [ ] **Step 2: Add optional Alexia username/password fields to the form**

Edit `src/connect.html`: add two more `<input>` fields (`name="alexiaUsername"`, `name="alexiaPassword"`, type `text`/`password`) inside the existing form, both optional, with a short label like "Alexia (opcional, para alertas de faltas)". Include them in the same JS `fetch` call body that already posts `moodleUrl`/`username`/`password` to `/api/connect`, as `alexiaUsername`/`alexiaPassword` (omit the keys entirely if the fields are left blank, so `handleApiConnect` can tell "not provided" apart from "provided empty").

- [ ] **Step 3: Extend `handleApiConnect` to log in to Alexia and store credentials on success**

In `src/index.ts`, add the import at the top (near the existing `moodle.ts` import block):

```ts
import { loginAlexia } from "./alexia";
```

Modify `handleApiConnect` (`src/index.ts:223-267`): after the existing Moodle token exchange succeeds and before the final `INSERT`, add:

```ts
  let alexiaUsername: string | null = null;
  let alexiaPassword: string | null = null;
  if (body.alexiaUsername && body.alexiaPassword) {
    try {
      await loginAlexia(body.alexiaUsername, body.alexiaPassword);
      alexiaUsername = body.alexiaUsername;
      alexiaPassword = body.alexiaPassword;
    } catch (e: any) {
      return Response.json({ error: `Alexia: ${e.message ?? "login failed"}` }, { status: 400 });
    }
  }
```

Update the `INSERT ... ON CONFLICT` statement that follows to include the two new columns and bind `alexiaUsername`/`alexiaPassword` alongside the existing bound values (both `null` when Alexia wasn't provided):

```ts
  await env.DB.prepare(
    "INSERT INTO users (chat_id, moodle_url, token, moodle_user_id, full_name, created_at, alexia_username, alexia_password) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?) " +
      "ON CONFLICT(chat_id) DO UPDATE SET moodle_url=excluded.moodle_url, token=excluded.token, moodle_user_id=excluded.moodle_user_id, full_name=excluded.full_name, " +
      "alexia_username=COALESCE(excluded.alexia_username, users.alexia_username), alexia_password=COALESCE(excluded.alexia_password, users.alexia_password)"
  )
    .bind(row.chat_id, moodleUrl, token, site.userid, site.fullname, Math.floor(Date.now() / 1000), alexiaUsername, alexiaPassword)
    .run();
```

(The `COALESCE` in the `ON CONFLICT` clause means reconnecting Moodle alone, with no Alexia fields, does not wipe out previously-saved Alexia credentials.)

- [ ] **Step 4: Verify manually with `wrangler dev`**

Run: `bun run dev`, open the printed local URL's `/connect?code=<a code you inserted manually into link_codes via wrangler d1 execute --local>`, submit the form with real Moodle + Alexia credentials.
Expected: success message; then run `bunx wrangler d1 execute moodle-telegram --command="SELECT alexia_username FROM users;" --local` and confirm the username is stored.

- [ ] **Step 5: Commit**

```bash
git add src/connect.html src/index.ts
git commit -m "feat: capture and verify Alexia credentials during /connect"
```

---

### Task 6: Absence checking wired into the poll cycle

**Files:**
- Modify: `src/index.ts` (new `checkAbsences` function; modify `checkUser` around `src/index.ts:298-329`; modify the `UserRow` interface and `getUser`/`runPoll` queries)

**Interfaces:**
- Consumes: `loginAlexia`, `getAbsences`, `computeAbsenceStatus`, `SubjectAbsenceStatus` from `src/alexia.ts`.
- Produces: `async function checkAbsences(env: Env, user: { chat_id: number; alexia_username: string; alexia_password: string }): Promise<void>`, called from `checkUser`.

- [ ] **Step 1: Extend `UserRow`, `getUser`, and the `runPoll` query to include Alexia columns**

In `src/index.ts`, modify the `UserRow` interface (`src/index.ts:24-30`) to add:

```ts
  alexia_username: string | null;
  alexia_password: string | null;
```

Modify `getUser` (`src/index.ts:32-36`) to select the two new columns:

```ts
async function getUser(env: Env, chatId: number): Promise<UserRow | null> {
  return env.DB.prepare(
    "SELECT chat_id, moodle_url, token, moodle_user_id, full_name, alexia_username, alexia_password FROM users WHERE chat_id = ?"
  )
    .bind(chatId)
    .first<UserRow>();
}
```

Modify the `runPoll` query (`src/index.ts:332-337`) to also select and type the two new columns, matching the same pattern used for the existing four.

- [ ] **Step 2: Write `checkAbsences`**

Add the import at the top of `src/index.ts` alongside the Task 5 import:

```ts
import { loginAlexia, getAbsences, computeAbsenceStatus, type SubjectAbsenceStatus } from "./alexia";
```

Add this function near `checkUser` in `src/index.ts`:

```ts
function formatAbsenceAlert(status: SubjectAbsenceStatus, threshold: "80pct" | "100pct"): string {
  const pct = Math.round(status.ratio * 100);
  const icon = threshold === "100pct" ? "🚨" : "⚠️";
  const verdict =
    threshold === "100pct"
      ? "Has superado el límite de faltas — pierdes la evaluación continua."
      : "Te acercas al límite de faltas.";
  return (
    `${icon} <b>${escapeHtml(status.subject)}</b>\n${verdict}\n` +
    `${status.absenceHours.toFixed(1)}h de ${status.limitHours.toFixed(1)}h (${pct}%)`
  );
}

async function checkAbsences(
  env: Env,
  user: { chat_id: number; alexia_username: string; alexia_password: string }
): Promise<void> {
  const auth = await loginAlexia(user.alexia_username, user.alexia_password);
  const records = await getAbsences(auth);
  const statuses = computeAbsenceStatus(records);

  for (const status of statuses) {
    const threshold: "80pct" | "100pct" | null =
      status.ratio >= 1 ? "100pct" : status.ratio >= 0.8 ? "80pct" : null;
    if (threshold === null) continue;

    const seen = await env.DB.prepare(
      "SELECT 1 FROM absence_alerts WHERE chat_id = ? AND subject = ? AND threshold = ?"
    )
      .bind(user.chat_id, status.subject, threshold)
      .first();
    if (seen) continue;

    await env.DB.prepare("INSERT INTO absence_alerts (chat_id, subject, threshold) VALUES (?, ?, ?)")
      .bind(user.chat_id, status.subject, threshold)
      .run();

    await sendMessage(env.TELEGRAM_BOT_TOKEN, user.chat_id, formatAbsenceAlert(status, threshold));
  }
}
```

- [ ] **Step 3: Wire `checkAbsences` into `checkUser` behind its own try/catch**

Modify `checkUser` (`src/index.ts:298-329`) to add, at the end of the function body, before its closing brace:

```ts
  if (user.alexia_username && user.alexia_password) {
    try {
      await checkAbsences(env, {
        chat_id: user.chat_id,
        alexia_username: user.alexia_username,
        alexia_password: user.alexia_password,
      });
    } catch (e) {
      console.error("absence check failed for", user.chat_id, e);
    }
  }
```

(This must be its own try/catch, separate from the Moodle calls above it in the same function — an Alexia failure must not prevent the Moodle assignment/announcement notifications that already ran earlier in `checkUser` from having been sent, and must not throw out of `checkUser` into `runPoll`'s own try/catch, which already isolates one user's failure from the next user's poll — this task's isolation is one level more specific, isolating Alexia's failure from that same user's Moodle success.)

Also update `checkUser`'s parameter type to accept the two nullable fields (it should now take the shape returned by the widened `runPoll` query from Step 1, i.e. add `alexia_username: string | null; alexia_password: string | null;` to its parameter type).

- [ ] **Step 4: Verify manually with `wrangler dev` and a real connected account**

Run: `bun run dev`, then trigger the scheduled handler locally — Wrangler doesn't run cron automatically in dev, so instead temporarily add a debug route or call `runPoll` from a manual `curl` to `/webhook` isn't wired for this; simplest verification: run the Task 3/4 scratch-script style check but call `checkAbsences(env, ...)` isn't directly reachable outside the Worker. Instead, verify by:
1. Manually setting `absenceHours` for a test subject in Alexia is not possible — so verify indirectly: temporarily lower one `SUBJECT_HOURS` entry in a local scratch copy so your real (small) absence count already exceeds 80%/100% of it, confirm you receive the expected Telegram message, then revert the temporary change.
2. Confirm no message is sent on a second immediate re-run (dedup via `absence_alerts` works) by checking the table: `bunx wrangler d1 execute moodle-telegram --command="SELECT * FROM absence_alerts;" --local`.

Expected: exactly one Telegram message per newly-crossed threshold, and a row per threshold in `absence_alerts` after.

- [ ] **Step 5: Commit**

```bash
git add src/index.ts
git commit -m "feat: check Alexia absences each poll cycle and alert at 80%/100% of the limit"
```

---

### Task 7: `/faltas` command

**Files:**
- Modify: `src/index.ts` (`handleWebhook` around `src/index.ts:175-221`, `MENU_KEYBOARD` at `src/index.ts:19-22`, `HELP_TEXT` at `src/index.ts:165-173`)

**Interfaces:**
- Consumes: `loginAlexia`, `getAbsences`, `computeAbsenceStatus` from `src/alexia.ts`; `chunkBlocks`/`sendChunks`/`escapeHtml` already defined in `src/index.ts`.
- Produces: on-demand `/faltas` reply listing current absence status per subject.

- [ ] **Step 1: Write `sendAbsenceStatus`**

Add near `sendAssignmentsList`/`sendAnnouncementsList` in `src/index.ts`:

```ts
async function sendAbsenceStatus(env: Env, user: UserRow) {
  if (!user.alexia_username || !user.alexia_password) {
    await sendMessage(
      env.TELEGRAM_BOT_TOKEN,
      user.chat_id,
      "No has conectado tu cuenta de Alexia. Envía /start y añade tus credenciales de Alexia para ver tus faltas."
    );
    return;
  }

  const loadingId = await sendMessage(env.TELEGRAM_BOT_TOKEN, user.chat_id, "⏳ Consultando tus faltas...");
  let statuses;
  try {
    const auth = await loginAlexia(user.alexia_username, user.alexia_password);
    const records = await getAbsences(auth);
    statuses = computeAbsenceStatus(records);
  } catch (e: any) {
    const text = `No se pudo consultar Alexia: ${escapeHtml(e.message ?? "error desconocido")}`;
    if (loadingId !== null) await editMessageText(env.TELEGRAM_BOT_TOKEN, user.chat_id, loadingId, text);
    else await sendMessage(env.TELEGRAM_BOT_TOKEN, user.chat_id, text);
    return;
  }

  if (statuses.length === 0) {
    const text = "No hay datos de asistencia disponibles todavía.";
    if (loadingId !== null) await editMessageText(env.TELEGRAM_BOT_TOKEN, user.chat_id, loadingId, text);
    else await sendMessage(env.TELEGRAM_BOT_TOKEN, user.chat_id, text);
    return;
  }

  const blocks = statuses.map((s) => {
    const pct = Math.round(s.ratio * 100);
    const icon = s.ratio >= 1 ? "🚨" : s.ratio >= 0.8 ? "⚠️" : "✅";
    return `${icon} <b>${escapeHtml(s.subject)}</b>\n${s.absenceHours.toFixed(1)}h de ${s.limitHours.toFixed(1)}h (${pct}%)`;
  });
  await sendChunks(env, user.chat_id, loadingId, chunkBlocks(blocks));
}
```

- [ ] **Step 2: Wire the `/faltas` command and menu button into `handleWebhook`**

Modify `MENU_KEYBOARD` (`src/index.ts:19-22`) to add a third row:

```ts
const MENU_KEYBOARD: ReplyKeyboard = {
  keyboard: [["📚 Assignments", "📢 Announcements"], ["ℹ️ Status", "📅 Faltas"]],
  resize_keyboard: true,
};
```

Modify `HELP_TEXT` (`src/index.ts:165-173`) to add a line documenting `/faltas`.

Modify the command dispatch in `handleWebhook` (`src/index.ts:206-219`) to add a branch:

```ts
  } else if (text === "/faltas" || text === "📅 Faltas") {
    await sendAbsenceStatus(env, user);
```

(insert alongside the existing `else if` chain for `/assignments`/`/announcements`/`/status`).

- [ ] **Step 3: Verify manually with `wrangler dev` and a real connected account**

Run: `bun run dev`, send `/faltas` to the bot (via the real Telegram webhook pointed at a tunnel, or by manually POSTing a synthetic Telegram update matching the webhook's expected shape to the local `/webhook` endpoint with the correct `X-Telegram-Bot-Api-Secret-Token` header).
Expected: a message listing each known subject with its current absence hours/limit/percentage, matching what Task 6's manual verification already confirmed.

- [ ] **Step 4: Commit**

```bash
git add src/index.ts
git commit -m "feat: add /faltas command to check absence status on demand"
```

---

### Task 8: Documentation

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: nothing (documentation only).
- Produces: nothing consumed by other tasks.

- [ ] **Step 1: Document the Alexia connection step and its limitations**

Edit `README.md`: in the "Flow" section, add a step describing the optional Alexia credentials field in `/connect` and the resulting absence alerts. Add a new subsection (e.g. "Alexia absence alerts") stating explicitly: Alexia's password is stored **unencrypted** in D1 because Alexia has no long-lived API token (unlike Moodle's `login/token.php`), so the worker must re-authenticate with the full username/password on every 15-minute poll; anyone with access to the D1 database can read it. Also document that `SUBJECT_HOURS` in `src/alexia.ts` is hardcoded per academic year and must be updated by hand if the course's weekly hours change.

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: document Alexia absence alerts setup and password storage limitation"
```
