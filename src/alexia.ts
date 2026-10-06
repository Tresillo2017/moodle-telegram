const ALEXIA_BASE = "https://web2.alexiaedu.com/ACWeb";
export const ALEXIA_INSTITUTION_KEY = "NS2IrX8Iq04%3d";

// Cloudflare Workers' default fetch User-Agent doesn't look like a browser,
// which can get flagged by a target site's own bot protection (Alexia is
// itself Cloudflare-fronted). A realistic desktop UA avoids that.
const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

// A bare User-Agent isn't always enough for stricter bot management — real
// Chrome also sends these on every request, so their absence is itself a
// fingerprint. Included on all Alexia requests below.
const BROWSER_COMMON_HEADERS = {
  "User-Agent": BROWSER_USER_AGENT,
  Accept: "*/*",
  "Accept-Language": "es-ES,es;q=0.9,en;q=0.8",
  "sec-ch-ua": '"Chromium";v="128", "Not;A=Brand";v="24", "Google Chrome";v="128"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"Windows"',
  "Sec-Fetch-Site": "same-origin",
  "Sec-Fetch-Mode": "cors",
  "Sec-Fetch-Dest": "empty",
};

export interface AlexiaAuth {
  cookies: string;
}

// `Headers.getSetCookie()` is not in the `@cloudflare/workers-types` version
// this project resolves to (it's only defined under the dated-snapshot
// subpaths, not the root types this project's tsconfig picks up), and
// `Headers.get("set-cookie")` merges multiple Set-Cookie headers into one
// comma-joined string, which is ambiguous (cookie `Expires` values contain
// commas). Both Bun and the Workers runtime yield one `entries()` pair per
// Set-Cookie header, so iterate those instead.
function extractSetCookieHeaders(headers: Headers): string[] {
  const values: string[] = [];
  for (const [key, value] of headers.entries()) {
    if (key.toLowerCase() === "set-cookie") values.push(value);
  }
  return values;
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
    const name = cookiePart.slice(0, eq).trim();
    if (!name) continue; // guard against malformed "; HttpOnly; ..." cookie headers
    jar.set(name, cookiePart.slice(eq + 1).trim());
  }
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}

// NOTE: attribute order in Alexia's hidden inputs is inconsistent (some are
// `type="hidden" ... name="..."`, others are `name="..." type="hidden" ...`),
// so this extraction must not assume a fixed attribute order.
function extractHiddenFields(html: string): Record<string, string> {
  const fields: Record<string, string> = {};
  const inputRe = /<input\b[^>]*>/g;
  let inputMatch: RegExpExecArray | null;
  while ((inputMatch = inputRe.exec(html)) !== null) {
    const tag = inputMatch[0];
    if (!/type="hidden"/.test(tag)) continue;
    const nameMatch = tag.match(/name="([^"]+)"/);
    const valueMatch = tag.match(/value="([^"]*)"/);
    if (!nameMatch) continue;
    const value = valueMatch ? valueMatch[1] : "";
    fields[nameMatch[1]] = value.replace(/&quot;/g, '"').replace(/&amp;/g, "&");
  }
  return fields;
}

/**
 * Calls one method of the `WS_Data/WSLogOn.asmx` ASP.NET AJAX web service and
 * merges any `Set-Cookie` headers from the response into `cookies`.
 */
async function callLogOnService(
  method: string,
  body: Record<string, unknown>,
  loginUrl: string,
  cookies: string
): Promise<{ json: unknown; cookies: string }> {
  const res = await fetch(`${ALEXIA_BASE}/WS_Data/WSLogOn.asmx/${method}`, {
    method: "POST",
    headers: {
      ...BROWSER_COMMON_HEADERS,
      "Content-Type": "application/json; charset=UTF-8",
      Accept: "application/json, text/javascript, */*; q=0.01",
      "X-Requested-With": "XMLHttpRequest",
      Referer: loginUrl,
      Cookie: cookies,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`Alexia login request (${method}) failed with status ${res.status}`);
  }

  const mergedCookies = mergeCookies(cookies, extractSetCookieHeaders(res.headers));

  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new Error(`Alexia login (${method}) returned an unexpected response shape`);
  }

  return { json, cookies: mergedCookies };
}

