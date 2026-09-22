import test, { before, after } from "node:test";
import { createContext, hasChrome, TEST_MODE } from "../helpers/env.mjs";
import { scenarios, runScenario, observeAndDryRun } from "./scenarios.mjs";

const backend = "chrome";
const available = await hasChrome();
const skip = available ? false : "Chrome not installed";
let ctx;

before(async () => {
  if (available) ctx = await createContext({ backend, headless: true });
});
after(async () => {
  await ctx?.close();
});

test(`${backend} (headless, ${TEST_MODE} Jev): observe + dry-run see the page structure`, { skip }, async () => {
  await observeAndDryRun({ ctx, backend });
});

for (const scenario of scenarios(backend)) {
  test(`${backend} (headless, ${TEST_MODE} Jev): ${scenario.name}`, { skip }, async () => {
    const result = await runScenario({ ctx, backend, scenario });
    await scenario.check(result, ctx);
  });
}
