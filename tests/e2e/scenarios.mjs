// Shared e2e scenarios, run against each available backend.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { executeJob } from "../../skills/jev-browser/lib/runner.mjs";
import { ARTIFACTS, LIVE } from "../helpers/env.mjs";

export function scenarios(backend) {
  const budget = LIVE ? 0.05 : 1; // live runs are cheap (≈$0.0002 per step) but bounded anyway
  return [
    {
      name: "navigates to the pricing page",
      job: (ctx) => ({ goal: "Open the pricing page", startUrl: ctx.url("/") }),
      config: { maxSteps: 6, budgetUsd: budget },
      check: (result, ctx) => {
        assert.equal(result.status, "success", JSON.stringify(result));
        assert.equal(result.finalUrl, ctx.url("/pricing"));
        assert.ok(result.steps >= 1 && result.steps <= 3, `steps=${result.steps}`);
      },
    },
    {
      name: "searches with a provided input and opens the product page",
      job: (ctx) => ({ goal: 'Search the catalog for "blue widget" and open the Blue Widget product page', startUrl: ctx.url("/"), inputs: { query: "blue widget" } }),
      config: { maxSteps: 8, budgetUsd: budget },
      check: (result, ctx) => {
        assert.equal(result.status, "success", JSON.stringify(result));
        assert.equal(result.finalUrl, ctx.url("/products/blue-widget"));
        assert.ok(ctx.site.events.some((e) => e.path === "/search" && /blue widget/i.test(e.query.q)), "the search form was submitted with the query");
      },
    },
    {
      name: "signs in with an input email and a secret password",
      job: (ctx) => ({ goal: "Sign in to the account and reach the dashboard", startUrl: ctx.url("/login"), inputs: { email: "ada@example.com" }, secrets: { password: "hunter2" } }),
      config: { maxSteps: 8, budgetUsd: budget },
      check: async (result, ctx) => {
        assert.equal(result.status, "success", JSON.stringify(result));
        assert.equal(result.finalUrl, ctx.url("/dashboard"));
        assert.match(result.finalTextExcerpt, /Welcome, ada@example.com/);
        if (ctx.mock) assert.equal(ctx.mock.requests.some((r) => JSON.stringify(r).includes("hunter2")), false, "the password never reached the model");
        const journal = await fs.readFile(path.join(result.journalDir, "steps.jsonl"), "utf8");
        assert.equal(journal.includes("hunter2"), false);
      },
    },
    {
      name: "starts a free trial of the Team plan (multi-step, choosing among similar buttons)",
      job: (ctx) => ({ goal: "Start a free trial of the Team plan", startUrl: ctx.url("/") }),
      config: { maxSteps: 8, budgetUsd: budget },
      check: (result, ctx) => {
        assert.equal(result.status, "success", JSON.stringify(result));
        assert.match(result.finalTitle, /Trial started/);
        assert.match(result.finalTextExcerpt, /Your Team trial has started/);
      },
    },
    {
      name: "adds a product to the cart",
      job: (ctx) => ({ goal: "Add the Red Gadget to the cart", startUrl: ctx.url("/products") }),
      config: { maxSteps: 8, budgetUsd: budget },
      check: (result) => {
        assert.equal(result.status, "success", JSON.stringify(result));
        assert.match(result.finalTextExcerpt, /Added 1 × Red Gadget to your cart/);
      },
    },
    {
      name: "fills a contact form including a dropdown",
      job: (ctx) => ({ goal: "Send a message to the company about a billing problem", startUrl: ctx.url("/contact"), inputs: { name: "Ada Lovelace", email: "ada@example.com", message: "I was charged twice for order 42." } }),
      config: { maxSteps: 12, budgetUsd: budget },
      check: (result) => {
        assert.equal(result.status, "success", JSON.stringify(result));
        assert.match(result.finalTextExcerpt, /Thanks, Ada Lovelace/);
        assert.match(result.finalTextExcerpt, /billing message was received/);
      },
    },
    {
      name: "scrolls to find a button below the fold and reveals hidden text",
      job: (ctx) => ({ goal: "Reveal the secret code on the documentation page", startUrl: ctx.url("/docs") }),
      config: { maxSteps: 8, budgetUsd: budget, observation: { maxCandidates: 100, maxTextChars: 3000, maxHeadings: 12, maxNameChars: 80 } },
      check: (result) => {
        assert.equal(result.status, "success", JSON.stringify(result));
        assert.match(result.finalTextExcerpt, /secret code is 4711/);
      },
    },
    {
      name: "hands off when the page needs the user (restricted area)",
      job: (ctx) => ({ goal: "Open the administrator reports", startUrl: ctx.url("/admin") }),
      config: { maxSteps: 4, budgetUsd: budget },
      check: (result) => {
        assert.ok(["needs_user", "stuck"].includes(result.status), JSON.stringify(result));
        if (result.status === "needs_user") assert.ok(["missing_information", "login_required", "error_page"].includes(result.blocker), result.blocker);
      },
    },
    {
      name: "respects max steps on an impossible goal and reports the final goal probability",
      job: (ctx) => ({ goal: "Purchase a spaceship with cryptocurrency", startUrl: ctx.url("/") }),
      config: { maxSteps: 2, budgetUsd: budget },
      check: (result) => {
        assert.ok(["max_steps", "stuck", "needs_user"].includes(result.status), JSON.stringify(result));
        assert.ok(result.steps <= 2);
        assert.equal(typeof result.usage.costUsd, "number");
      },
    },
  ];
}

export async function runScenario({ ctx, backend, scenario, extra = {} }) {
  const config = { ...ctx.config, ...scenario.config, backend, thresholds: { ...ctx.config.thresholds, ...(scenario.config?.thresholds ?? {}) } };
  const shot = path.join(ARTIFACTS, `${backend}-${scenario.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.png`);
  const job = { mode: "run", ...scenario.job(ctx), screenshotPath: shot, ...extra };
  const logs = [];
  const result = await executeJob({ config, job, log: (m) => logs.push(m) });
  result.logs = logs;
  if (backend === "ego" && result.status === "needs_user" && result.resume?.spaceId) {
    // The hand-off leaves the space with the user; tests reclaim and close it.
    const { closeEgoSpace } = await import("../../skills/jev-browser/lib/backends/ego.mjs");
    result.cleanup = await closeEgoSpace({ spaceId: result.resume.spaceId, config }).catch((error) => ({ closed: false, reason: error.message }));
  }
  return result;
}

export async function observeAndDryRun({ ctx, backend, extra = {} }) {
  const config = { ...ctx.config, backend };
  const observed = await executeJob({ config, job: { mode: "observe", startUrl: ctx.url("/contact"), ...extra }, log: () => {} });
  assert.equal(observed.page.title, "Contact · Widgetry");
  const kinds = observed.page.elements.map((e) => e.description);
  assert.ok(kinds.some((d) => /text field 'Your name'/.test(d)), kinds.join("\n"));
  assert.ok(kinds.some((d) => /dropdown 'Topic'/.test(d)), kinds.join("\n"));
  assert.ok(kinds.some((d) => /button 'Send message'/.test(d)), kinds.join("\n"));
  const dry = await executeJob({ config, job: { mode: "dry-run", goal: "Send a billing message", startUrl: ctx.url("/contact"), inputs: { name: "Ada" }, ...extra }, log: () => {} });
  assert.ok(dry.questions.goal_done && dry.questions.action && dry.questions.type_target && dry.questions.select_target);
  assert.ok(dry.estimatedInputTokens > 200 && dry.estimatedInputTokens < 20_000, `tokens=${dry.estimatedInputTokens}`);
  return { observed, dry };
}
