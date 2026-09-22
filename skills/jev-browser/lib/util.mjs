// Small shared helpers. No runtime dependencies.
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const sha256 = (value) =>
  createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");

export const nowIso = () => new Date().toISOString();

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const isRecord = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export function expandHome(p, home = os.homedir()) {
  if (!p || typeof p !== "string") return p;
  if (p === "~") return home;
  if (p.startsWith("~/")) return path.join(home, p.slice(2));
  return p;
}

export function truncate(text, max) {
  if (typeof text !== "string") return "";
  const collapsed = text.replace(/[ \t ]+/g, " ").replace(/\s*\n\s*/g, "\n").trim();
  return collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed;
}

/** Parse "key=value" (value may contain "="). */
export function parseKeyValue(raw) {
  const index = raw.indexOf("=");
  if (index <= 0) throw new Error(`Expected key=value, got: ${raw}`);
  return [raw.slice(0, index).trim(), raw.slice(index + 1)];
}

export function deepMerge(base, patch) {
  if (!isRecord(base) || !isRecord(patch)) return patch === undefined ? base : patch;
  const out = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    out[key] = isRecord(value) && isRecord(base[key]) ? deepMerge(base[key], value) : value;
  }
  return out;
}

/** Replace every secret value inside a string or JSON-like structure. */
export function redact(value, secrets = []) {
  const list = secrets.filter((s) => typeof s === "string" && s.length >= 3);
  if (list.length === 0) return value;
  const scrub = (text) => list.reduce((acc, s) => acc.split(s).join("[REDACTED]"), text);
  if (typeof value === "string") return scrub(value);
  if (Array.isArray(value)) return value.map((item) => redact(item, list));
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v, list)]));
  }
  return value;
}

export async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

export async function readJson(file, fallback = undefined) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT" && fallback !== undefined) return fallback;
    throw error;
  }
}

export async function writeJson(file, data, { mode } = {}) {
  await ensureDir(path.dirname(file));
  await fs.writeFile(file, `${JSON.stringify(data, null, 2)}\n`, { mode });
}

/** Append-only JSONL writer with serialized writes. */
export class JsonlWriter {
  #queue = Promise.resolve();
  constructor(file) {
    this.file = file;
  }
  append(row) {
    this.#queue = this.#queue
      .then(() => ensureDir(path.dirname(this.file)))
      .then(() => fs.appendFile(this.file, `${JSON.stringify(row)}\n`));
    return this.#queue;
  }
  flush() {
    return this.#queue;
  }
}

export function looksLikeUrl(value) {
  return typeof value === "string" && /^https?:\/\/\S+$/i.test(value.trim());
}

export function runId() {
  return `${new Date().toISOString().replace(/[:.]/g, "-")}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Ordered [option, probability] pairs, highest first, deterministic tie-break by option name. */
export function rankProbabilities(probabilities = {}) {
  return Object.entries(probabilities)
    .filter(([, p]) => typeof p === "number" && Number.isFinite(p))
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

/** Pull quoted substrings out of a goal sentence: "blue widget", 'x', “y”. */
export function extractQuoted(text) {
  const out = [];
  if (typeof text !== "string") return out;
  const patterns = [/"([^"]{1,200})"/g, /'([^']{1,200})'/g, /“([^”]{1,200})”/g, /「([^」]{1,200})」/g];
  for (const re of patterns) {
    for (const match of text.matchAll(re)) {
      const value = match[1].trim();
      if (value && !out.includes(value)) out.push(value);
    }
  }
  return out;
}
