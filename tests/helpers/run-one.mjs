// Debug helper: run one scenario (by index or name substring) with timestamps.
// usage: node tests/helpers/run-one.mjs <backend> <scenario-substring> [mock|live]
import { createContext } from "./env.mjs";
import { scenarios, runScenario } from "../e2e/scenarios.mjs";

const [backend = "chrome", needle = "pricing"] = process.argv.slice(2);
const ctx = await createContext({ backend, headless: true });
const scenario = scenarios(backend).find((s) => s.name.includes(needle));
if (!scenario) throw new Error(`no scenario matching ${needle}`);
const t0 = Date.now();
const stamp = () => `[+${((Date.now() - t0) / 1000).toFixed(1)}s]`;
const config = { ...ctx.config, ...scenario.config, backend };
const { executeJob } = await import("../../skills/jev-browser/lib/runner.mjs");
const result = await executeJob({ config, job: { mode: "run", ...scenario.job(ctx) }, log: (m) => console.error(stamp(), m) });
console.error(stamp(), "done");
console.log(JSON.stringify({ status: result.status, steps: result.steps, finalUrl: result.finalUrl, elapsedMs: result.elapsedMs, cost: result.usage?.costUsd, reason: result.reason, error: result.error }, null, 2));
try { await scenario.check(result, ctx); console.log("CHECK OK"); } catch (e) { console.log("CHECK FAILED:", e.message); }
await ctx.close();
