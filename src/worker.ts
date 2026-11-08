// trunkrecorder.pro/corpus: takes IQ recordings from Trunk Recorder Pro and lists them.
// Recordings are public plain URLs. What counts as a regression test is decided in
// TrunkRecorder/trunk-recorder-pro, by people with write access to it.

import { BYTES_PER_DAY, INSTALLS_PER_IP_PER_DAY, KEEP_DAYS, MAX_WATERFALL_BYTES, parseSubmission, partsOf, SUBMISSIONS_PER_DAY } from "./limits.ts";
import { PAGE } from "./page.ts";

export interface Env {
  DB: D1Database;
  IQ: R2Bucket;
  MANIFEST_URL: string;
  BLOB_URL: string;
  ADMIN_TOKEN?: string;
  DECODE_TOKEN?: string;
}

const API = "/corpus/api/v1";
const DAY_MS = 86_400_000;

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

async function publicView(env: Env, s: Row) {
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
    await remove(env, id, await manifestHashes(env));
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

async function withdraw(req: Request, env: Env, id: string): Promise<Response> {
  const s = await byId(env, id);
  const admin = !!env.ADMIN_TOKEN && bearer(req) === env.ADMIN_TOKEN;
  if (!s || (!admin && req.headers.get("x-receipt") !== s.receipt)) return fail("No such submission.", 404);
  await remove(env, id);
  return json({ withdrawn: true });
}

async function manifestHashes(env: Env): Promise<Set<string>> {
  const keep = new Set<string>();
  const r = await fetch(env.MANIFEST_URL).catch(() => null);
  if (!r?.ok) throw new Error("couldn't read the manifest");
  const m = (await r.json()) as { captures?: { files?: { sha256?: string }[] }[] };
  for (const c of m.captures ?? []) for (const f of c.files ?? []) if (f.sha256) keep.add(f.sha256);
  return keep;
}

/** Abandoned uploads, and recordings past their time that no test uses. */
async function retention(env: Env, now = Date.now()) {
  const keep = await manifestHashes(env);
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
  const blob = path.match(/^\/corpus\/blobs\/([0-9a-f]{64})$/);
  if (m === "GET" && blob) return serveBlob(req, env, blobKey(blob[1]));
  if (!path.startsWith(API)) return new Response("Not found", { status: 404 });
  const rest = path.slice(API.length).split("/").filter(Boolean).map(decodeURIComponent);
  if (rest[0] === "installs" && rest.length === 1 && m === "POST") return createInstall(req, env);
  if (rest[0] === "pending" && rest.length === 1 && m === "GET") return pending(req, env);
  if (rest[0] !== "submissions") return fail("No such API.", 404);
  if (rest.length === 1 && m === "POST") return createSubmission(req, env);
  if (rest.length === 1 && m === "GET") {
    const rows = await env.DB.prepare("SELECT * FROM submissions WHERE state = 'ready' ORDER BY created_ms DESC LIMIT 500").all<Row>();
    return json({ submissions: await Promise.all(rows.results.map((s) => publicView(env, s))) });
  }
  const id = rest[1];
  if (!id) return fail("No such API.", 404);
  if (rest.length === 2 && m === "GET") {
    const s = await byId(env, id);
    if (!s || (s.state !== "ready" && s.results_token !== bearer(req))) return fail("No such submission.", 404);
    return json(await publicView(env, s));
  }
  if (rest.length === 2 && m === "DELETE") return withdraw(req, env, id);
  if (rest[2] === "complete" && m === "POST") return complete(req, env, id);
  if (rest[2] === "results" && m === "POST") return results(req, env, id);
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
