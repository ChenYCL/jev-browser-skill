import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { BIN, createContext, hasChrome } from "../helpers/env.mjs";

const run = promisify(execFile);
const available = await hasChrome();

test("CLI: run / observe / judge / pick / doctor / config round-trip (chrome headless)", { skip: available ? false : "Chrome not installed" }, async (t) => {
  const ctx = await createContext({ backend: "chrome", headless: true });
  t.after(() => ctx.close());
  const env = { ...ctx.env, HOME: ctx.home, JEV_BROWSER_CONFIG: `${ctx.home}/project.json` };
  const { writeFile } = await import("node:fs/promises");
  await writeFile(env.JEV_BROWSER_CONFIG, JSON.stringify({ chrome: { userDataDir: `${ctx.home}/profile`, keepOnSuccess: false, headless: true }, settleMs: 250 }));

  const observe = await run(process.execPath, [BIN, "observe", "--url", ctx.url("/pricing"), "--json"], { env });
  const page = JSON.parse(observe.stdout);
  assert.equal(page.title, "Pricing · Widgetry");
  assert.equal(page.elements.filter((e) => /Start free trial/.test(e.description)).length, 3);

  const dry = await run(process.execPath, [BIN, "run", "--dry-run", "--goal", "Open pricing", "--url", ctx.url("/"), "--json", "-q"], { env });
  assert.ok(JSON.parse(dry.stdout).questions.goal_done);

  const result = await run(process.execPath, [BIN, "run", "--goal", "Open the pricing page", "--url", ctx.url("/"), "--max-steps", "5", "--json", "-q", "--no-keep"], { env }).catch((e) => e);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.status, "success", result.stderr);
  assert.equal(parsed.finalUrl, ctx.url("/pricing"));

  const judge = await run(process.execPath, [BIN, "judge", "--state", "Refund please", "--questions", JSON.stringify({ urgent: { type: "noul", instructions: "Is it urgent?" } })], { env });
  assert.equal(JSON.parse(judge.stdout).answers.urgent.type, "noul");

  const pick = await run(process.execPath, [BIN, "pick", "--question", "Which link shows prices?", "--candidate", "pricing=link 'Pricing'", "--candidate", "docs=link 'Docs'"], { env });
  assert.ok(JSON.parse(pick.stdout).ranked.length >= 2);

  const doctor = await run(process.execPath, [BIN, "doctor", "--json", "--offline"], { env }).catch((e) => e);
  const report = JSON.parse(doctor.stdout);
  assert.ok(report.checks.some((c) => c.name === "chrome" && c.status === "ok"));

  await run(process.execPath, [BIN, "config", "set", "thresholds.goalDone", "0.9", "--home", ctx.home], { env });
  const show = await run(process.execPath, [BIN, "config", "show", "--home", ctx.home], { env });
  assert.equal(JSON.parse(show.stdout).config.thresholds.goalDone, 0.9);
  const missing = await run(process.execPath, [BIN, "run", "--goal", "x"], { env }).catch((e) => e);
  assert.match(missing.stderr, /--url is required/);
});