/**
 * Logs into Alexia.
 *
 * Alexia's LogOn.aspx is not a plain ASP.NET WebForms postback: the visible
 * form only carries VIEWSTATE bookkeeping. The actual "Entrar" button
 * (`onclick="javascript:validar()"`, in logon.js) drives a sequence of
 * session-bound ASP.NET AJAX web service calls against
 * `WS_Data/WSLogOn.asmx`, confirmed against the live site:
 *
 * 1. `Validar({ token, nickname, password })` — `token` is the page's hidden
 *    `#Token` field. On success it returns `{"d":""}` and does NOT itself
 *    authenticate the session; on failure it returns `{"d":"<Spanish error
 *    message>"}` (e.g. "Usuario o código de acceso incorrecto").
 * 2. `GetRoles({ token })` — returns `{"d":{"OK":[{"Identificador":...}, ...]}}`,
 *    the list of roles/profiles the account can log in as. This account has
 *    exactly one role, so this code always picks `OK[0]`; an account with
 *    zero or multiple roles is out of scope (logon.js itself branches into a
 *    "no role" error or a role-picker popup in those cases, neither of which
 *    this headless flow can drive).
 * 3. `ValidarRol({ token, idRol, evaluarMultifactor: false })` — THIS is the
 *    call that actually flips the session to authenticated server-side: its
 *    response sets `.ASPXAUTH`/`InicioSesion`/`datosUsr` cookies. Before this
 *    call, even though `Validar` reported success, the `AC_SessionId`/
 *    `LogOnToken` cookies from the initial GET are still anonymous — any
 *    authenticated page request with just those redirects back to
 *    `LogOn.aspx`. (This was verified live: skipping this step, as an
 *    earlier version of this function did, produces cookies that pass
 *    `Validar` but fail every subsequent authenticated request.)
 *
 * All three calls must be made with the running cookie jar (`AC_SessionId`
 * ties `token` to the server-side session) and with
 * `X-Requested-With: XMLHttpRequest` plus a matching `Referer` — omitting
 * either causes the server to throw a null reference error instead of
 * validating credentials.
 */
export async function loginAlexia(username: string, password: string): Promise<AlexiaAuth> {
  // Alexia intermittently answers "Institución no válida" for the same valid
  // key/credentials (session/backend flakiness), so retry that error a few times.
  // ponytail: fixed 3 attempts, no backoff; add delay if it still flakes.
  for (let attempt = 1; ; attempt++) {
    try {
      return await loginAlexiaOnce(username, password);
    } catch (e) {
      if (attempt >= 3 || !(e instanceof Error) || !e.message.includes("Institución no válida")) throw e;
    }
  }
}

