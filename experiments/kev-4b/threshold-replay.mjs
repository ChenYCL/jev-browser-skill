#!/usr/bin/env node
// Score a threshold-replay run (see threshold-replay.sh) the way docs/local-backend-run-smoke.md §9 does.
//
//   node experiments/kev-4b/threshold-replay.mjs /tmp/kev-threshold
//
// Reads every run's journal steps.jsonl, prints one row per step (the reading, the page it was taken
// on, the action chosen), and — when <out>/labels.json says which pages actually satisfied their goal
// — reports the usable band and which values of thresholds.goalDone separate the two sides.
//
// labels.json: { "R1": { "1": "met" }, "R4": { "2": "not", "3": "met" }, ... }
// Ground truth is "the page itself already satisfied the goal", read off url/title/visible text —
// the same rule as §9.1: a trigger on a not-met page is a false success (the run stops before acting,
// so the goal is never reached), a run with a met page that never triggers is a false stuck.
import fs from "node:fs";
import path from "node:path";

const OUT = process.argv[2] ?? "/tmp/kev-threshold";
const LABELS = fs.existsSync(path.join(OUT, "labels.json")) ? JSON.parse(fs.readFileSync(path.join(OUT, "labels.json"), "utf8")) : null;

/** steps.jsonl for one run: the newest journal dir under <out>/journal/<name>. */
function steps(run) {
  const dir = path.join(OUT, "journal", run);
  if (!fs.existsSync(dir)) return [];
  const journals = fs
    .readdirSync(dir)
    .map((entry) => path.join(dir, entry, "steps.jsonl"))
    .filter((file) => fs.existsSync(file))
    .sort();
  if (!journals.length) return [];
  const rows = fs
    .readFileSync(journals[journals.length - 1], "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const runJson = path.join(path.dirname(journals[journals.length - 1]), "run.json");
  const meta = fs.existsSync(runJson) ? JSON.parse(fs.readFileSync(runJson, "utf8")) : {};
  return rows.map((row) => ({ ...row, runStatus: meta.status, screenshots: fs.existsSync(path.join(OUT, "shots", run)) ? path.join(OUT, "shots", run) : null }));
}

const runs = fs.existsSync(path.join(OUT, "journal")) ? fs.readdirSync(path.join(OUT, "journal")).sort() : [];
const table = [];
for (const run of runs) {
  for (const row of steps(run)) {
    table.push({
      run,
      step: row.step,
      reading: row.goalDone,
      url: row.url,
      title: row.title,
      chosen: row.chosen?.action ? `${row.chosen.action} ${row.chosen.target ?? ""}`.trim() : (row.chosen?.stop ? "stop" : "?"),
      changed: row.changed,
    });
  }
}

const width = (list, key) => Math.max(...list.map((row) => String(row[key] ?? "").length), key.length);
const w = { run: width(table, "run"), url: Math.min(width(table, "url"), 46), title: Math.min(width(table, "title"), 34), chosen: width(table, "chosen") };
let lastRun = null;
for (const row of table) {
  if (lastRun !== row.run) {
    console.log(`\n${row.run} (${steps(row.run)[0]?.runStatus ?? "?"})`);
    lastRun = row.run;
  }
  const label = LABELS?.[row.run]?.[String(row.step)] ?? "";
  const title = String(row.title ?? "");
  const url = String(row.url ?? "");
  console.log(
    `  s${row.step}  goal_done=${Number(row.reading).toFixed(3)}  ${label.padEnd(4)}` +
      `  ${String(row.chosen).padEnd(w.chosen)}  changed=${row.changed ? "y" : "n"}` +
      `  ${title.slice(0, w.title).padEnd(w.title)}  ${url.slice(0, w.url)}`,
  );
}

if (!LABELS) {
  console.log(`\nno labels.json in ${OUT} — add per-(run, step) met/not labels to score the band`);
  process.exit(0);
}

const met = table.filter((row) => LABELS[row.run]?.[String(row.step)] === "met");
const notMet = table.filter((row) => LABELS[row.run]?.[String(row.step)] === "not");
const lowestMet = met.length ? Math.min(...met.map((row) => row.reading)) : null;
const worstNotMet = notMet.length ? Math.max(...notMet.map((row) => row.reading)) : null;
console.log(`\nsteps labelled: ${met.length} met, ${notMet.length} not-met (${table.length} readings from ${runs.length} runs)`);
console.log(`lowest met reading:     ${lowestMet?.toFixed(3)}`);
console.log(`worst not-met reading:  ${worstNotMet?.toFixed(3)}`);
if (lowestMet === null || worstNotMet === null) {
  console.log(`one side is empty — no band to report (that is itself the finding)`);
} else if (worstNotMet < lowestMet) {
  const geo = Math.sqrt(worstNotMet * lowestMet);
  console.log(`band: (${worstNotMet.toFixed(3)}, ${lowestMet.toFixed(3)}]  — any value in it separates the two sides`);
  console.log(`geometric midpoint (the rule §9 used): ${geo.toFixed(3)}`);
  console.log(`current loopback default 0.174 does ${0.174 > worstNotMet && 0.174 <= lowestMet ? "" : "NOT "}separate them`);
} else {
  console.log(`NO separating value: the worst not-met reading is at or above the lowest met reading`);
}

// §9.2 scoring for a set of candidate thresholds.
const candidates = [0.1, 0.174, 0.25, 0.3, 0.4, 0.5, 0.7, 0.85, ...(worstNotMet !== null && lowestMet !== null ? [Number(Math.sqrt(worstNotMet * lowestMet).toFixed(3))] : [])];
const byRun = {};
for (const row of table) (byRun[row.run] ??= []).push(row);
console.log(`\nthreshold  correct_success  false_success  false_stuck  correct_stuck   (first trigger per run)`);
for (const value of [...new Set(candidates)].sort((a, b) => a - b)) {
  let correct = 0;
  let falseSuccess = 0;
  let falseStuck = 0;
  let correctStuck = 0;
  const triggers = [];
  for (const [run, list] of Object.entries(byRun)) {
    const hit = list.find((row) => row.reading >= value);
    const hasMet = list.some((row) => LABELS[run]?.[String(row.step)] === "met");
    if (hit) {
      const isMet = LABELS[run]?.[String(hit.step)] === "met";
      triggers.push(`${run}:${hit.step}${isMet ? "" : "!"}`);
      if (isMet) correct += 1;
      else falseSuccess += 1;
    } else {
      triggers.push(`${run}:-`);
      if (hasMet) falseStuck += 1;
      else correctStuck += 1;
    }
  }
  console.log(
    `${String(value).padEnd(10)} ${String(correct).padStart(15)} ${String(falseSuccess).padStart(14)} ${String(falseStuck).padStart(12)} ${String(correctStuck).padStart(14)}   ${triggers.join(" ")}`,
  );
}
