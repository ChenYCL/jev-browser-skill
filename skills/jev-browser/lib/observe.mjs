// Page perception shared by every backend.
// ENUMERATOR_SOURCE runs inside the page and returns a compact, JSON-serializable
// observation. It tags interactive elements with data-jev-id so a later action can
// address them with the CSS selector [data-jev-id="N"].
import { sha256, truncate } from "./util.mjs";

export const ENUMERATOR_SOURCE = String.raw`
(function jevEnumerate(opts) {
  opts = opts || {};
  var maxCandidates = opts.maxCandidates || 100;
  var maxTextChars = opts.maxTextChars || 3000;
  var maxHeadings = opts.maxHeadings || 12;
  var maxNameChars = opts.maxNameChars || 80;
  var doc = document;
  var win = window;
  var vw = win.innerWidth || doc.documentElement.clientWidth;
  var vh = win.innerHeight || doc.documentElement.clientHeight;

  function clean(text) {
    return (text || "").replace(/\s+/g, " ").trim();
  }
  function clip(text, n) {
    text = clean(text);
    return text.length > n ? text.slice(0, n - 1) + "…" : text;
  }
  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    var style = win.getComputedStyle(el);
    if (!style || style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse") return false;
    if (parseFloat(style.opacity || "1") === 0) return false;
    var rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return false;
    if (rect.bottom < -vh * 2 || rect.top > vh * 4) return false; // far outside; still counted as scrollable content
    return true;
  }
  function roleOf(el) {
    var tag = el.tagName.toLowerCase();
    var role = el.getAttribute("role");
    if (role) return role.toLowerCase();
    if (tag === "a") return el.hasAttribute("href") ? "link" : "text";
    if (tag === "button") return "button";
    if (tag === "select") return "select";
    if (tag === "textarea") return "textbox";
    if (tag === "input") {
      var type = (el.getAttribute("type") || "text").toLowerCase();
      if (type === "submit" || type === "button" || type === "reset" || type === "image") return "button";
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (type === "file") return "file";
      if (type === "hidden") return "hidden";
      return "textbox";
    }
    if (el.isContentEditable) return "textbox";
    if (tag === "summary") return "button";
    if (tag === "option") return "option";
    return "clickable";
  }
  function labelText(el) {
    if (el.id) {
      var lbl = doc.querySelector('label[for="' + CSS.escape(el.id) + '"]');
      if (lbl) return clean(lbl.innerText || lbl.textContent);
    }
    var parentLabel = el.closest("label");
    if (parentLabel) return clean(parentLabel.innerText || parentLabel.textContent).replace(clean(el.value || ""), "").trim();
    return "";
  }
  function nameOf(el, role) {
    var candidates = [
      el.getAttribute("aria-label"),
      (function () {
        var ids = el.getAttribute("aria-labelledby");
        if (!ids) return "";
        return ids.split(/\s+/).map(function (id) { var n = doc.getElementById(id); return n ? (n.innerText || n.textContent) : ""; }).join(" ");
      })(),
      role === "textbox" || role === "select" || role === "checkbox" || role === "radio" || role === "file" ? labelText(el) : "",
      el.tagName.toLowerCase() === "input" && (role === "button") ? el.value : "",
      el.innerText,
      el.textContent,
      el.getAttribute("title"),
      el.getAttribute("placeholder"),
      el.getAttribute("alt"),
      (function () { var img = el.querySelector && el.querySelector("img[alt]"); return img ? img.getAttribute("alt") : ""; })(),
      el.getAttribute("name"),
      el.getAttribute("href"),
    ];
    for (var i = 0; i < candidates.length; i++) {
      var c = clean(candidates[i]);
      if (c) return clip(c, maxNameChars);
    }
    return "";
  }
  var selector = [
    "a[href]", "button", "input", "select", "textarea", "summary", "[role=button]", "[role=link]", "[role=menuitem]",
    "[role=tab]", "[role=option]", "[role=checkbox]", "[role=radio]", "[role=switch]", "[role=combobox]", "[role=textbox]",
    "[contenteditable=true]", "[contenteditable='']", "[onclick]", "[tabindex]:not([tabindex='-1'])", "label[for]"
  ].join(",");

  // Collect from the document and any open shadow roots.
  var nodes = [];
  function collect(root) {
    var list = root.querySelectorAll(selector);
    for (var i = 0; i < list.length; i++) nodes.push(list[i]);
    var all = root.querySelectorAll("*");
    for (var j = 0; j < all.length; j++) if (all[j].shadowRoot) collect(all[j].shadowRoot);
  }
  collect(doc);

  var seen = new Set();
  var elements = [];
  for (var k = 0; k < nodes.length; k++) {
    var el = nodes[k];
    if (seen.has(el)) continue;
    seen.add(el);
    var role = roleOf(el);
    if (role === "hidden" || role === "option") continue;
    if (el.tagName.toLowerCase() === "label" && el.control) continue; // label duplicates its control
    if (el.disabled || el.getAttribute("aria-disabled") === "true") continue;
    if (el.closest("[aria-hidden=true]")) continue;
    if (!isVisible(el)) continue;
    var rect = el.getBoundingClientRect();
    var entry = {
      role: role,
      tag: el.tagName.toLowerCase(),
      name: nameOf(el, role),
      inViewport: rect.bottom > 0 && rect.top < vh && rect.right > 0 && rect.left < vw,
      top: Math.round(rect.top + win.scrollY),
      el: el,
    };
    if (role === "link") {
      var href = el.getAttribute("href") || "";
      entry.href = clip(href, 120);
    }
    if (role === "textbox") {
      entry.editable = true;
      entry.inputType = (el.getAttribute("type") || (el.isContentEditable ? "contenteditable" : el.tagName.toLowerCase())).toLowerCase();
      entry.placeholder = clip(el.getAttribute("placeholder") || "", 60);
      var rawValue = el.isContentEditable ? el.innerText : (el.value || "");
      entry.value = entry.inputType === "password" ? (rawValue ? "(hidden)" : "") : clip(rawValue, 60);
      entry.required = !!el.required;
    }
    if (role === "select") {
      entry.selectable = true;
      entry.options = Array.prototype.slice.call(el.options || [], 0, 50).map(function (o) { return { value: o.value, label: clip(o.label || o.text, 60) }; });
      entry.value = el.value;
    }
    if (role === "checkbox" || role === "radio") {
      entry.checked = !!el.checked || el.getAttribute("aria-checked") === "true";
    }
    entry.clickable = role !== "textbox" || entry.inputType === "contenteditable" ? true : false;
    elements.push(entry);
  }
  // Viewport first, then by document position.
  elements.sort(function (a, b) { return (a.inViewport === b.inViewport ? 0 : a.inViewport ? -1 : 1) || a.top - b.top; });
  var omitted = Math.max(0, elements.length - maxCandidates);
  elements = elements.slice(0, maxCandidates);
  // Clear stale ids, then tag the chosen elements.
  var stale = doc.querySelectorAll("[data-jev-id]");
  for (var s = 0; s < stale.length; s++) stale[s].removeAttribute("data-jev-id");
  var out = [];
  for (var m = 0; m < elements.length; m++) {
    var e = elements[m];
    var id = "e" + (m + 1);
    e.el.setAttribute("data-jev-id", id);
    var copy = {};
    for (var key in e) if (key !== "el") copy[key] = e[key];
    copy.id = id;
    out.push(copy);
  }

  var headings = Array.prototype.slice.call(doc.querySelectorAll("h1,h2,h3"), 0, maxHeadings)
    .filter(isVisible)
    .map(function (h) { return { level: Number(h.tagName[1]), text: clip(h.innerText || h.textContent, 100) }; });
  var bodyText = clip(doc.body ? doc.body.innerText : "", maxTextChars);
  var dialog = doc.querySelector("dialog[open], [role=dialog], [role=alertdialog]");
  var scrollY = win.scrollY || doc.documentElement.scrollTop || 0;
  var maxScroll = Math.max(0, (doc.documentElement.scrollHeight || 0) - vh);
  return {
    url: location.href,
    title: clip(doc.title, 120),
    readyState: doc.readyState,
    viewport: { width: vw, height: vh },
    scroll: { y: Math.round(scrollY), max: Math.round(maxScroll), atTop: scrollY <= 2, atBottom: scrollY >= maxScroll - 2 },
    headings: headings,
    text: bodyText,
    dialog: dialog && isVisible(dialog) ? clip(dialog.innerText || dialog.textContent, 300) : null,
    elements: out,
    omittedElements: omitted,
  };
})
`.trim();

