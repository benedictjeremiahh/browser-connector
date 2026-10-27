import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserController } from "../src/browser";

type TextNode = { isConnected?: boolean; innerText?: string; textContent?: string; contains?: (value: unknown) => boolean };

function installPage(options: {
  main?: TextNode | null;
  body?: TextNode;
  refs?: Record<string, TextNode | null>;
  onQuery?: (selector: string) => void;
} = {}): { controller: BrowserController; executeScript: ReturnType<typeof vi.fn> } {
  const executeScript = vi.fn(async (input: { func: (...args: unknown[]) => unknown; args?: unknown[] }) => [
    { result: input.func(...(input.args ?? [])) }
  ]);
  const documentStub = {
    title: "Generic test page",
    body: options.body ?? { innerText: "body target text", textContent: "body target text" },
    querySelectorAll() { return Object.values(options.refs ?? {}).filter((value): value is TextNode => value !== null); },
    querySelector(selector: string) {
      options.onQuery?.(selector);
      return options.main ?? null;
    }
  };
  const listener = { addListener: vi.fn() };
  vi.stubGlobal("chrome", {
    webNavigation: { onCommitted: listener },
    tabs: { onRemoved: listener },
    debugger: { onEvent: listener, onDetach: listener },
    scripting: { executeScript }
  });
  vi.stubGlobal("document", documentStub);
  vi.stubGlobal("CSS", { escape: (value: string) => value.replaceAll('"', '\\"') });
  const refs = new WeakMap<Element, string>();
  for (const [ref, target] of Object.entries(options.refs ?? {})) if (target) refs.set(target as unknown as Element, ref);
  (globalThis as typeof globalThis & { __browserConnectorPageRefState?: unknown }).__browserConnectorPageRefState = {
    document: documentStub as unknown as Document,
    generation: 1,
    refs,
    next: Object.keys(options.refs ?? {}).length
  };
  return { controller: new BrowserController(), executeScript };
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete (globalThis as typeof globalThis & { __browserConnectorPageRefState?: unknown }).__browserConnectorPageRefState;
});

describe("get_page_text scope references", () => {
  it("reads only the requested subtree and preserves UTF-8 cursor pagination", async () => {
    const target = { isConnected: true, innerText: "A😀B", textContent: "A😀B" };
    const { controller } = installPage({
      main: { isConnected: true, innerText: "outside text" },
      refs: { "p1-2": target }
    });

    const first = await controller.dispatch("get_page_text", { tabId: 7, scopeRef: "p1-2", maxBytes: 5 }, new Set([7]));
    expect(first).toMatchObject({ text: "A😀", originalBytes: 6, truncated: true, nextCursor: "2", scopeRef: "p1-2", staleScopeRef: false, untrusted: true });

    const second = await controller.dispatch("get_page_text", { tabId: 7, scopeRef: "p1-2", cursor: "2", maxBytes: 1 }, new Set([7]));
    expect(second).toMatchObject({ text: "B", originalBytes: 6, truncated: false, nextCursor: null, scopeRef: "p1-2", staleScopeRef: false });
  });

  it("keeps the existing unscoped main/article selection and body fallback", async () => {
    const mainPage = installPage({ main: { innerText: "main text" }, body: { innerText: "body text" } });
    await expect(mainPage.controller.dispatch("get_page_text", { tabId: 7 }, new Set([7])))
      .resolves.toMatchObject({ text: "main text", originalBytes: 9, untrusted: true });

    const bodyPage = installPage({ main: null, body: { innerText: "body fallback" } });
    await expect(bodyPage.controller.dispatch("get_page_text", { tabId: 7 }, new Set([7])))
      .resolves.toMatchObject({ text: "body fallback", originalBytes: 13, untrusted: true });
  });

  it("returns stale scope metadata without reading the page body", async () => {
    const { controller } = installPage({ refs: { "p1-2": null } });
    Object.defineProperty(document, "body", { configurable: true, get() { throw new Error("stale scope must not fall back to body"); } });

    await expect(controller.dispatch("get_page_text", { tabId: 7, scopeRef: "p1-2" }, new Set([7])))
      .resolves.toMatchObject({ text: "", originalBytes: 0, truncated: false, nextCursor: null, scopeRef: "p1-2", staleScopeRef: true, untrusted: true });
  });

  it("resolves scoped text through the issued identity map instead of dataset selectors", async () => {
    let queried = "";
    const scopeRef = 'ref"value';
    const target = { isConnected: true, innerText: "quoted reference target", textContent: "quoted reference target" };
    const { controller } = installPage({ refs: { [scopeRef]: target }, onQuery: selector => { queried = selector; } });
    await expect(controller.dispatch("get_page_text", { tabId: 7, scopeRef }, new Set([7])))
      .resolves.toMatchObject({ text: "quoted reference target", staleScopeRef: false });
    expect(queried).toBe("");
  });
});
