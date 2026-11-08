import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_SUBMISSION_BYTES, parseSubmission, PART_BYTES, partsOf } from "../src/limits.ts";

const sha = "a".repeat(64);
const good = { purpose: "healthy", tier: "wideband", protocol: "p25", note: "x", files: [{ name: "source-0.sigmf-meta", sha256: sha, bytes: 10 }, { name: "source-0.sigmf-data", sha256: sha.replace("a", "b"), bytes: 20 }, { name: "diagnostics.json", sha256: sha.replace("a", "c"), bytes: 5 }] };

test("A good submission is read", () => {
  const s = parseSubmission(good);
  assert.notEqual(typeof s, "string");
  assert.equal((s as { files: unknown[] }).files.length, 3);
});

test("A bad one says why", () => {
  const bad = (change: object, why: RegExp) => assert.match(String(parseSubmission({ ...good, ...change })), why);
  bad({ tier: "x" }, /tier/);
  bad({ purpose: "x" }, /purpose/);
  bad({ files: [] }, /files/);
  bad({ files: [{ name: "../evil.sigmf-meta", sha256: sha, bytes: 1 }] }, /called/);
  bad({ files: [{ name: "evil.exe", sha256: sha, bytes: 1 }] }, /called/);
  bad({ files: [{ name: "a.sigmf-meta", sha256: "zz", bytes: 1 }] }, /sha256/);
  bad({ files: [{ name: "a.sigmf-meta", sha256: sha, bytes: 0 }] }, /size/);
  bad({ files: [{ name: "a.sigmf-data", sha256: sha, bytes: 1 }] }, /sigmf-meta/);
  bad({ files: [{ name: "a.sigmf-meta", sha256: sha, bytes: MAX_SUBMISSION_BYTES + 1 }] }, /5 GB/);
  bad({ files: [good.files[0], good.files[0]] }, /Two files/);
  assert.match(String(parseSubmission(null)), /JSON/);
});

test("Parts", () => {
  assert.equal(partsOf(1), 1);
  assert.equal(partsOf(PART_BYTES), 1);
  assert.equal(partsOf(PART_BYTES + 1), 2);
});