/** Expression string that evaluates to the observation JSON in the page. */
export function enumeratorExpression(opts = {}) {
  return `(${ENUMERATOR_SOURCE})(${JSON.stringify(opts)})`;
}

/** One-line human/model description of an element, used as a Choice option description. */
export function describeElement(el) {
  const name = el.name ? `'${el.name}'` : "(unnamed)";
  switch (el.role) {
    case "link":
      return `link ${name}${el.href ? ` → ${el.href}` : ""}`;
    case "textbox": {
      const bits = [];
      if (el.inputType && !["text", "contenteditable", "textarea"].includes(el.inputType)) bits.push(`type ${el.inputType}`);
      if (el.placeholder) bits.push(`placeholder "${el.placeholder}"`);
      bits.push(el.value ? `current value "${el.value}"` : "empty");
      if (el.required) bits.push("required");
      return `text field ${name} (${bits.join(", ")})`;
    }
    case "select":
      return `dropdown ${name} (options: ${(el.options ?? []).map((o) => o.label || o.value).slice(0, 12).join(" | ")}${el.options?.length > 12 ? " | …" : ""})`;
    case "checkbox":
    case "radio":
      return `${el.role} ${name} (${el.checked ? "checked" : "unchecked"})`;
    case "button":
      return `button ${name}`;
    default:
      return `${el.role} ${name}`;
  }
}

/** Stable fingerprint of an element across observations (ids are per-observation). */
export function elementFingerprint(el) {
  return [el.role, el.name, el.href ?? "", el.placeholder ?? "", el.inputType ?? ""].join("|");
}

/** Hash used for loop / no-change detection. Ignores the scroll position on purpose. */
export function observationHash(obs) {
  return sha256({
    url: obs.url,
    title: obs.title,
    text: obs.text,
    dialog: obs.dialog,
    elements: obs.elements.map((el) => [el.role, el.name, el.href, el.value, el.checked]),
  });
}

/** The `page` object the model sees. Keep it small and named. */
export function pageStateForModel(obs) {
  return {
    url: obs.url,
    title: obs.title,
    headings: obs.headings.map((h) => `${"#".repeat(h.level)} ${h.text}`),
    dialog: obs.dialog,
    scroll_position: obs.scroll.max <= 0 ? "page fits in the viewport" : obs.scroll.atTop ? "at the top; more content below" : obs.scroll.atBottom ? "at the bottom; content above" : "in the middle; content above and below",
    visible_text: truncate(obs.text, 4000),
    elements: obs.elements.map((el) => ({ id: el.id, description: describeElement(el), in_viewport: el.inViewport })),
    omitted_elements: obs.omittedElements,
  };
}

/** Compact summary of an observation for journals and "previous page" state. */
export function summarizeObservation(obs, chars = 500) {
  return { url: obs.url, title: obs.title, text_excerpt: truncate(obs.text, chars), element_count: obs.elements.length };
}