async function loginAlexiaOnce(username: string, password: string): Promise<AlexiaAuth> {
  const loginUrl = `${ALEXIA_BASE}/LogOn.aspx?key=${ALEXIA_INSTITUTION_KEY}`;
  const getRes = await fetch(loginUrl, {
    redirect: "manual",
    headers: { ...BROWSER_COMMON_HEADERS, "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "document" },
  });
  let cookies = mergeCookies("", extractSetCookieHeaders(getRes.headers));
  const html = await getRes.text();

  const hidden = extractHiddenFields(html);
  const token = hidden["Token"];
  if (!token) throw new Error("Alexia login page did not return the expected form");

  const validar = await callLogOnService("Validar", { token, nickname: username, password }, loginUrl, cookies);
  cookies = validar.cookies;
  const validarResult = validar.json as { d?: string };
  if (typeof validarResult.d !== "string") {
    throw new Error("Alexia login returned an unexpected response shape");
  }
  if (validarResult.d !== "") {
    throw new Error(`Alexia login failed — ${validarResult.d}`);
  }

  const roles = await callLogOnService("GetRoles", { token }, loginUrl, cookies);
  cookies = roles.cookies;
  const rolesResult = roles.json as { d?: { OK?: Array<{ Identificador?: string }>; Error?: string } };
  if (rolesResult.d?.Error) {
    throw new Error(`Alexia login failed — ${rolesResult.d.Error}`);
  }
  const firstRole = rolesResult.d?.OK?.[0];
  if (!firstRole?.Identificador) {
    throw new Error("Alexia login returned no usable role for this account");
  }

  const validarRol = await callLogOnService(
    "ValidarRol",
    { token, idRol: firstRole.Identificador, evaluarMultifactor: false },
    loginUrl,
    cookies
  );
  cookies = validarRol.cookies;
  const validarRolResult = validarRol.json as { d?: { OK?: boolean; Error?: string } };
  if (validarRolResult.d?.Error) {
    throw new Error(`Alexia login failed — ${validarRolResult.d.Error}`);
  }
  if (validarRolResult.d?.OK !== true) {
    throw new Error("Alexia login did not confirm the role — account may require an unsupported extra step");
  }

  return { cookies };
}

// GuidAlumno for the account this bot is connected to. This is a per-student
// identifier, not an institution-wide constant — like `SUBJECT_HOURS`
// (Task 4), it is hardcoded because this bot is single-tenant (one Alexia
// account), per the plan's architecture notes.
//
// SINGLE-TENANT LIMITATION: getAbsences always fetches attendance for this
// one hardcoded student, tied to one institution (ALEXIA_INSTITUTION_KEY),
// regardless of which Telegram user's poll cycle is running or whose Alexia
// credentials were used to log in. It is NOT safe to expose this feature to
// multiple Telegram users with different Alexia accounts without deriving
// this GUID from the authenticated session instead. See README.md.
const ALEXIA_GUID_ALUMNO = "02a900a1-3637-03c7-ae68-9ce58eb1dd08";

const ALEXIA_ATTENDANCE_TOTALS_GRID_ID = "ctl00_ContenidoPagina_ctl00_GridIncidenciasTotalesAlumnoSesiones1";

export interface AbsenceRecord {
  subject: string;
  absenceHours: number;
}

interface JqGridResponse {
  rows?: Array<{ cell?: string[] }>;
}

const FILTER_CONTROL = "ctl00$ContenidoPagina$ctl00$filtradorFechas1";

/**
 * Mirrors the page's "Display data for → School year" option: the date filter
 * (default: last week) is server-side session state, set by an UpdatePanel
 * postback whose argument is `"<from>#<to>"` (M/D/YYYY). The school-year bounds
 * come from the page's own `hdnFechaInicioCentro`/`hdnFechaFinalCentro` fields.
 */
async function selectSchoolYear(pageUrl: string, pageHtml: string, cookies: string): Promise<void> {
  const fields = extractHiddenFields(pageHtml);
  const from = fields[`${FILTER_CONTROL}$hdnFechaInicioCentro`];
  const to = fields[`${FILTER_CONTROL}$hdnFechaFinalCentro`];
  if (!from || !to) throw new Error("Alexia attendance page did not expose the school-year range");

  const form = new URLSearchParams({
    ...fields,
    "ctl00$scriptManager1": `ctl00$ContenidoPagina$ctl00$updGrid|${FILTER_CONTROL}`,
    [`${FILTER_CONTROL}$fechaInicio`]: from,
    [`${FILTER_CONTROL}$fechaFin`]: to,
    __EVENTTARGET: FILTER_CONTROL,
    __EVENTARGUMENT: `${from}#${to}`,
    __ASYNCPOST: "true",
  });
  const res = await fetch(pageUrl, {
    method: "POST",
    headers: {
      ...BROWSER_COMMON_HEADERS,
      Cookie: cookies,
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      "X-Requested-With": "XMLHttpRequest",
      "X-MicrosoftAjax": "Delta=true",
      Referer: pageUrl,
    },
    body: form,
  });
  const text = await res.text();
  if (/name="txtPassword"/.test(text)) throw new Error("Alexia session expired");
  // Delta responses look like `1|#||4|...|updatePanel|...`; errors use the `error` type.
  if (!res.ok || !text.includes("|updatePanel|") || text.includes("|error|")) {
    throw new Error("Alexia school-year filter request failed");
  }
}

/**
 * Fetches per-subject absence totals from Alexia.
 *
 * The "ficha del alumno" page (`Fichas/FichaAlumno.aspx`) does NOT itself
 * contain an absences table — it's a shell that lazily loads several tabs as
 * iframes, one of which (`incidencias/SeguimientoDiario.aspx`) renders a
 * jqGrid titled "Incidencias Totales Alumno Sesiones" (totals of incidents
 * per student session) with one row per subject and columns for CODIGO,
 * MATERIA (subject name), PROFESOR, and per-incident-type totals — the one
 * we need is `AUS` (ausencias/absences); there's also a `RET` (retrasos/
 * lateness) column we ignore.
 *
 * That grid's data is not in the page's initial HTML either: it's a second
 * request to the SAME `SeguimientoDiario.aspx` URL, with a `jqGridID` query
 * param added, which makes the server respond with the grid's JSON instead
 * of the page. Confirmed live: this JSON request only succeeds (200 + JSON)
 * if it's preceded by a plain GET of the page URL without `jqGridID` in the
 * same session — the server appears to need that first request to set up
 * some per-grid session state before the `jqGridID` request can read it;
 * skipping the warm-up GET, or making the JSON request as a standalone POST
 * with ASP.NET `__VIEWSTATE`/`__EVENTTARGET` postback fields (the more
 * "standard" WebForms pattern, tried first and confirmed NOT to work here),
 * both land on Alexia's generic runtime-error page instead.
 *
 * Each `AUS` cell is a snippet of HTML, e.g.
 * `<div class="tablaObservaciones_<guid>" ...><span id="spanObs">5</span>
 * <div class="divBotonObservacionesIncidencia">...`, or the same wrapper
 * with no `<span id="spanObs">` at all when the count is zero. The absence
 * value only ever appeared as a plain integer against this real account, but
 * the design spec calls out Spanish-locale comma decimals (e.g. `23,4`) as a
 * possibility elsewhere in Alexia, so the comma-to-dot normalization from
 * the original plan is kept here for robustness.
 */
export async function getAbsences(auth: AlexiaAuth): Promise<AbsenceRecord[]> {
  const seguimientoUrl = `${ALEXIA_BASE}/paginas/incidencias/SeguimientoDiario.aspx?GuidAlumno=${ALEXIA_GUID_ALUMNO}`;

  const warmUpRes = await fetch(seguimientoUrl, {
    headers: {
      ...BROWSER_COMMON_HEADERS,
      Cookie: auth.cookies,
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Dest": "document",
    },
  });
  const warmUpHtml = await warmUpRes.text();
  if (/name="txtPassword"/.test(warmUpHtml)) {
    throw new Error("Alexia session expired");
  }

  // The page defaults to a one-week date filter, so widen it to the whole school year.
  const cookies = mergeCookies(auth.cookies, extractSetCookieHeaders(warmUpRes.headers));
  await selectSchoolYear(seguimientoUrl, warmUpHtml, cookies);

  const gridUrl =
    `${seguimientoUrl}&jqGridID=${ALEXIA_ATTENDANCE_TOTALS_GRID_ID}` +
    "&page=1&rows=500&sidx=&sord=asc&_search=false";
  const gridRes = await fetch(gridUrl, {
    headers: {
      ...BROWSER_COMMON_HEADERS,
      Cookie: cookies,
      "X-Requested-With": "XMLHttpRequest",
      Referer: seguimientoUrl,
      Accept: "application/json, text/javascript, */*; q=0.01",
    },
  });
  const gridText = await gridRes.text();
  if (/name="txtPassword"/.test(gridText)) {
    throw new Error("Alexia session expired");
  }

  let grid: JqGridResponse;
  try {
    grid = JSON.parse(gridText) as JqGridResponse;
  } catch {
    throw new Error("Alexia attendance grid returned an unexpected response shape");
  }

  const records: AbsenceRecord[] = [];
  for (const row of grid.rows ?? []) {
    const cell = row.cell;
    if (!cell) continue;
    const subject = cell[3]?.trim();
    if (!subject) continue;
    const absenceCellHtml = cell[5] ?? "";
    const match = absenceCellHtml.match(/<span id="spanObs">([^<]*)<\/span>/);
    const raw = match ? match[1].trim() : "0";
    const hours = parseFloat(raw.replace(",", "."));
    if (Number.isNaN(hours)) continue;
    records.push({ subject, absenceHours: hours });
  }

  return records;
}

/**
 * Weekly hours per subject, keyed by the subject's canonical (Title Case, no
 * trailing period) name as used in this project's design docs.
 *
 * Alexia's `getAbsences` returns subject names that do NOT match these keys
 * verbatim — they differ in case and carry a trailing period (e.g. Alexia
 * returns `"Acceso a datos."` for the `"Acceso a Datos"` key here, and
 * `"Principios De Ciberseguridad"` — capital "De", no period — for the
 * `"Principios de Ciberseguridad"` key here). `computeAbsenceStatus` below
 * normalizes both sides before matching so these real-world subject strings
 * are not silently dropped; this map itself is kept in the canonical form on
 * purpose, since it's the readable reference other code/docs use.
 */
export const SUBJECT_HOURS: Record<string, number> = {
  "Acceso a Datos": 5,
  "Desarrollo de Interfaces": 6,
  "Programación Multimedia y Dispositivos Móviles": 4,
  "Programación de Servicios y Procesos": 4,
  "Principios de Ciberseguridad": 2,
  "Sistemas de Gestión Empresarial": 5,
  "Sostenibilidad aplicada al sistema productivo": 1,
  "Itinerario para la empleabilidad II": 2,
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

/** Lowercases, trims, and strips one optional trailing "." for subject-name matching. */
function normalizeSubjectName(name: string): string {
  return name.trim().replace(/\.$/, "").toLowerCase();
}

const NORMALIZED_SUBJECT_HOURS = new Map<string, number>(
  Object.entries(SUBJECT_HOURS).map(([subject, hours]) => [normalizeSubjectName(subject), hours])
);

/**
 * Computes each subject's absence ratio against its term limit.
 *
 * Subject matching against `SUBJECT_HOURS` is normalized (case-insensitive,
 * trailing "." stripped) rather than exact, because Alexia's real subject
 * text does not match `SUBJECT_HOURS`'s canonical keys verbatim — see that
 * map's doc comment. Records whose normalized subject has no match are
 * dropped. The returned `subject` is the record's original raw text (not the
 * canonical key), since later tasks display it to the user as-is.
 */
export function computeAbsenceStatus(records: AbsenceRecord[]): SubjectAbsenceStatus[] {
  const out: SubjectAbsenceStatus[] = [];
  for (const record of records) {
    const weeklyHours = NORMALIZED_SUBJECT_HOURS.get(normalizeSubjectName(record.subject));
    if (weeklyHours === undefined) continue;
    const limitHours = absenceLimitHours(weeklyHours);
    out.push({
      subject: record.subject,
      absenceHours: record.absenceHours,
      limitHours,
      ratio: record.absenceHours / limitHours,
    });
  }
  return out;
}
