import { editingCommand, keyDescriptor, modifierNames, parseModifiers } from "../src/browser";
import { sameNavigationTarget } from "../src/policy";
import { describe, expect, it } from "vitest";

describe("controlled tab reuse", () => {
  it("treats a fragment as a position, not a different page", () => {
    expect(sameNavigationTarget("https://example.com/a#top", "https://example.com/a")).toBe(true);
    expect(sameNavigationTarget("https://example.com/a?x=1", "https://example.com/a?x=1#f")).toBe(true);
  });

  it("refuses to match across a path, a query, or an origin", () => {
    expect(sameNavigationTarget("https://example.com/a", "https://example.com/b")).toBe(false);
    expect(sameNavigationTarget("https://example.com/a?x=1", "https://example.com/a?x=2")).toBe(false);
    expect(sameNavigationTarget("https://example.com/a", "https://other.example/a")).toBe(false);
  });

  it("has no comparable identity for a non-http address", () => {
    expect(sameNavigationTarget("about:blank", "about:blank")).toBe(false);
    expect(sameNavigationTarget("chrome://settings", "chrome://settings")).toBe(false);
    expect(sameNavigationTarget("not a url", "not a url")).toBe(false);
  });
});

describe("key combinations", () => {
  it("maps modifier names to CDP's bitmask", () => {
    expect(parseModifiers(undefined)).toBe(0);
    expect(parseModifiers("")).toBe(0);
    expect(parseModifiers("ctrl+shift")).toBe(10);
    expect(parseModifiers("cmd")).toBe(4);
    expect(parseModifiers("Meta + Alt")).toBe(5);
  });

  it("rejects a modifier it cannot send", () => {
    expect(() => parseModifiers("hyper")).toThrow(/modifier/);
  });

  it("round-trips the mask back to names", () => {
    expect(modifierNames(parseModifiers("cmd+shift"))).toEqual(["meta", "shift"]);
    expect(modifierNames(0)).toEqual([]);
  });

  it("gives a combination a physical code, and a character only its name", () => {
    expect(keyDescriptor("a")).toMatchObject({ code: "KeyA", virtualKeyCode: 65 });
    expect(keyDescriptor("A")).toMatchObject({ code: "KeyA", virtualKeyCode: 65 });
    expect(keyDescriptor("7")).toMatchObject({ code: "Digit7", virtualKeyCode: 55 });
    expect(keyDescriptor("Enter")).toMatchObject({ code: "Enter", virtualKeyCode: 13 });
    expect(keyDescriptor("spAcE")).toMatchObject({ key: " ", code: "Space" });
    expect(keyDescriptor("ArrowDown")).toMatchObject({ code: "ArrowDown", virtualKeyCode: 40 });
    expect(keyDescriptor("F5")).toEqual({ key: "F5" });
  });

  /* macOS resolves an editing command from the native key code. Sending only the
     Windows code produces an event the page receives and then ignores — which is
     exactly how Cmd+A arrived with metaKey true and selected nothing. */
  it("carries the macOS key code that editing commands are resolved from", () => {
    expect(keyDescriptor("a").macVirtualKeyCode).toBe(0);
    expect(keyDescriptor("A").macVirtualKeyCode).toBe(0);
    expect(keyDescriptor("c").macVirtualKeyCode).toBe(8);
    expect(keyDescriptor("v").macVirtualKeyCode).toBe(9);
    expect(keyDescriptor("x").macVirtualKeyCode).toBe(7);
    expect(keyDescriptor("z").macVirtualKeyCode).toBe(6);
    expect(keyDescriptor("7").macVirtualKeyCode).toBe(26);
    expect(keyDescriptor("Enter").macVirtualKeyCode).toBe(36);
    expect(keyDescriptor("ArrowDown").macVirtualKeyCode).toBe(125);
    expect(keyDescriptor("Backspace").macVirtualKeyCode).toBe(51);
  });

  it("has no macOS code for a key it does not know, so the caller can fall back", () => {
    expect(keyDescriptor("F5").macVirtualKeyCode).toBeUndefined();
  });

  /* macOS handles the standard editing shortcuts in the menu bar, so the renderer
     never sees them and an event alone selects nothing. These are the commands
     sent alongside the event, and only for the macOS modifier. */
  it("maps the macOS editing shortcuts to their editor command", () => {
    expect(editingCommand("a", parseModifiers("cmd"))).toBe("SelectAll");
    expect(editingCommand("c", parseModifiers("cmd"))).toBe("Copy");
    expect(editingCommand("v", parseModifiers("cmd"))).toBe("Paste");
    expect(editingCommand("x", parseModifiers("cmd"))).toBe("Cut");
    expect(editingCommand("z", parseModifiers("cmd"))).toBe("Undo");
    expect(editingCommand("z", parseModifiers("cmd+shift"))).toBe("Redo");
  });

  it("does not invent a command for a combination it was not told about", () => {
    /* Ctrl+A selects all on Windows but moves to the line start on macOS. */
    expect(editingCommand("a", parseModifiers("ctrl"))).toBeUndefined();
    expect(editingCommand("a", 0)).toBeUndefined();
    expect(editingCommand("b", parseModifiers("cmd"))).toBeUndefined();
    /* Shift+ArrowLeft is a selection motion the renderer handles itself. */
    expect(editingCommand("ArrowLeft", parseModifiers("shift"))).toBeUndefined();
  });
});
