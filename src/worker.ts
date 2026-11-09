// trunkrecorder.pro/corpus: takes IQ recordings from Trunk Recorder Pro and lists them.
// Recordings are public plain URLs. What counts as a regression test is decided in
// TrunkRecorder/trunk-recorder-pro, by people with write access to it.

import { BYTES_PER_DAY, INSTALLS_PER_IP_PER_DAY, KEEP_DAYS, MAX_EXPECTED_BYTES, MAX_WATERFALL_BYTES, parseSubmission, partsOf, SUBMISSIONS_PER_DAY } from "./limits.ts";
import { PAGE } from "./page.ts";

export interface Env {
  DB: D1Database;
  IQ: R2Bucket;
  BLOB_URL: string;
  MAINTAINERS_REPO: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  /** Only a test's: GitHub stands in. */
  GITHUB_WEB?: string;
  GITHUB_API?: string;
  DECODE_TOKEN?: string;
}

const API = "/corpus/api/v1";
const DAY_MS = 86_400_000;
const SESSION_S = 7 * 86_400;

const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json", "access-control-allow-origin": "*" } });
const fail = (error: string, status = 400) => json({ error }, status);
const blobKey = (sha256: string) => `blobs/${sha256}`;

function secret(): string {
  const b = crypto.getRandomValues(new Uint8Array(24));
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

function bearer(req: Request): string {
  return (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
}

interface Row {
  id: string;
  receipt: string;
  token: string;
  state: string;
  purpose: string;
  tier: string;
  protocol: string;
  note: string;
  created_ms: number;
  ready_ms: number | null;
  results_token: string;
  checks: string | null;
  reviewed_by: string | null;
  reviewed_ms: number | null;
}

interface RegressionRow {
  id: string;
  submission: string;
  state: string;
  issue: number | null;
  tolerance: number;
  promoted_by: string;
  promoted_ms: number;
}

interface FileRow {
  submission: string;
  name: string;
  sha256: string;
  bytes: number;
  upload_id: string | null;
  parts: string;
}

async function fileRows(env: Env, id: string): Promise<FileRow[]> {
  return (await env.DB.prepare("SELECT * FROM files WHERE submission = ? ORDER BY name").bind(id).all<FileRow>()).results;
}

async function publicView(env: Env, s: Row, regression: RegressionRow | null) {
  const files = await fileRows(env, s.id);
  return {
    id: s.id,
    state: s.state,
    purpose: s.purpose,
    tier: s.tier,
    protocol: s.protocol,
    note: s.note,
    created_ms: s.created_ms,
    checks: s.checks ? JSON.parse(s.checks) : null,
    regression: regression && { id: regression.id, state: regression.state, issue: regression.issue, promoted_by: regression.promoted_by, promoted_ms: regression.promoted_ms },
    reviewed_by: s.reviewed_by,
    has_diagnostics: files.some((f) => f.name === "diagnostics.json"),
    bytes: files.reduce((n, f) => n + f.bytes, 0),
    files: files.map((f) => ({ name: f.name, sha256: f.sha256, bytes: f.bytes, url: env.BLOB_URL + f.sha256 })),
  };
}

async function byId(env: Env, id: string): Promise<Row | null> {
  return env.DB.prepare("SELECT * FROM submissions WHERE id = ?").bind(id).first<Row>();
}

/** Its blobs that nothing else uses, and its results, gone. */
async function remove(env: Env, id: string, keep: Set<string> = new Set()) {
  const files = await fileRows(env, id);
  for (const f of files) {
    if (f.upload_id) await env.IQ.resumeMultipartUpload(blobKey(f.sha256), f.upload_id).abort().catch(() => {});
    const others = await env.DB.prepare("SELECT count(*) AS n FROM files WHERE sha256 = ? AND submission != ?").bind(f.sha256, id).first<{ n: number }>();
    if (!others?.n && !keep.has(f.sha256)) await env.IQ.delete(blobKey(f.sha256));
  }
  const derived = await env.IQ.list({ prefix: `derived/${id}/` });
  if (derived.objects.length) await env.IQ.delete(derived.objects.map((o) => o.key));
  await env.DB.batch([env.DB.prepare("DELETE FROM files WHERE submission = ?").bind(id), env.DB.prepare("DELETE FROM submissions WHERE id = ?").bind(id)]);
}

async function createInstall(req: Request, env: Env): Promise<Response> {
  const ip = req.headers.get("cf-connecting-ip") ?? "local";
  const since = Date.now() - DAY_MS;
  const made = await env.DB.prepare("SELECT count(*) AS n FROM installs WHERE ip = ? AND created_ms > ?").bind(ip, since).first<{ n: number }>();
  if ((made?.n ?? 0) >= INSTALLS_PER_IP_PER_DAY) return fail("Too many installs from here today.", 429);
  const token = secret();
  await env.DB.prepare("INSERT INTO installs (token, ip, created_ms) VALUES (?, ?, ?)").bind(token, ip, Date.now()).run();
  return json({ token });
}

async function createSubmission(req: Request, env: Env): Promise<Response> {
  const token = bearer(req);
  if (!(await env.DB.prepare("SELECT 1 AS y FROM installs WHERE token = ?").bind(token).first())) return fail("Unknown install.", 401);
  const parsed = parseSubmission(await req.json().catch(() => null));
  if (typeof parsed === "string") return fail(parsed);
  const since = Date.now() - DAY_MS;
  const today = await env.DB.prepare("SELECT count(DISTINCT s.id) AS n, COALESCE(sum(f.bytes), 0) AS bytes FROM submissions s LEFT JOIN files f ON f.submission = s.id WHERE s.token = ? AND s.created_ms > ?").bind(token, since).first<{ n: number; bytes: number }>();
  const total = parsed.files.reduce((n, f) => n + f.bytes, 0);
  if ((today?.n ?? 0) >= SUBMISSIONS_PER_DAY || (today?.bytes ?? 0) + total > BYTES_PER_DAY) return fail("This install has sent as much as it can today.", 429);
  const id = secret().slice(0, 16);
  const receipt = secret();
  const have: string[] = [];
  const statements = [env.DB.prepare("INSERT INTO submissions (id, receipt, token, state, purpose, tier, protocol, note, created_ms, results_token) VALUES (?, ?, ?, 'uploading', ?, ?, ?, ?, ?, ?)").bind(id, receipt, token, parsed.purpose, parsed.tier, parsed.protocol, parsed.note, Date.now(), secret())];
  for (const f of parsed.files) {
    let upload: string | null = null;
    if (await env.IQ.head(blobKey(f.sha256))) have.push(f.sha256);
    else upload = (await env.IQ.createMultipartUpload(blobKey(f.sha256))).uploadId;
    statements.push(env.DB.prepare("INSERT INTO files (submission, name, sha256, bytes, upload_id) VALUES (?, ?, ?, ?, ?)").bind(id, f.name, f.sha256, f.bytes, upload));
  }
  await env.DB.batch(statements);
  return json({ id, receipt, have });
}

async function putPart(req: Request, env: Env, id: string, name: string, n: number): Promise<Response> {
  const s = await byId(env, id);
  if (!s || s.token !== bearer(req)) return fail("No such submission.", 404);
  if (s.state !== "uploading") return fail("It's already been received.", 409);
  const f = await env.DB.prepare("SELECT * FROM files WHERE submission = ? AND name = ?").bind(id, name).first<FileRow>();
  if (!f?.upload_id) return fail("No such file to upload.", 404);
  if (!Number.isInteger(n) || n < 1 || n > partsOf(f.bytes) || !req.body) return fail("No such part.");
  const part = await env.IQ.resumeMultipartUpload(blobKey(f.sha256), f.upload_id).uploadPart(n, req.body);
  // One statement, so two parts arriving together can't lose each other.
  await env.DB.prepare("UPDATE files SET parts = (SELECT json_group_array(json(value)) FROM (SELECT value FROM json_each(files.parts) WHERE json_extract(value, '$.partNumber') != ?1 UNION ALL SELECT json(?2))) WHERE submission = ?3 AND name = ?4").bind(n, JSON.stringify({ partNumber: part.partNumber, etag: part.etag }), id, name).run();
  return json({ part: n });
}

async function complete(req: Request, env: Env, id: string): Promise<Response> {
  const s = await byId(env, id);
  if (!s || s.token !== bearer(req)) return fail("No such submission.", 404);
  if (s.state !== "uploading") return json({ state: s.state });
  for (const f of await fileRows(env, id)) {
    if (!f.upload_id) continue;
    const parts = (JSON.parse(f.parts) as R2UploadedPart[]).sort((a, b) => a.partNumber - b.partNumber);
    if (parts.length !== partsOf(f.bytes)) return fail(`${f.name}: ${parts.length} of ${partsOf(f.bytes)} parts have come.`, 409);
    await env.IQ.resumeMultipartUpload(blobKey(f.sha256), f.upload_id).complete(parts);
    await env.DB.prepare("UPDATE files SET upload_id = NULL, parts = '[]' WHERE submission = ? AND name = ?").bind(id, f.name).run();
  }
  await env.DB.prepare("UPDATE submissions SET state = 'received' WHERE id = ?").bind(id).run();
  return json({ state: "received" });
}

/** What the decode job has to check. */
async function pending(req: Request, env: Env): Promise<Response> {
  if (!env.DECODE_TOKEN || bearer(req) !== env.DECODE_TOKEN) return fail("Not allowed.", 401);
  const rows = await env.DB.prepare("SELECT id, results_token FROM submissions WHERE state = 'received' ORDER BY created_ms LIMIT 20").all<{ id: string; results_token: string }>();
  return json({ pending: rows.results });
}

/** The decode job's verdict. A capture that fails is deleted. */
async function results(req: Request, env: Env, id: string): Promise<Response> {
  const s = await byId(env, id);
  if (!s || s.results_token !== bearer(req) || !s.results_token) return fail("No such submission.", 404);
  const v = (await req.json().catch(() => null)) as { ok?: boolean; checks?: unknown } | null;
  if (!v) return fail("Results are JSON.");
  if (!v.ok) {
    await remove(env, id, await testHashes(env));
    return json({ state: "failed" });
  }
  await env.DB.prepare("UPDATE submissions SET state = 'ready', ready_ms = ?, checks = ? WHERE id = ?").bind(Date.now(), JSON.stringify(v.checks ?? {}), id).run();
  return json({ state: "ready" });
}

async function putWaterfall(req: Request, env: Env, id: string, n: number): Promise<Response> {
  const s = await byId(env, id);
  if (!s || s.results_token !== bearer(req) || !s.results_token) return fail("No such submission.", 404);
  const body = await req.arrayBuffer();
  if (body.byteLength > MAX_WATERFALL_BYTES || !(n >= 0 && n < 32)) return fail("That's no waterfall.");
  await env.IQ.put(`derived/${id}/waterfall-${n}.bin`, body);
  return json({});
}

async function putExpected(req: Request, env: Env, id: string): Promise<Response> {
  const s = await byId(env, id);
  if (!s || s.results_token !== bearer(req) || !s.results_token) return fail("No such submission.", 404);
  const body = await req.arrayBuffer();
  if (body.byteLength > MAX_EXPECTED_BYTES) return fail("That's too long.");
  await env.IQ.put(`derived/${id}/expected.jsonl`, body);
  return json({});
}

/** By its contributor's receipt, or by a maintainer. A regression test has to come off the list first. */
async function withdraw(req: Request, env: Env, id: string): Promise<Response> {
  const s = await byId(env, id);
  if (!s) return fail("No such submission.", 404);
  if (req.headers.get("x-receipt") !== s.receipt) {
    const who = await maintainer(req, env);
    if (who instanceof Response) return who;
  }
  if (await regressionOf(env, id)) return fail("It's a regression test: take it off the list first.", 409);
  await remove(env, id);
  return json({ withdrawn: true });
}

/** Everything the regression tests use. */
async function testHashes(env: Env): Promise<Set<string>> {
  const rows = await env.DB.prepare("SELECT f.sha256 FROM regression r JOIN files f ON f.submission = r.submission").all<{ sha256: string }>();
  return new Set(rows.results.map((r) => r.sha256));
}

async function regressionOf(env: Env, id: string): Promise<RegressionRow | null> {
  return env.DB.prepare("SELECT * FROM regression WHERE submission = ?").bind(id).first<RegressionRow>();
}

// ---- Signing in, which only maintainers' actions need. ----

const cookies = (req: Request) => Object.fromEntries((req.headers.get("cookie") ?? "").split(";").map((c) => c.trim().split("=") as [string, string]));

function cookie(req: Request, name: string, value: string, maxAge: number): string {
  const secure = new URL(req.url).protocol === "https:" ? "; Secure" : "";
  return `${name}=${value}; Path=/corpus; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

const githubWeb = (env: Env) => env.GITHUB_WEB || "https://github.com";
const githubApi = (env: Env) => env.GITHUB_API || "https://api.github.com";
const githubHeaders = (token: string) => ({ authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "trunk-recorder-corpus" });

function signIn(req: Request, env: Env): Response {
  if (!env.GITHUB_CLIENT_ID) return new Response("Signing in isn't set up.", { status: 503 });
  const state = secret();
  const url = new URL(req.url);
  const to = new URL(`${githubWeb(env)}/login/oauth/authorize`);
  to.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
  to.searchParams.set("redirect_uri", `${url.origin}/corpus/auth/callback`);
  to.searchParams.set("state", state);
  return new Response(null, { status: 302, headers: { location: to.toString(), "set-cookie": cookie(req, "corpus_state", state, 600) } });
}

async function signedIn(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const state = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  if (!code || !state || cookies(req).corpus_state !== state) return new Response("That sign-in didn't match. Try again.", { status: 400 });
  const r = await fetch(`${githubWeb(env)}/login/oauth/access_token`, { method: "POST", headers: { accept: "application/json", "content-type": "application/json", "user-agent": "trunk-recorder-corpus" }, body: JSON.stringify({ client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET, code }) });
  const token = ((await r.json()) as { access_token?: string }).access_token;
  if (!token) return new Response("GitHub didn't sign you in. Try again.", { status: 400 });
  const user = (await (await fetch(`${githubApi(env)}/user`, { headers: githubHeaders(token) })).json()) as { login?: string };
  if (!user.login) return new Response("GitHub didn't say who you are.", { status: 400 });
  const id = secret();
  await env.DB.prepare("INSERT INTO sessions (id, login, token, created_ms) VALUES (?, ?, ?, ?)").bind(id, user.login, token, Date.now()).run();
  const headers = new Headers({ location: "/corpus" });
  headers.append("set-cookie", cookie(req, "corpus_session", id, SESSION_S));
  headers.append("set-cookie", cookie(req, "corpus_state", "", 0));
  return new Response(null, { status: 302, headers });
}

interface Session {
  id: string;
  login: string;
  token: string;
  created_ms: number;
}

async function session(req: Request, env: Env): Promise<Session | null> {
  const id = cookies(req).corpus_session;
  if (!id) return null;
  return env.DB.prepare("SELECT * FROM sessions WHERE id = ? AND created_ms > ?").bind(id, Date.now() - SESSION_S * 1000).first<Session>();
}

/** Whether they may write to the Trunk Recorder Pro repo, as GitHub says now. */
async function canWrite(env: Env, s: Session): Promise<boolean> {
  const r = await fetch(`${githubApi(env)}/repos/${env.MAINTAINERS_REPO}`, { headers: githubHeaders(s.token) });
  if (!r.ok) return false;
  const p = ((await r.json()) as { permissions?: { admin?: boolean; maintain?: boolean; push?: boolean } }).permissions;
  return !!(p?.admin || p?.maintain || p?.push);
}

/** Who's asking, if they're a maintainer; a refusal otherwise. Asked of GitHub every time, so access taken away is gone at once. */
async function maintainer(req: Request, env: Env): Promise<string | Response> {
  // (A cookie goes along with any site's form: only our own page may act on it.)
  if (req.headers.get("origin") !== new URL(req.url).origin) return fail("Not from this page.", 403);
  const s = await session(req, env);
  if (!s) return fail("Sign in with GitHub first.", 401);
  if (!(await canWrite(env, s))) return fail(`${s.login} doesn't have write access to ${env.MAINTAINERS_REPO}.`, 403);
  return s.login;
}

async function me(req: Request, env: Env): Promise<Response> {
  const canSignIn = !!env.GITHUB_CLIENT_ID;
  const s = await session(req, env);
  if (!s) return json({ login: null, maintainer: false, can_sign_in: canSignIn });
  return json({ login: s.login, maintainer: await canWrite(env, s), can_sign_in: canSignIn });
}

async function signOut(req: Request, env: Env): Promise<Response> {
  if (req.headers.get("origin") !== new URL(req.url).origin) return fail("Not from this page.", 403);
  const id = cookies(req).corpus_session;
  if (id) await env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(id).run();
  return new Response(JSON.stringify({}), { headers: { "content-type": "application/json", "set-cookie": cookie(req, "corpus_session", "", 0) } });
}

// ---- The regression list. ----

async function promote(req: Request, env: Env, id: string): Promise<Response> {
  const who = await maintainer(req, env);
  if (who instanceof Response) return who;
  const s = await byId(env, id);
  if (!s || s.state !== "ready") return fail("Only a recording that passed its checks can be a test.", 409);
  if (await regressionOf(env, id)) return fail("It's already a regression test.", 409);
  const v = ((await req.json().catch(() => ({}))) ?? {}) as { state?: string; issue?: unknown };
  const state = v.state ?? "active";
  if (state !== "active" && state !== "known-failing") return fail("Its state is active or known-failing.");
  const issue = v.issue === null || v.issue === undefined || v.issue === "" ? null : Number(v.issue);
  if (issue !== null && !(Number.isInteger(issue) && issue > 0)) return fail("That's not an issue number.");
  await env.DB.batch([
    env.DB.prepare("INSERT INTO regression (id, submission, state, issue, promoted_by, promoted_ms) VALUES (?, ?, ?, ?, ?, ?)").bind(`s-${id}`, id, state, issue, who, Date.now()),
    env.DB.prepare("UPDATE submissions SET reviewed_by = ?, reviewed_ms = ? WHERE id = ?").bind(who, Date.now(), id),
  ]);
  return json({ regression: await regressionOf(env, id) });
}

async function demote(req: Request, env: Env, id: string): Promise<Response> {
  const who = await maintainer(req, env);
  if (who instanceof Response) return who;
  await env.DB.prepare("DELETE FROM regression WHERE submission = ?").bind(id).run();
  return json({});
}

async function review(req: Request, env: Env, id: string): Promise<Response> {
  const who = await maintainer(req, env);
  if (who instanceof Response) return who;
  const v = (await req.json().catch(() => ({}))) as { reviewed?: boolean };
  await env.DB.prepare("UPDATE submissions SET reviewed_by = ?, reviewed_ms = ? WHERE id = ?").bind(v.reviewed === false ? null : who, v.reviewed === false ? null : Date.now(), id).run();
  return json({});
}

/** The list, as `trunk-pro tool corpus` reads it. */
async function regressionList(env: Env): Promise<Response> {
  const rows = (await env.DB.prepare("SELECT r.*, s.tier, s.protocol, s.checks FROM regression r JOIN submissions s ON s.id = r.submission ORDER BY r.promoted_ms, r.id").all<RegressionRow & { tier: string; protocol: string; checks: string | null }>()).results;
  const captures = await Promise.all(
    rows.map(async (r) => {
      const files = await fileRows(env, r.submission);
      return { id: r.id, tier: r.tier, protocol: r.protocol, seconds: r.checks ? (JSON.parse(r.checks).seconds ?? 0) : 0, bytes: files.reduce((n, f) => n + f.bytes, 0), files: files.map((f) => ({ name: f.name, sha256: f.sha256, bytes: f.bytes })), state: r.state, issue: r.issue, tolerance: r.tolerance };
    }),
  );
  return json({ version: 1, captures });
}

/** What a test's recording decoded to when it was checked, for a test with none in the repo yet. */
async function regressionExpected(env: Env, id: string): Promise<Response> {
  const r = await env.DB.prepare("SELECT submission FROM regression WHERE id = ?").bind(id).first<{ submission: string }>();
  const o = r && (await env.IQ.get(`derived/${r.submission}/expected.jsonl`));
  if (!o) return fail("No expected output here.", 404);
  return new Response(o.body, { headers: { "content-type": "text/plain; charset=utf-8", "access-control-allow-origin": "*" } });
}

/** Abandoned uploads, and recordings past their time that no test uses. */
async function retention(env: Env, now = Date.now()) {
  const keep = await testHashes(env);
  await env.DB.prepare("DELETE FROM sessions WHERE created_ms < ?").bind(now - SESSION_S * 1000).run();
  const stale = await env.DB.prepare("SELECT id FROM submissions WHERE state IN ('uploading', 'received') AND created_ms < ?").bind(now - DAY_MS).all<{ id: string }>();
  for (const s of stale.results) await remove(env, s.id, keep);
  const old = await env.DB.prepare("SELECT id FROM submissions WHERE state = 'ready' AND created_ms < ?").bind(now - KEEP_DAYS * DAY_MS).all<{ id: string }>();
  for (const s of old.results) {
    const files = await fileRows(env, s.id);
    if (!files.some((f) => keep.has(f.sha256))) await remove(env, s.id, keep);
  }
}

async function serveBlob(req: Request, env: Env, key: string): Promise<Response> {
  const obj = await env.IQ.get(key, { range: req.headers, onlyIf: req.headers });
  if (!obj) return new Response("Not found", { status: 404 });
  const headers = new Headers({ "access-control-allow-origin": "*", "cache-control": "public, max-age=31536000, immutable", "accept-ranges": "bytes" });
  obj.writeHttpMetadata(headers);
  if (!("body" in obj)) return new Response(null, { status: 304, headers });
  const range = obj.range as { offset: number; length: number } | undefined;
  if (range && req.headers.has("range")) {
    headers.set("content-range", `bytes ${range.offset}-${range.offset + range.length - 1}/${obj.size}`);
    headers.set("content-length", String(range.length));
    return new Response(obj.body, { status: 206, headers });
  }
  headers.set("content-length", String(obj.size));
  return new Response(obj.body, { headers });
}

async function route(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/$/, "");
  const m = req.method;
  if (m === "GET" && path === "/corpus") return new Response(PAGE, { headers: { "content-type": "text/html; charset=utf-8" } });
  if (m === "GET" && path === "/corpus/auth/login") return signIn(req, env);
  if (m === "GET" && path === "/corpus/auth/callback") return signedIn(req, env);
  if (m === "POST" && path === "/corpus/auth/logout") return signOut(req, env);
  const blob = path.match(/^\/corpus\/blobs\/([0-9a-f]{64})$/);
  if (m === "GET" && blob) return serveBlob(req, env, blobKey(blob[1]));
  if (!path.startsWith(API)) return new Response("Not found", { status: 404 });
  const rest = path.slice(API.length).split("/").filter(Boolean).map(decodeURIComponent);
  if (rest[0] === "installs" && rest.length === 1 && m === "POST") return createInstall(req, env);
  if (rest[0] === "pending" && rest.length === 1 && m === "GET") return pending(req, env);
  if (rest[0] === "me" && rest.length === 1 && m === "GET") return me(req, env);
  if (rest[0] === "regression" && m === "GET") {
    if (rest.length === 1) return regressionList(env);
    if (rest.length === 3 && rest[2] === "expected") return regressionExpected(env, rest[1]);
  }
  if (rest[0] !== "submissions") return fail("No such API.", 404);
  if (rest.length === 1 && m === "POST") return createSubmission(req, env);
  if (rest.length === 1 && m === "GET") {
    const rows = await env.DB.prepare("SELECT * FROM submissions WHERE state = 'ready' ORDER BY created_ms DESC LIMIT 500").all<Row>();
    const tests = new Map((await env.DB.prepare("SELECT * FROM regression").all<RegressionRow>()).results.map((r) => [r.submission, r]));
    return json({ submissions: await Promise.all(rows.results.map((s) => publicView(env, s, tests.get(s.id) ?? null))) });
  }
  const id = rest[1];
  if (!id) return fail("No such API.", 404);
  if (rest.length === 2 && m === "GET") {
    const s = await byId(env, id);
    if (!s || (s.state !== "ready" && s.results_token !== bearer(req))) return fail("No such submission.", 404);
    return json(await publicView(env, s, await regressionOf(env, s.id)));
  }
  if (rest.length === 2 && m === "DELETE") return withdraw(req, env, id);
  if (rest[2] === "complete" && m === "POST") return complete(req, env, id);
  if (rest[2] === "results" && m === "POST") return results(req, env, id);
  if (rest[2] === "expected" && m === "PUT") return putExpected(req, env, id);
  if (rest[2] === "promote" && m === "POST") return promote(req, env, id);
  if (rest[2] === "demote" && m === "POST") return demote(req, env, id);
  if (rest[2] === "review" && m === "POST") return review(req, env, id);
  if (rest[2] === "files" && rest[4] === "parts" && m === "PUT") return putPart(req, env, id, rest[3], Number(rest[5]));
  if (rest[2] === "waterfall" && m === "PUT") return putWaterfall(req, env, id, Number(rest[3]));
  if (rest[2] === "waterfall" && m === "GET") return serveBlob(req, env, `derived/${id}/waterfall-${Number(rest[3])}.bin`);
  return fail("No such API.", 404);
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    try {
      return await route(req, env);
    } catch (e) {
      console.error(e);
      return fail("Something went wrong here.", 500);
    }
  },
  async scheduled(_: ScheduledController, env: Env): Promise<void> {
    await retention(env);
  },
};
