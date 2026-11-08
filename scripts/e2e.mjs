#!/usr/bin/env node
// The whole flow against a local Worker, with a real trunk-pro: review, send (interrupted and
// resumed), the decode job's checks, listing, range requests, promotion, and withdrawing.
//
//   TRP_BIN=…/target/release/trunk-pro TRP_CAPTURE=…/iq-captures/<a capture> npm run test:local

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

const { TRP_BIN: bin, TRP_CAPTURE: capture } = process.env;
if (!bin || !capture) {
  console.log("Set TRP_BIN and TRP_CAPTURE to run the end-to-end test.");
  process.exit(0);
}
const PORT = 18790, TRP_PORT = 18791;
const BASE = `http://127.0.0.1:${PORT}/corpus`, API = `${BASE}/api/v1`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (what, f, seconds = 240) => {
  for (let i = 0; i < seconds * 2; i++) {
    const v = await f().catch(() => null);
    if (v) return v;
    await sleep(500);
  }
  throw new Error(`Timed out waiting for ${what}`);
};

const tmp = mkdtempSync(join(tmpdir(), "corpus-e2e-"));
const name = basename(capture);
mkdirSync(join(tmp, "calls/iq-captures"), { recursive: true });
cpSync(capture, join(tmp, "calls/iq-captures", name), { recursive: true });
writeFileSync(join(tmp, "config.json"), JSON.stringify({ sources: [], recording: { captureDir: join(tmp, "calls") }, systems: [], server: { bind: "127.0.0.1", port: TRP_PORT } }));
execFileSync("npx", ["wrangler", "d1", "migrations", "apply", "corpus", "--local", "--persist-to", join(tmp, "wr")], { stdio: "ignore", input: "y\n" });
const worker = spawn("npx", ["wrangler", "dev", "--port", String(PORT), "--persist-to", join(tmp, "wr"), "--var", `BLOB_URL:${BASE}/blobs/`, "--var", "MANIFEST_URL:http://127.0.0.1:1/none"], { stdio: "ignore", detached: true });
const env = { ...process.env, TRP_CORPUS_API: API };
const serve = () => spawn(bin, ["serve", "--config", join(tmp, "config.json"), "--no-open"], { cwd: tmp, env, stdio: "ignore" });
let trp = serve();
const cleanup = () => {
  trp.kill();
  try { process.kill(-worker.pid); } catch {}
};
process.on("exit", cleanup);

async function connect() {
  await until("the recorder", () => fetch(`http://127.0.0.1:${TRP_PORT}/api/version`).then((r) => r.ok));
  const ws = new WebSocket(`ws://127.0.0.1:${TRP_PORT}/api/ws`);
  let id = 1;
  const waiting = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); }
  };
  await new Promise((r) => (ws.onopen = r));
  return { ws, ask: (m) => new Promise((r) => { const i = id++; waiting.set(i, r); ws.send(JSON.stringify({ ...m, id: i })); }) };
}

await until("the worker", () => fetch(`${API}/submissions`).then((r) => r.ok));
let { ws, ask } = await connect();
const review = await ask({ type: "iqCaptureReview", name });
assert.equal(review.error, undefined);
assert.ok(review.waterfalls.length > 0 && review.diagnostics.host, "the review shows what's sent");
console.log("review ok,", review.waterfalls.length, "waterfalls");

const sending = await ask({ type: "iqCaptureSend", name });
assert.equal(sending.error, undefined, sending.error);
const part = await until("the first parts", async () => {
  const c = (await ask({ type: "iqCaptures" })).captures[0];
  return c.send?.doneBytes > 32 * 2 ** 20 && c.send;
});
console.log("sending:", part.doneBytes, "of", part.totalBytes);
ws.close();
trp.kill();
await sleep(1500);
trp = serve();
({ ws, ask } = await connect());
const sent = await until("the send to finish after a restart", async () => {
  const c = (await ask({ type: "iqCaptures" })).captures[0];
  assert.notEqual(c.send?.state, "failed", c.send?.error);
  return c.send?.state === "sent" && c.send;
});
console.log("sent after an interruption:", sent.id);

