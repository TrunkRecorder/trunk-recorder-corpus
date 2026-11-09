// The public page: what's been contributed, and which of it the regression tests run on. Everything here
// is open to anyone. Signing in with GitHub is optional, and only adds the maintainers' buttons.

export const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>IQ Corpus</title>
<style>
:root { color-scheme: light dark; --bg: #fff; --text: #16202c; --muted: #5b6978; --line: #d7dee6; --panel: #f4f6f9; --accent: #1a6fd1; --ok: #16794a; --warn: #a15c00; }
@media (prefers-color-scheme: dark) { :root { --bg: #0d1420; --text: #e6edf5; --muted: #93a3b5; --line: #263344; --panel: #151f2e; --accent: #5cb0ff; --ok: #4cc38a; --warn: #f0b44c; } }
body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.5 system-ui, sans-serif; }
main { max-width: 900px; margin: 0 auto; padding: 24px 16px; }
header { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; flex-wrap: wrap; }
h1 { font-size: 24px; margin: 0 0 4px; } .muted { color: var(--muted); } .warn { color: var(--warn); }
.tools { display: flex; flex-wrap: wrap; gap: 12px; margin: 16px 0 4px; }
.tools label { display: grid; gap: 2px; font-size: 12px; color: var(--muted); }
select, input[type=number] { font: inherit; color: var(--text); background: var(--panel); border: 1px solid var(--line); border-radius: 6px; padding: 5px 8px; }
button, .button { font: inherit; font-size: 13px; color: var(--text); background: var(--panel); border: 1px solid var(--line); border-radius: 6px; padding: 5px 10px; cursor: pointer; text-decoration: none; display: inline-block; }
button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
.sub { border: 1px solid var(--line); border-radius: 8px; padding: 14px; margin-top: 14px; background: var(--panel); }
.sub h2 { font-size: 15px; margin: 0; } canvas { width: 100%; height: 170px; image-rendering: pixelated; border-radius: 6px; margin-top: 10px; display: block; background: #000; }
code, pre { font: 12px ui-monospace, monospace; } pre { white-space: pre-wrap; word-break: break-all; background: var(--bg); padding: 8px; border-radius: 6px; border: 1px solid var(--line); }
a { color: var(--accent); } .tag { font-size: 12px; border: 1px solid var(--line); border-radius: 99px; padding: 1px 8px; margin-right: 4px; white-space: nowrap; }
.tag.test { border-color: var(--ok); color: var(--ok); } .tag.debug { border-color: var(--warn); color: var(--warn); }
.actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-top: 10px; }
</style></head><body><main>
<header><div><h1>IQ Corpus</h1>
<p class="muted">Radio recordings contributed from Trunk Recorder Pro, for anyone to test their own build or help debug a problem. Download a recording and decode it yourself with <code>trunk-pro replay</code>.</p></div>
<div id="who"></div></header>
<div class="tools">
<label>Show<select id="show"><option value="all">Everything</option><option value="tests">In regression testing</option><option value="review">To review</option><option value="reviewed">Reviewed, not a test</option></select></label>
<label>Recording type<select id="tier"><option value="all">All</option><option value="wideband">Wideband</option><option value="control">Control channel</option><option value="voice">Voice channel</option></select></label>
<label>Diagnostics<select id="diag"><option value="all">Any</option><option value="yes">Attached (debug session)</option><option value="no">None</option></select></label>
<label>Sort by<select id="sort"><option value="new">Newest first</option><option value="old">Oldest first</option><option value="type">Recording type</option></select></label>
</div>
<p id="count" class="muted"></p>
<div id="list" class="muted">Loading…</div>
</main><script>
const API = location.pathname.replace(/\\/$/, "") + "/api/v1";
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const size = (n) => n >= 1e9 ? (n / 1e9).toFixed(2) + " GB" : (n / 1e6).toFixed(1) + " MB";
const $ = (id) => document.getElementById(id);
let all = [], me = { login: null, maintainer: false, can_sign_in: false }, problem = "";

// Black through purple and orange to white, so a signal stands out from the noise around it.
const STOPS = [[0, 0, 0, 4], [0.25, 87, 16, 110], [0.5, 188, 55, 84], [0.75, 249, 142, 9], [1, 252, 255, 164]];
function color(t) {
  let i = 0;
  while (i < STOPS.length - 2 && t > STOPS[i + 1][0]) i++;
  const [a, b] = [STOPS[i], STOPS[i + 1]];
  const f = (t - a[0]) / (b[0] - a[0]);
  return [1, 2, 3].map((k) => a[k] + (b[k] - a[k]) * f);
}
// Which levels to spread over the colours. A channel's picture is mostly its filter's skirts: only what's inside the filter counts.
function range(px, w, h, channel) {
  let values = px;
  if (channel) {
    const mean = new Float64Array(w);
    for (let i = 0; i < w * h; i++) mean[i % w] += px[i];
    const top = Math.max(...mean);
    values = [];
    for (let i = 0; i < w * h; i++) if (mean[i % w] >= top * 0.6) values.push(px[i]);
  }
  const sorted = Uint8Array.from(values).sort();
  const at = (p) => sorted[Math.floor((sorted.length - 1) * p)];
  const low = at(channel ? 0.2 : 0.6), high = Math.max(at(0.999), low + 8);
  return [low, high];
}
async function draw(canvas, url, channel) {
  const r = await fetch(url);
  if (!r.ok) return canvas.remove();
  const b = new Uint8Array(await r.arrayBuffer());
  const d = new DataView(b.buffer);
  const [w, h] = [d.getUint32(0, true), d.getUint32(4, true)];
  const px = b.subarray(8);
  const [low, high] = range(px, w, h, channel);
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext("2d"), im = ctx.createImageData(w, h);
  for (let i = 0; i < w * h; i++) { const c = color(Math.min(1, Math.max(0, (px[i] - low) / (high - low)))); im.data.set([c[0], c[1], c[2], 255], i * 4); }
  ctx.putImageData(im, 0, 0);
}
async function act(path, body) {
  const r = await fetch(API + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) });
  if (!r.ok) { alert((await r.json().catch(() => ({}))).error || "That didn't work."); return; }
  await load();
}
async function drop(s) {
  if (!confirm("Delete this recording from the corpus? This can't be undone.")) return;
  const r = await fetch(API + "/submissions/" + s.id, { method: "DELETE" });
  if (!r.ok) alert((await r.json().catch(() => ({}))).error || "That didn't work.");
  await load();
}
function actions(s) {
  const el = document.createElement("div"); el.className = "actions";
  const button = (text, f, primary) => { const b = document.createElement("button"); b.textContent = text; b.onclick = f; if (primary) b.className = "primary"; el.append(b); return b; };
  if (s.regression) {
    button("Remove from regression testing", () => confirm("Take this off the regression list?") && act("/submissions/" + s.id + "/demote"));
  } else {
    const state = document.createElement("select"); state.setAttribute("aria-label", "Kind of test");
    state.innerHTML = '<option value="active">Should pass</option><option value="known-failing">Known failing (a bug)</option>';
    const issue = document.createElement("input"); issue.type = "number"; issue.min = 1; issue.placeholder = "Issue #"; issue.setAttribute("aria-label", "GitHub issue"); issue.style.width = "6em";
    button("Add to regression testing", () => act("/submissions/" + s.id + "/promote", { state: state.value, issue: issue.value || null }), true);
    el.append(state, issue);
    if (s.reviewed_by) button("Back to review", () => act("/submissions/" + s.id + "/review", { reviewed: false }));
    else button("Reviewed, not a test", () => act("/submissions/" + s.id + "/review", { reviewed: true }));
    button("Delete…", () => drop(s));
  }
  return el;
}
function row(s) {
  const c = s.checks || {};
  const el = document.createElement("div"); el.className = "sub";
  const r = s.regression;
  el.innerHTML = '<h2>' + esc(new Date(s.created_ms).toISOString().slice(0, 16).replace("T", " ")) + ' UTC</h2>' +
    '<p>' + (r ? '<span class="tag test">' + (r.state === "known-failing" ? "Regression test: known failing" : "Regression test") + '</span>' : '') + (s.has_diagnostics ? '<span class="tag debug">Diagnostics</span>' : '') + '<span class="tag">' + esc(s.tier) + '</span><span class="tag">' + esc(s.protocol) + '</span><span class="tag">' + esc(s.purpose) + '</span>' + size(s.bytes) + (c.seconds ? ' · ' + Math.round(c.seconds) + ' s' : '') + (c.messages !== undefined ? ' · ' + c.messages + ' control messages, ' + c.calls + (c.calls === 1 ? ' call' : ' calls') + ' decoded' : '') + '</p>' +
    (s.note ? '<p>' + esc(s.note) + '</p>' : '') +
    (r ? '<p class="muted">Added by ' + esc(r.promoted_by) + (r.issue ? ' for issue <a href="https://github.com/TrunkRecorder/trunk-recorder-pro/issues/' + r.issue + '">#' + r.issue + '</a>' : '') + '</p>' : s.reviewed_by ? '<p class="muted">Reviewed by ' + esc(s.reviewed_by) + '</p>' : '') +
    '<details><summary>Download and replay</summary><pre>' + s.files.map((f) => 'curl -o ' + esc(f.name) + ' ' + esc(f.url)).join("\\n") + '\\ntrunk-pro replay .</pre></details>' +
    '<details><summary>Checks</summary><pre>' + esc(JSON.stringify(c, null, 2)) + '</pre></details>' +
    '<p class="muted">ID <code>' + esc(s.id) + '</code></p>';
  const n = (c.radios || []).length || 1;
  for (let i = 0; i < n; i++) { const cv = document.createElement("canvas"); el.insertBefore(cv, el.children[2]); draw(cv, API + "/submissions/" + s.id + "/waterfall/" + i, s.tier !== "wideband"); }
  if (me.maintainer) el.append(actions(s));
  return el;
}
const ORDER = { wideband: 0, control: 1, voice: 2 };
function render() {
  const [show, tier, diag, sort] = ["show", "tier", "diag", "sort"].map((k) => $(k).value);
  const shown = all.filter((s) => (show === "all" || (show === "tests" && s.regression) || (show === "review" && !s.regression && !s.reviewed_by) || (show === "reviewed" && !s.regression && s.reviewed_by)) && (tier === "all" || s.tier === tier) && (diag === "all" || s.has_diagnostics === (diag === "yes")));
  shown.sort((a, b) => sort === "old" ? a.created_ms - b.created_ms : sort === "type" ? ORDER[a.tier] - ORDER[b.tier] || b.created_ms - a.created_ms : b.created_ms - a.created_ms);
  $("count").textContent = shown.length + " of " + all.length + " recordings";
  const list = $("list"); list.textContent = ""; list.className = "";
  if (!shown.length) { list.className = "muted"; list.textContent = all.length ? "Nothing matches these filters." : "Nothing has been contributed yet."; return; }
  for (const s of shown) list.append(row(s));
}
function who() {
  const el = $("who"); el.textContent = "";
  if (me.login) {
    const name = document.createElement("span"); name.className = "muted"; name.textContent = me.login + (me.maintainer ? " " : " (read-only) ");
    const out = document.createElement("button"); out.textContent = "Sign out";
    out.onclick = async () => { await fetch(location.pathname.replace(/\\/$/, "") + "/auth/logout", { method: "POST" }); await load(); };
    el.append(name, out);
  } else if (me.can_sign_in) {
    const a = document.createElement("a"); a.className = "button"; a.href = location.pathname.replace(/\\/$/, "") + "/auth/login"; a.textContent = "Sign in with GitHub";
    a.title = "Optional. Maintainers can sign in to manage the regression tests."; el.append(a);
  }
}
async function load() {
  try {
    [me, all] = await Promise.all([fetch(API + "/me").then((r) => r.json()), fetch(API + "/submissions").then((r) => r.json()).then((d) => d.submissions)]);
  } catch { $("list").textContent = "Couldn't load the list."; return; }
  who(); render();
}
const hash = new URLSearchParams(location.hash.slice(1));
for (const k of ["show", "tier", "diag", "sort"]) {
  if (hash.get(k) && [...$(k).options].some((o) => o.value === hash.get(k))) $(k).value = hash.get(k);
  $(k).onchange = () => { location.hash = new URLSearchParams(["show", "tier", "diag", "sort"].map((x) => [x, $(x).value])).toString(); render(); };
}
load();
</script></body></html>`;
