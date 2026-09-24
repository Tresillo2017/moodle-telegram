import type { Env } from "./types";
import { sendMessage, editMessageText, type ReplyKeyboard } from "./telegram";
import {
  getToken,
  getSiteInfo,
  getAssignments,
  getAnnouncements,
  getUserCourseIds,
  type MoodleAuth,
  type Assignment,
  type Announcement,
} from "./moodle";
// @ts-ignore - bundled as raw text via wrangler's Text module rule
import connectHtml from "./connect.html";

const CODE_TTL_SECONDS = 10 * 60;

const MENU_KEYBOARD: ReplyKeyboard = {
  keyboard: [["📚 Assignments", "📢 Announcements"], ["ℹ️ Status"]],
  resize_keyboard: true,
};

interface UserRow {
  chat_id: number;
  moodle_url: string;
  token: string;
  moodle_user_id: number;
  full_name: string;
}

async function getUser(env: Env, chatId: number): Promise<UserRow | null> {
  return env.DB.prepare("SELECT chat_id, moodle_url, token, moodle_user_id, full_name FROM users WHERE chat_id = ?")
    .bind(chatId)
    .first<UserRow>();
}

function randomCode(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 16);
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function isValidMoodleUrl(input: string): boolean {
  try {
    const u = new URL(input);
    return u.protocol === "https:";
  } catch {
    return false;
  }
}

async function sendConnectLink(env: Env, chatId: number) {
  const code = randomCode();
  const expiresAt = Math.floor(Date.now() / 1000) + CODE_TTL_SECONDS;
  await env.DB.prepare("INSERT INTO link_codes (code, chat_id, expires_at) VALUES (?, ?, ?)")
    .bind(code, chatId, expiresAt)
    .run();
  const link = `${env.PUBLIC_URL}/connect?code=${code}`;
  await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, `Connect your Moodle account here (link valid 10 minutes):\n${link}`);
}

function formatAssignmentPush(a: Assignment): string {
  const due = a.duedate ? new Date(a.duedate * 1000).toLocaleString() : "no due date";
  return `📚 New assignment in <b>${escapeHtml(a.courseName)}</b>\n<a href="${a.url}">${escapeHtml(a.name)}</a>\nDue: ${due}`;
}

function formatAnnouncementPush(an: Announcement): string {
  return `📢 New announcement in <b>${escapeHtml(an.courseName)}</b>\n<a href="${an.url}">${escapeHtml(an.subject)}</a>`;
}

function groupByCourse<T extends { courseName: string }>(items: T[]): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const list = groups.get(item.courseName) ?? [];
    list.push(item);
    groups.set(item.courseName, list);
  }
  return new Map([...groups.entries()].sort((a, b) => a[0].localeCompare(b[0])));
}

const MAX_CHUNK_LENGTH = 3500;