assert.equal((await fetch(`${API}/submissions/${sent.id}`)).status, 404, "not public until it's checked");
assert.equal((await (await fetch(`${API}/submissions`)).json()).submissions.length, 0);

// The decode job, as its workflow runs it.
const db = JSON.parse(execFileSync("npx", ["wrangler", "d1", "execute", "corpus", "--local", "--persist-to", join(tmp, "wr"), "--json", "--command", `SELECT results_token FROM submissions WHERE id = '${sent.id}'`], { encoding: "utf8" }));
const token = db[0].results[0].results_token;
const here = new URL(".", import.meta.url).pathname;
writeFileSync(join(tmp, "submission.json"), await (await fetch(`${API}/submissions/${sent.id}`, { headers: { authorization: `Bearer ${token}` } })).text());
mkdirSync(join(tmp, "capture"));
execFileSync("python3", [join(here, "fetch.py"), join(tmp, "submission.json"), join(tmp, "capture")], { stdio: "inherit" });
execFileSync(bin, ["tool", "submission", join(tmp, "capture"), "--out", join(tmp, "out")], { stdio: "ignore" });
execFileSync("python3", [join(here, "report.py"), join(tmp, "out"), `${API}/submissions/${sent.id}`, token], { stdio: "ignore" });
const listed = (await (await fetch(`${API}/submissions`)).json()).submissions;
assert.equal(listed.length, 1);
assert.equal(listed[0].state, "ready");
assert.ok(listed[0].checks.ok);
console.log("checked:", listed[0].checks.messages, "messages,", listed[0].checks.calls, "calls");
assert.equal((await fetch(`${API}/submissions/${sent.id}/waterfall/0`)).status, 200);
assert.match(await (await fetch(BASE)).text(), /IQ Corpus/);

const data = listed[0].files.find((f) => f.name.endsWith(".sigmf-data"));
const range = await fetch(data.url, { headers: { range: "bytes=10-19" } });
assert.equal(range.status, 206, "range requests work");
assert.equal((await range.arrayBuffer()).byteLength, 10);

// Promotion, as the workflow runs it.
mkdirSync(join(tmp, "corpus"));
const corpus = ["--manifest", join(tmp, "corpus/corpus.json"), "--cache", join(tmp, "cache"), "--base", `${BASE}/blobs/`];
execFileSync(bin, ["tool", "corpus", "promote", sent.id, "--api", API, ...corpus], { cwd: tmp, stdio: "ignore" });
const manifest = JSON.parse(readFileSync(join(tmp, "corpus/corpus.json"), "utf8"));
assert.equal(manifest.captures[0].id, `s-${sent.id}`);
assert.ok(existsSync(join(tmp, "corpus/expected", `s-${sent.id}`)), "its first expected output");
const run = execFileSync(bin, ["tool", "corpus", "run", "--out", join(tmp, "after"), ...corpus], { cwd: tmp, encoding: "utf8" });
assert.match(run, /match/);
console.log("promoted and matched:", run.trim());

// Bad uploads.
const auth = { authorization: `Bearer ${(await (await fetch(`${API}/installs`, { method: "POST" })).json()).token}`, "content-type": "application/json" };
const declare = (files) => fetch(`${API}/submissions`, { method: "POST", headers: auth, body: JSON.stringify({ purpose: "healthy", tier: "wideband", files }) });
assert.equal((await declare([{ name: "../evil.sigmf-meta", sha256: "a".repeat(64), bytes: 1 }])).status, 400);
assert.equal((await fetch(`${API}/submissions`, { method: "POST", body: "{}" })).status, 401);
const failing = await (await declare([{ name: "x.sigmf-meta", sha256: "b".repeat(64), bytes: 1 }])).json();
assert.equal((await fetch(`${API}/submissions/${failing.id}/complete`, { method: "POST", headers: auth })).status, 409, "not all of it came");

const gone = await ask({ type: "iqCaptureWithdraw", name });
assert.equal(gone.error, undefined, gone.error);
assert.equal((await fetch(data.url)).status, 404, "withdrawn: the recording is gone");
console.log("withdrawn. All good.");
ws.close();
cleanup();
process.exit(0);
