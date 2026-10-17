import { cursorExpression, pingExpression } from "../src/browser";
import { describe, expect, it } from "vitest";

/* The overlay is a string sent to Runtime.evaluate and showCursor swallows its
   failures, so a syntax error would look like "the cursor never appears" rather
   than like a bug with a stack. Parse it here instead. */
function parses(source: string): boolean {
  try {
    new Function(`return ${source}`);
    return true;
  } catch {
    return false;
  }
}

describe("injected cursor overlay", () => {
  it("is a parseable expression at the coordinates it was given", () => {
    const source = cursorExpression(120, 48, "Click");
    expect(parses(source)).toBe(true);
    expect(source).toContain('"translate(" + 120 + "px, " + 48 + "px)"');
    expect(source).toContain('"Click"');
  });

  it("carries the label through escaping rather than breaking the script", () => {
    const hostile = '").constructor.constructor("alert(1)")()';
    const source = cursorExpression(0, 0, hostile);
    expect(parses(source)).toBe(true);
    expect(source).toContain(JSON.stringify(hostile));
  });

  it("keeps the mark out of the page's accessibility tree and pointer path", () => {
    const source = cursorExpression(0, 0, "Hover");
    expect(source).toContain('"aria-hidden"');
    expect(source).toContain("pointer-events:none");
    expect(source).toContain("attachShadow");
  });

  it("states reduced motion in the overlay's own stylesheet", () => {
    expect(cursorExpression(1, 1, "Move")).toContain("prefers-reduced-motion:reduce");
  });

  /* The chip was positioned by transform and the animation also set transform, so
     the animation won and parked the chip at the viewport origin — invisible in
     any crop around the pointer. Place it with left/top, animate only opacity. */
  it("keeps the label chip's animation away from its positioning transform", () => {
    const source = cursorExpression(10, 20, "Click");
    expect(source).toContain(".label{position:absolute;left:16px;top:-30px");
    const start = source.indexOf("@keyframes bc-label");
    expect(start).toBeGreaterThan(-1);
    expect(source.slice(start, start + 120)).not.toContain("transform");
  });

  it("makes the ripple a parseable expression too", () => {
    expect(parses(pingExpression())).toBe(true);
  });
});
