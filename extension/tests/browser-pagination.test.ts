import { BrowserController, cursorOffset, pageText } from "../src/browser";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => vi.unstubAllGlobals());

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

  it("keeps the first overflowing node available to the next page", async () => {
    const nodes = ["first", "second", "third"].map(innerText => ({
      innerText, tagName: "P", dataset: {},
      getAttribute: () => null,
      getBoundingClientRect: () => ({ width: 20, height: 10 })
    }));
    const listener = { addListener: vi.fn() };
    vi.stubGlobal("chrome", {
      tabs: { onRemoved: listener },
      webNavigation: { onCommitted: listener },
      debugger: { onEvent: listener, onDetach: listener },
      scripting: { executeScript: async (input: { func: (...args: unknown[]) => unknown; args: unknown[] }) => [{ result: input.func(...input.args) }] }
    });
    vi.stubGlobal("document", { title: "Generic page", querySelectorAll: () => nodes });
    vi.stubGlobal("location", { origin: "https://example.test", pathname: "/" });
    vi.stubGlobal("HTMLInputElement", class {});
    const controller = new BrowserController();
    const budget = new TextEncoder().encode(JSON.stringify({ ref: "p1-0", role: "p", name: "first" })).length;
    const first = await controller.dispatch("read_page", { tabId: 7, maxBytes: budget }, new Set([7])) as { nodes: { name: string }[]; nextCursor: string };
    expect(first.nodes.map(node => node.name)).toEqual(["first"]);
    expect(first.nextCursor).toBe("1");
    const rest = await controller.dispatch("read_page", { tabId: 7, cursor: first.nextCursor, maxBytes: 1000 }, new Set([7])) as { nodes: { name: string }[]; nextCursor: null };
    expect(rest.nodes.map(node => node.name)).toEqual(["second", "third"]);
    expect(rest.nextCursor).toBeNull();
  });
});
