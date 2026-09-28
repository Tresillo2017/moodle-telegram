const ALEXIA_BASE = "https://web2.alexiaedu.com/ACWeb";
export const ALEXIA_INSTITUTION_KEY = "NS2IrX8Iq04%3d";

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
 * Logs into Alexia.
 *
 * Alexia's LogOn.aspx is not a plain ASP.NET WebForms postback: the visible
 * form only carries VIEWSTATE bookkeeping. The actual "Entrar" button
 * (`onclick="javascript:validar()"`, in logon.js) calls a session-bound
 * ASP.NET AJAX web service, `WS_Data/WSLogOn.asmx/Validar`, with a JSON body
 * of `{ token, nickname, password }` — `token` being the page's hidden
 * `#Token` field, not the WebForms `__VIEWSTATE`/`__EVENTVALIDATION` fields
 * (those are unused here and were left out of the request; only `token` is
 * required, confirmed against the live site). The call must be made with the
 * session cookies from the initial GET (`AC_SessionId` ties the token to the
 * server-side session) and with `X-Requested-With: XMLHttpRequest` plus a
 * matching `Referer` — omitting either causes the server to throw a null
 * reference error instead of validating credentials.
 *
 * On success the endpoint returns `{"d":""}` and does not set a new
 * authentication cookie: the existing `AC_SessionId` session becomes
 * authenticated server-side. On failure it returns `{"d":"<Spanish error
 * message>"}` (e.g. "Usuario o código de acceso incorrecto").
 */
export async function loginAlexia(username: string, password: string): Promise<AlexiaAuth> {
  const loginUrl = `${ALEXIA_BASE}/LogOn.aspx?key=${ALEXIA_INSTITUTION_KEY}`;
  const getRes = await fetch(loginUrl, { redirect: "manual" });
  const cookies = mergeCookies("", extractSetCookieHeaders(getRes.headers));
  const html = await getRes.text();

  const hidden = extractHiddenFields(html);
  const token = hidden["Token"];
  if (!token) throw new Error("Alexia login page did not return the expected form");

  const validarRes = await fetch(`${ALEXIA_BASE}/WS_Data/WSLogOn.asmx/Validar`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=UTF-8",
      "X-Requested-With": "XMLHttpRequest",
      Referer: loginUrl,
      Cookie: cookies,
    },
    body: JSON.stringify({ token, nickname: username, password }),
  });

  if (!validarRes.ok) {
    throw new Error(`Alexia login request failed with status ${validarRes.status}`);
  }

  let result: { d?: string };
  try {
    result = (await validarRes.json()) as { d?: string };
  } catch {
    throw new Error("Alexia login returned an unexpected response shape");
  }

  if (typeof result.d !== "string") {
    throw new Error("Alexia login returned an unexpected response shape");
  }
  if (result.d !== "") {
    throw new Error(`Alexia login failed — ${result.d}`);
  }

  return { cookies };
}
