// Shared sample observation for unit tests.
export const sampleObs = (overrides = {}) => ({
  url: "http://x/products",
  title: "Products",
  readyState: "complete",
  viewport: { width: 1280, height: 800 },
  scroll: { y: 0, max: 900, atTop: true, atBottom: false },
  headings: [{ level: 1, text: "Products" }],
  text: "Products Blue Widget Red Gadget",
  dialog: null,
  elements: [
    { id: "e1", role: "link", tag: "a", name: "Pricing", href: "/pricing", inViewport: true, top: 10, clickable: true },
    { id: "e2", role: "textbox", tag: "input", name: "Search", inputType: "text", placeholder: "Search products", value: "", inViewport: true, top: 12, editable: true, clickable: false },
    { id: "e3", role: "button", tag: "button", name: "Go", inViewport: true, top: 12, clickable: true },
    { id: "e4", role: "select", tag: "select", name: "Quantity", options: [{ value: "1", label: "1" }, { value: "2", label: "2" }], value: "1", selectedLabel: "1", inViewport: true, top: 40, selectable: true, clickable: true },
    { id: "e5", role: "checkbox", tag: "input", name: "Gift wrap", checked: false, inViewport: false, top: 900, clickable: true },
  ],
  omittedElements: 0,
  ...overrides,
});
