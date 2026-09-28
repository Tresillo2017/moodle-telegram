export interface MoodleAuth {
  moodleUrl: string;
  token: string;
}

// Cloudflare Workers' default fetch User-Agent doesn't look like a browser,
// which can get flagged by a Moodle site's own bot/WAF protection (many run
// behind Cloudflare themselves). A realistic desktop UA avoids that.
const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

export async function getToken(moodleUrl: string, username: string, password: string) {
  const url = new URL("/login/token.php", moodleUrl);
  url.searchParams.set("username", username);
  url.searchParams.set("password", password);
  url.searchParams.set("service", "moodle_mobile_app");
  const res = await fetch(url.toString(), { headers: { "User-Agent": BROWSER_USER_AGENT } });
  const data = await parseMoodleJson(res, "log in to");
  if (data.error) throw new Error(data.error);
  return data.token as string;
}

// Moodle sites (and any Cloudflare-proxied host in front of them) can return
// an HTML error page instead of JSON — e.g. a wrong URL, a maintenance page,
// or a transient edge error. An unguarded res.json() then throws a raw
// "Unexpected token ... is not valid JSON" message that gets shown to the
// user as-is; this wraps that into something they can act on.
async function parseMoodleJson(res: Response, action: string): Promise<any> {
  try {
    return await res.json();
  } catch {
    throw new Error(`Could not ${action} your Moodle site — it didn't return a valid response (site may be down or the URL may be wrong)`);
  }
}

async function callMoodle(auth: MoodleAuth, wsfunction: string, params: Record<string, string> = {}) {
  const url = new URL("/webservice/rest/server.php", auth.moodleUrl);
  url.searchParams.set("wstoken", auth.token);
  url.searchParams.set("wsfunction", wsfunction);
  url.searchParams.set("moodlewsrestformat", "json");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url.toString(), { headers: { "User-Agent": BROWSER_USER_AGENT } });
  const data = await parseMoodleJson(res, "reach");
  if (data?.exception) throw new Error(data.message ?? data.exception);
  return data;
}

export async function getSiteInfo(auth: MoodleAuth) {
  return callMoodle(auth, "core_webservice_get_site_info");
}

export interface Assignment {
  id: number;
  name: string;
  duedate: number;
  courseName: string;
  url: string;
}

export async function getAssignments(auth: MoodleAuth, activeCourseIds?: Set<number>): Promise<Assignment[]> {
  const data = await callMoodle(auth, "mod_assign_get_assignments");
  const out: Assignment[] = [];
  for (const course of data.courses ?? []) {
    if (activeCourseIds && !activeCourseIds.has(course.id)) continue;
    for (const a of course.assignments ?? []) {
      const url = new URL("/mod/assign/view.php", auth.moodleUrl);
      url.searchParams.set("id", String(a.cmid));
      out.push({ id: a.id, name: a.name, duedate: a.duedate, courseName: course.fullname, url: url.toString() });
    }
  }
  return out;
}

async function isSubmitted(auth: MoodleAuth, assignmentId: number, userId: number): Promise<boolean> {
  const data = await callMoodle(auth, "mod_assign_get_submission_status", {
    assignid: String(assignmentId),
    userid: String(userId),
  });
  const status = data?.lastattempt?.submission?.status ?? data?.lastattempt?.teamsubmission?.status;
  return status === "submitted";
}

export async function filterUnsubmitted(
  auth: MoodleAuth,
  userId: number,
  assignments: Assignment[]
): Promise<Assignment[]> {
  const flags = await Promise.all(assignments.map((a) => isSubmitted(auth, a.id, userId)));
  return assignments.filter((_, i) => !flags[i]);
}

// A course counts as an "old project" once its end date has passed. Courses
// with no end date (enddate === 0) are treated as ongoing.
export async function getActiveCourseIds(auth: MoodleAuth, userId: number): Promise<Set<number>> {
  const data = await callMoodle(auth, "core_enrol_get_users_courses", { userid: String(userId) });
  const now = Date.now() / 1000;
  const active = (data ?? []).filter((c: any) => c.visible !== 0 && (!c.enddate || c.enddate > now));
  return new Set(active.map((c: any) => c.id));
}

export interface Announcement {
  id: number;
  subject: string;
  courseName: string;
  url: string;
}

export async function getAnnouncements(auth: MoodleAuth, courseIds: number[]): Promise<Announcement[]> {
  if (courseIds.length === 0) return [];
  const forumsData = await callMoodle(auth, "mod_forum_get_forums_by_courses", courseIds.length > 0
    ? Object.fromEntries(courseIds.map((id, i) => [`courseids[${i}]`, String(id)]))
    : {});
  const newsForums = (forumsData ?? []).filter((f: any) => f.type === "news");
  const out: Announcement[] = [];
  for (const forum of newsForums) {
    const disc = await callMoodle(auth, "mod_forum_get_forum_discussions", { forumid: String(forum.id) });
    for (const d of disc.discussions ?? []) {
      const discussionId = d.discussion ?? d.id;
      const url = new URL("/mod/forum/discuss.php", auth.moodleUrl);
      url.searchParams.set("d", String(discussionId));
      out.push({ id: discussionId, subject: d.subject, courseName: forum.course_fullname ?? "", url: url.toString() });
    }
  }
  return out;
}
