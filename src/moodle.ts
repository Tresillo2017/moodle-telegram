export interface MoodleAuth {
  moodleUrl: string;
  token: string;
}

export async function getToken(moodleUrl: string, username: string, password: string) {
  const url = new URL("/login/token.php", moodleUrl);
  url.searchParams.set("username", username);
  url.searchParams.set("password", password);
  url.searchParams.set("service", "moodle_mobile_app");
  const res = await fetch(url.toString());
  const data: any = await res.json();
  if (data.error) throw new Error(data.error);
  return data.token as string;
}

async function callMoodle(auth: MoodleAuth, wsfunction: string, params: Record<string, string> = {}) {
  const url = new URL("/webservice/rest/server.php", auth.moodleUrl);
  url.searchParams.set("wstoken", auth.token);
  url.searchParams.set("wsfunction", wsfunction);
  url.searchParams.set("moodlewsrestformat", "json");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url.toString());
  const data: any = await res.json();
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

export async function getAssignments(auth: MoodleAuth): Promise<Assignment[]> {
  const data = await callMoodle(auth, "mod_assign_get_assignments");
  const out: Assignment[] = [];
  for (const course of data.courses ?? []) {
    for (const a of course.assignments ?? []) {
      const url = new URL("/mod/assign/view.php", auth.moodleUrl);
      url.searchParams.set("id", String(a.cmid));
      out.push({ id: a.id, name: a.name, duedate: a.duedate, courseName: course.fullname, url: url.toString() });
    }
  }
  return out;
}

export async function getUserCourseIds(auth: MoodleAuth, userId: number): Promise<number[]> {
  const data = await callMoodle(auth, "core_enrol_get_users_courses", { userid: String(userId) });
  return (data ?? []).map((c: any) => c.id);
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
