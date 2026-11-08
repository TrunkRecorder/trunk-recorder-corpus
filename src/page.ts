// The public page: what's been contributed, with no sign-in. Promoting one into the regression
// tests happens on GitHub, by people with write access to the Trunk Recorder Pro repo.

export const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>IQ Corpus</title>
<style>
:root { color-scheme: light dark; --bg: #fff; --text: #16202c; --muted: #5b6978; --line: #d7dee6; --panel: #f4f6f9; --accent: #1a6fd1; }
@media (prefers-color-scheme: dark) { :root { --bg: #0d1420; --text: #e6edf5; --muted: #93a3b5; --line: #263344; --panel: #151f2e; --accent: #5cb0ff; } }
body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.5 system-ui, sans-serif; }
main { max-width: 900px; margin: 0 auto; padding: 24px 16px; }
h1 { font-size: 24px; margin: 0 0 4px; } .muted { color: var(--muted); }
.sub { border: 1px solid var(--line); border-radius: 8px; padding: 14px; margin-top: 14px; background: var(--panel); }
.sub h2 { font-size: 15px; margin: 0; } canvas { width: 100%; height: 150px; image-rendering: pixelated; border-radius: 6px; margin-top: 10px; display: block; }
code, pre { font: 12px ui-monospace, monospace; } pre { white-space: pre-wrap; word-break: break-all; background: var(--bg); padding: 8px; border-radius: 6px; border: 1px solid var(--line); }
a { color: var(--accent); } .tag { font-size: 12px; border: 1px solid var(--line); border-radius: 99px; padding: 1px 8px; margin-right: 4px; }
</style></head><body><main>
<h1>IQ Corpus</h1>
<p class="muted">Radio recordings contributed from Trunk Recorder Pro, for anyone to test their own build or help debug a problem. Download a recording and decode it yourself with <code>trunk-pro replay</code>.</p>
<div id="list" class="muted">Loading…</div>
</main><script>
const API = location.pathname.replace(/\\/$/, "") + "/api/v1";
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const size = (n) => n >= 1e9 ? (n / 1e9).toFixed(2) + " GB" : (n / 1e6).toFixed(1) + " MB";
async function draw(canvas, url) {
  const r = await fetch(url);
  if (!r.ok) return canvas.remove();
  const b = new DataView(await r.arrayBuffer());
  const [w, h] = [b.getUint32(0, true), b.getUint32(4, true)];
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext("2d"), im = ctx.createImageData(w, h);
  for (let i = 0; i < w * h; i++) { const v = b.getUint8(8 + i); im.data.set([v * 0.3, v * 0.7, v, 255], i * 4); }
  ctx.putImageData(im, 0, 0);
}
function row(s) {
  const c = s.checks || {};
  const el = document.createElement("div"); el.className = "sub";
  el.innerHTML = '<h2>' + esc(new Date(s.created_ms).toISOString().slice(0, 16).replace("T", " ")) + ' UTC</h2>' +
    '<p><span class="tag">' + esc(s.tier) + '</span><span class="tag">' + esc(s.protocol) + '</span><span class="tag">' + esc(s.purpose) + '</span>' + size(s.bytes) + (c.seconds ? ' · ' + Math.round(c.seconds) + ' s' : '') + (c.messages !== undefined ? ' · ' + c.messages + ' control messages, ' + c.calls + ' calls decoded' : '') + '</p>' +
    (s.note ? '<p>' + esc(s.note) + '</p>' : '') +
    '<details><summary>Download and replay</summary><pre>' + s.files.map((f) => 'curl -o ' + esc(f.name) + ' ' + esc(f.url)).join("\\n") + '\\ntrunk-pro replay .</pre></details>' +
    '<details><summary>Checks</summary><pre>' + esc(JSON.stringify(c, null, 2)) + '</pre></details>' +
    '<p class="muted">ID <code>' + esc(s.id) + '</code></p>';
  const n = (c.radios || []).length || 1;
  for (let i = 0; i < n; i++) { const cv = document.createElement("canvas"); el.insertBefore(cv, el.children[2]); draw(cv, API + "/submissions/" + s.id + "/waterfall/" + i); }
  return el;
}
fetch(API + "/submissions").then((r) => r.json()).then((d) => {
  const list = document.getElementById("list"); list.textContent = "";
  if (!d.submissions.length) { list.textContent = "Nothing has been contributed yet."; return; }
  list.className = ""; for (const s of d.submissions) list.append(row(s));
}).catch(() => { document.getElementById("list").textContent = "Couldn't load the list."; });
</script></body></html>`;
