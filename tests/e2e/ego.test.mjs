import test, { before, after } from "node:test";
import { createContext, hasEgo, TEST_MODE } from "../helpers/env.mjs";
import { scenarios, runScenario, observeAndDryRun } from "./scenarios.mjs";

const backend = "ego";
const available = await hasEgo();
const skip = available ? false : "ego-browser CLI not installed";
let ctx;

before(async () => {
  if (available) ctx = await createContext({ backend });
});
after(async () => {
  await ctx?.close();
});

test(`${backend} lite (${TEST_MODE} Jev): observe + dry-run see the page structure`, { skip }, async () => {
  await observeAndDryRun({ ctx, backend });
});

for (const scenario of scenarios(backend)) {
  test(`${backend} lite (${TEST_MODE} Jev): ${scenario.name}`, { skip }, async () => {
    const result = await runScenario({ ctx, backend, scenario });
    await scenario.check(result, ctx);
  });
}

test(`${backend} lite (${TEST_MODE} Jev): hand-off then resume the same task space with --space-id`, { skip }, async () => {
  const assert = (await import("node:assert/strict")).default;
  const { executeJob } = await import("../../skills/jev-browser/lib/runner.mjs");
  const { closeEgoSpace } = await import("../../skills/jev-browser/lib/backends/ego.mjs");
  const config = { ...ctx.config, backend, maxSteps: 4 };
  const first = await executeJob({ config, job: { mode: "run", goal: "Open the administrator reports", startUrl: ctx.url("/admin") }, log: () => {} });
  assert.equal(first.status, "needs_user", JSON.stringify(first));
  assert.ok(first.resume?.spaceId, "hand-off reports the space id");
  try {
    // "The user" resolves nothing here; the agent resumes with a reachable goal from the same page.
    const second = await executeJob({ config, job: { mode: "run", goal: "Open the home page", spaceId: first.resume.spaceId }, log: () => {} });
    assert.equal(second.status, "success", JSON.stringify(second));
    assert.equal(second.finalUrl, ctx.url("/"));
    assert.equal(second.resume.spaceId, first.resume.spaceId);
  } finally {
    await closeEgoSpace({ spaceId: first.resume.spaceId, config }).catch(() => {});
  }
});