function chunkBlocks(blocks: string[]): string[] {
  const chunks: string[] = [];
  let current = "";
  for (const block of blocks) {
    const candidate = current ? `${current}\n\n${block}` : block;
    if (candidate.length > MAX_CHUNK_LENGTH && current) {
      chunks.push(current);
      current = block;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

async function sendChunks(env: Env, chatId: number, loadingMessageId: number | null, chunks: string[]) {
  if (loadingMessageId !== null) {
    await editMessageText(env.TELEGRAM_BOT_TOKEN, chatId, loadingMessageId, chunks[0]);
  } else {
    await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, chunks[0]);
  }
  for (const chunk of chunks.slice(1)) {
    await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, chunk);
  }
}

async function sendAssignmentsList(env: Env, user: UserRow) {
  const loadingId = await sendMessage(env.TELEGRAM_BOT_TOKEN, user.chat_id, "⏳ Fetching your assignments...");
  const auth: MoodleAuth = { moodleUrl: user.moodle_url, token: user.token };
  const assignments = await getAssignments(auth);

  if (assignments.length === 0) {
    const text = "No assignments found.";
    if (loadingId !== null) await editMessageText(env.TELEGRAM_BOT_TOKEN, user.chat_id, loadingId, text);
    else await sendMessage(env.TELEGRAM_BOT_TOKEN, user.chat_id, text);
    return;
  }

  const groups = groupByCourse(assignments);
  const blocks: string[] = [];
  for (const [courseName, items] of groups) {
    items.sort((a, b) => (a.duedate || Infinity) - (b.duedate || Infinity));
    const lines = items.map((a) => {
      const due = a.duedate ? new Date(a.duedate * 1000).toLocaleString() : "no due date";
      return `• <a href="${a.url}">${escapeHtml(a.name)}</a> — Due: ${due}`;
    });
    blocks.push(`<b>📘 ${escapeHtml(courseName)}</b>\n${lines.join("\n")}`);
  }
  await sendChunks(env, user.chat_id, loadingId, chunkBlocks(blocks));
}

async function sendAnnouncementsList(env: Env, user: UserRow) {
  const loadingId = await sendMessage(env.TELEGRAM_BOT_TOKEN, user.chat_id, "⏳ Fetching your announcements...");
  const auth: MoodleAuth = { moodleUrl: user.moodle_url, token: user.token };
  const courseIds = await getUserCourseIds(auth, user.moodle_user_id);
  const announcements = await getAnnouncements(auth, courseIds);

  if (announcements.length === 0) {
    const text = "No announcements found.";
    if (loadingId !== null) await editMessageText(env.TELEGRAM_BOT_TOKEN, user.chat_id, loadingId, text);
    else await sendMessage(env.TELEGRAM_BOT_TOKEN, user.chat_id, text);
    return;
  }

  const groups = groupByCourse(announcements);
  const blocks: string[] = [];
  for (const [courseName, items] of groups) {
    const lines = items.map((an) => `• <a href="${an.url}">${escapeHtml(an.subject)}</a>`);
    blocks.push(`<b>📘 ${escapeHtml(courseName)}</b>\n${lines.join("\n")}`);
  }
  await sendChunks(env, user.chat_id, loadingId, chunkBlocks(blocks));
}

const HELP_TEXT =
  "Commands:\n" +
  "/start – connect or reconnect your Moodle account\n" +
  "/assignments – list your current assignments\n" +
  "/announcements – list recent course announcements\n" +
  "/status – show your connected account\n" +
  "/help – show this message\n\n" +
  "You'll also get a message automatically whenever a new assignment or announcement appears.";

async function handleWebhook(req: Request, env: Env): Promise<Response> {
  if (req.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.TELEGRAM_WEBHOOK_SECRET) {
    return new Response("forbidden", { status: 403 });
  }
  const update: any = await req.json();
  const msg = update.message;
  if (!msg?.text || !msg.chat?.id) return new Response("ok");
  const chatId = msg.chat.id as number;
  const text = msg.text.trim();

  if (text.startsWith("/start")) {
    const existing = await getUser(env, chatId);
    if (existing) {
      await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, `Already connected as ${escapeHtml(existing.full_name)}.`, MENU_KEYBOARD);
    } else {
      await sendConnectLink(env, chatId);
    }
    return new Response("ok");
  }

  if (text === "/help") {
    await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, HELP_TEXT);
    return new Response("ok");
  }

  const user = await getUser(env, chatId);
  if (!user) {
    await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, "You're not connected yet. Send /start to connect your Moodle account.");
    return new Response("ok");
  }

  if (text === "/assignments" || text === "📚 Assignments") {
    await sendAssignmentsList(env, user);
  } else if (text === "/announcements" || text === "📢 Announcements") {
    await sendAnnouncementsList(env, user);
  } else if (text === "/status" || text === "ℹ️ Status") {
    await sendMessage(
      env.TELEGRAM_BOT_TOKEN,
      chatId,
      `Connected as <b>${escapeHtml(user.full_name)}</b>\nMoodle site: ${escapeHtml(user.moodle_url)}`,
      MENU_KEYBOARD
    );
  } else {
    await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, HELP_TEXT, MENU_KEYBOARD);
  }
  return new Response("ok");
}

