// ARIA 1.2 comboboxes are text fields, but `role="combobox"` may sit on the <input> itself
// (DuckDuckGo) or on a wrapper element (Wikipedia). Both must stay typeable — before this was
// fixed the input was observed as a plain `combobox`, `type` vanished from allowedActions and
// the type_target / type_value / submit_after_type questions were never generated.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { createContext, hasChrome } from "../helpers/env.mjs";
import { executeJob } from "../../skills/jev-browser/lib/runner.mjs";

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

/** Ids of the offered elements whose model-facing description matches. */
const idsMatching = (state, re) => state.page.elements.filter((e) => re.test(e.description)).map((e) => e.id);

test(`${backend} (headless): an input carrying role=combobox is typeable`, { skip }, async () => {
  const config = { ...ctx.config, backend };
  const dry = await executeJob({
    config,
    job: { mode: "dry-run", goal: "Search for the widget documentation", startUrl: ctx.url("/combobox"), inputs: { query: "widgets" } },
    log: () => {},
  });
  const { state, questions, meta } = dry;

  // DuckDuckGo markup: role="combobox" on the input itself.
  const ddg = idsMatching(state, /^text field 'Search with DuckDuckGo'/);
  assert.equal(ddg.length, 1, state.page.elements.map((e) => e.description).join("\n"));
  assert.match(state.page.elements.find((e) => e.id === ddg[0]).description, /placeholder "Search the web without being tracked", empty/);

  // Wikipedia markup: role="combobox" on the wrapper, a plain <input> inside it.
  const wiki = idsMatching(state, /^text field 'Search Wikipedia'/);
  assert.equal(wiki.length, 1, state.page.elements.map((e) => e.description).join("\n"));

  // The fixture site's own header field and a plain input are typeable as before.
  const header = idsMatching(state, /^text field 'Search' \(.*placeholder "Search products"/);
  assert.equal(header.length, 1, state.page.elements.map((e) => e.description).join("\n"));
  const plain = idsMatching(state, /^text field 'Plain field'/);
  assert.equal(plain.length, 1, state.page.elements.map((e) => e.description).join("\n"));

  // A combobox-role element with no field inside is offered, but is not something to type into.
  const notAField = idsMatching(state, /^combobox 'Recent searches'/);
  assert.equal(notAField.length, 1, state.page.elements.map((e) => e.description).join("\n"));

  assert.ok(meta.allowedActions.includes("type"), `allowedActions=${meta.allowedActions.join(",")}`);
  for (const id of [...ddg, ...wiki, ...header, ...plain]) assert.ok(meta.editableIds.includes(id), `${id} is editable`);
  assert.equal(meta.editableIds.includes(notAField[0]), false, "the combobox div is not editable");

  const criteria = Object.keys(questions.type_target.criteria);
  for (const id of [...ddg, ...wiki, ...header, ...plain]) assert.ok(criteria.includes(id), `${id} is offered to type_target`);
  assert.equal(criteria.includes(notAField[0]), false, "the combobox div is not offered to type_target");
  assert.ok(questions.type_value && questions.submit_after_type, `questions=${Object.keys(questions).join(",")}`);
  assert.ok(Object.keys(questions.click_target.criteria).includes(notAField[0]), "the combobox div is still offered as a click target");
});
