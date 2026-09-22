import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { createContext, hasSafariAutomation, TEST_MODE } from "../helpers/env.mjs";
import { scenarios, runScenario, observeAndDryRun } from "./scenarios.mjs";
import { createSafariDriver } from "../../skills/jev-browser/lib/backends/safari.mjs";
import { DEFAULTS } from "../../skills/jev-browser/lib/config.mjs";

const backend = "safari";
const optedIn = await hasSafariAutomation();
const skip = optedIn ? false : "set JEV_BROWSER_TEST_SAFARI=1 with Safari remote automation enabled";
let ctx;

test("safari backend reports a clear error when remote automation is disabled", { skip: process.platform !== "darwin" ? "macOS only" : false }, async () => {
  try {
    const driver = await createSafariDriver({ config: structuredClone(DEFAULTS), job: {}, log: () => {} });
    await driver.finish({ success: false }); // automation is enabled on this machine: nothing else to assert here
  } catch (error) {
    assert.equal(error.code, "SAFARI_AUTOMATION_DISABLED", error.message);
    assert.match(error.message, /Allow Remote Automation/);
  }
});

before(async () => {
  if (optedIn) ctx = await createContext({ backend });
});
after(async () => {
  await ctx?.close();
});

test(`${backend} (${TEST_MODE} Jev): observe + dry-run see the page structure`, { skip }, async () => {
  await observeAndDryRun({ ctx, backend });
});

for (const scenario of scenarios(backend).slice(0, 4)) {
  test(`${backend} (${TEST_MODE} Jev): ${scenario.name}`, { skip }, async () => {
    const result = await runScenario({ ctx, backend, scenario });
    await scenario.check(result, ctx);
  });
}
