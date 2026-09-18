import { cursorOffset, pageText } from "../src/browser";
import { describe, expect, it } from "vitest";

describe("browser observation pagination", () => {
  it("pages UTF-8 text without splitting a code point", () => {
    const first = pageText("a😀bc", 0, 5);
    expect(first).toMatchObject({ text: "a😀", truncated: true, nextCursor: "2" });

    const second = pageText("a😀bc", cursorOffset(first.nextCursor), 5);
    expect(second).toMatchObject({ text: "bc", truncated: false, nextCursor: null });
  });

  it("rejects malformed and unsafe cursors", () => {
    expect(() => cursorOffset("-1")).toThrow(/Cursor/);
    expect(() => cursorOffset("999999999999999999999999")).toThrow(/range/);
  });
});