async function handleApiConnect(req: Request, env: Env): Promise<Response> {
  const body: any = await req.json();
  const { code, moodleUrl, username, password } = body;
  if (!code || !moodleUrl || !username || !password) {
    return Response.json({ error: "Missing fields" }, { status: 400 });
  }
  if (!isValidMoodleUrl(moodleUrl)) {
    return Response.json({ error: "Moodle URL must be a valid https:// URL" }, { status: 400 });
  }

  // Delete-and-return makes the code single-use: a second request with the
  // same code (replay, or a race) finds no row and is rejected.
  const row = await env.DB.prepare("DELETE FROM link_codes WHERE code = ? RETURNING chat_id, expires_at")
    .bind(code)
    .first<{ chat_id: number; expires_at: number }>();
  if (!row || row.expires_at < Math.floor(Date.now() / 1000)) {
    return Response.json({ error: "Link expired, send /start again in Telegram" }, { status: 400 });
  }

  let token: string;
  try {
    token = await getToken(moodleUrl, username, password);
  } catch (e: any) {
    return Response.json({ error: e.message ?? "Moodle login failed" }, { status: 400 });
  }

  const auth = { moodleUrl, token };
  const site: any = await getSiteInfo(auth);

  await env.DB.prepare(
    "INSERT INTO users (chat_id, moodle_url, token, moodle_user_id, full_name, created_at) VALUES (?, ?, ?, ?, ?, ?) " +
      "ON CONFLICT(chat_id) DO UPDATE SET moodle_url=excluded.moodle_url, token=excluded.token, moodle_user_id=excluded.moodle_user_id, full_name=excluded.full_name"
  )
    .bind(row.chat_id, moodleUrl, token, site.userid, site.fullname, Math.floor(Date.now() / 1000))
    .run();

  await sendMessage(
    env.TELEGRAM_BOT_TOKEN,
    row.chat_id,
    `Connected as ${escapeHtml(site.fullname)}. You'll get notified about new assignments and announcements.`,
    MENU_KEYBOARD
  );

  return Response.json({ ok: true });
}

async function checkUser(env: Env, user: { chat_id: number; moodle_url: string; token: string; moodle_user_id: number }) {
  const auth = { moodleUrl: user.moodle_url, token: user.token };

  const [assignments, courseIds] = await Promise.all([
    getAssignments(auth),
    getUserCourseIds(auth, user.moodle_user_id),
  ]);
  const announcements = await getAnnouncements(auth, courseIds);

  for (const a of assignments) {
    const seen = await env.DB.prepare("SELECT 1 FROM seen_items WHERE chat_id = ? AND item_type = 'assignment' AND item_id = ?")
      .bind(user.chat_id, a.id)
      .first();
    if (seen) continue;
    await env.DB.prepare("INSERT INTO seen_items (chat_id, item_type, item_id) VALUES (?, 'assignment', ?)")
      .bind(user.chat_id, a.id)
      .run();
    await sendMessage(env.TELEGRAM_BOT_TOKEN, user.chat_id, formatAssignmentPush(a));
  }

  for (const an of announcements) {
    const seen = await env.DB.prepare("SELECT 1 FROM seen_items WHERE chat_id = ? AND item_type = 'announcement' AND item_id = ?")
      .bind(user.chat_id, an.id)
      .first();
    if (seen) continue;
    await env.DB.prepare("INSERT INTO seen_items (chat_id, item_type, item_id) VALUES (?, 'announcement', ?)")
      .bind(user.chat_id, an.id)
      .run();
    await sendMessage(env.TELEGRAM_BOT_TOKEN, user.chat_id, formatAnnouncementPush(an));
  }
}

async function runPoll(env: Env) {
  const { results } = await env.DB.prepare("SELECT chat_id, moodle_url, token, moodle_user_id FROM users").all<{
    chat_id: number;
    moodle_url: string;
    token: string;
    moodle_user_id: number;
  }>();
  for (const user of results ?? []) {
    try {
      await checkUser(env, user);
    } catch (e) {
      console.error("poll failed for", user.chat_id, e);
    }
  }
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/webhook" && req.method === "POST") {
      return handleWebhook(req, env);
    }
    if (url.pathname === "/connect" && req.method === "GET") {
      return new Response(connectHtml, { headers: { "content-type": "text/html; charset=utf-8" } });
    }
    if (url.pathname === "/api/connect" && req.method === "POST") {
      return handleApiConnect(req, env);
    }
    return new Response("Not found", { status: 404 });
  },

  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runPoll(env));
  },
};
