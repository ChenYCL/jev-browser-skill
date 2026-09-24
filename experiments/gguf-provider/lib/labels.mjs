// EXPERIMENTAL — not part of the jev-browser skill.
// Answer-label alphabet for first-token logprob readout.
//
// Mirrors ekzhang/openjev-sglang: labels are A..Z, then AA, AB, ... (bijective base-26),
// because Qwen tokenizes plain integers like "10" as multiple tokens, while the
// letter labels are verified single tokens.

/** 0 -> "A", 25 -> "Z", 26 -> "AA", 27 -> "AB", ... (bijective base-26). */
export function labelForIndex(index) {
  if (!Number.isInteger(index) || index < 0) throw new RangeError("index must be a non-negative integer");
  let n = index + 1;
  let out = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/** Labels for `count` options, in order. */
export function labelsFor(count) {
  if (!Number.isInteger(count) || count < 1) throw new RangeError("count must be >= 1");
  return Array.from({ length: count }, (_, i) => labelForIndex(i));
}

/** Inverse of labelForIndex. */
export function indexForLabel(label) {
  let n = 0;
  for (const ch of label) {
    const v = ch.charCodeAt(0) - 64;
    if (v < 1 || v > 26) throw new RangeError(`not a label: ${label}`);
    n = n * 26 + v;
  }
  return n - 1;
}
