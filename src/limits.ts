// What a submission may be: checked before anything is stored.

export const PART_BYTES = 32 * 2 ** 20;
export const MAX_SUBMISSION_BYTES = 5 * 10 ** 9;
export const MAX_FILES = 32;
export const SUBMISSIONS_PER_DAY = 20;
export const BYTES_PER_DAY = 20 * 10 ** 9;
export const INSTALLS_PER_IP_PER_DAY = 10;
export const KEEP_DAYS = 90;
export const MAX_WATERFALL_BYTES = 2 * 10 ** 6;

export interface FileIn {
  name: string;
  sha256: string;
  bytes: number;
}

export interface SubmissionIn {
  purpose: string;
  tier: string;
  protocol: string;
  note: string;
  files: FileIn[];
}

const NAME = /^(diagnostics\.json|[A-Za-z0-9][A-Za-z0-9._-]*\.sigmf-(meta|data|collection))$/;
const SHA256 = /^[0-9a-f]{64}$/;

/** A submission as declared, or why it can't be one. */
export function parseSubmission(v: unknown): SubmissionIn | string {
  const o = v as Partial<Record<keyof SubmissionIn, unknown>> | null;
  if (typeof o !== "object" || o === null) return "A submission is a JSON object.";
  const text = (x: unknown, max: number) => (typeof x === "string" ? x.slice(0, max) : "");
  const tier = text(o.tier, 16);
  if (!["wideband", "control", "voice"].includes(tier)) return "Its tier is wideband, control or voice.";
  const purpose = text(o.purpose, 16);
  if (!["healthy", "bug", "rule"].includes(purpose)) return "Its purpose is healthy, bug or rule.";
  if (!Array.isArray(o.files) || o.files.length === 0 || o.files.length > MAX_FILES) return `A submission has 1 to ${MAX_FILES} files.`;
  const files: FileIn[] = [];
  const seen = new Set<string>();
  let total = 0;
  for (const f of o.files as Partial<FileIn>[]) {
    if (typeof f.name !== "string" || !NAME.test(f.name)) return `A file can't be called ${JSON.stringify(f.name)}.`;
    if (seen.has(f.name)) return `Two files are called ${f.name}.`;
    seen.add(f.name);
    if (typeof f.sha256 !== "string" || !SHA256.test(f.sha256)) return `${f.name}: its sha256 isn't one.`;
    if (typeof f.bytes !== "number" || !Number.isSafeInteger(f.bytes) || f.bytes <= 0) return `${f.name}: its size isn't one.`;
    total += f.bytes;
    files.push({ name: f.name, sha256: f.sha256, bytes: f.bytes });
  }
  if (!files.some((f) => f.name.endsWith(".sigmf-meta"))) return "A submission has a .sigmf-meta file.";
  if (total > MAX_SUBMISSION_BYTES) return "A submission is at most 5 GB.";
  return { purpose, tier, protocol: text(o.protocol, 32) || "unknown", note: text(o.note, 200), files };
}

export function partsOf(bytes: number): number {
  return Math.max(1, Math.ceil(bytes / PART_BYTES));
}
