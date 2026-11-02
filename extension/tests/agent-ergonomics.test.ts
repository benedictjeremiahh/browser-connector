import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserController, ERROR_HINTS, normalizeError } from "../src/browser";

/* A minimal page: elements with boxes, roles and attributes, enough for the injected functions. */
class FakeElement {
  readonly dataset: Record<string, string> = {};
  readonly attributes = new Map<string, string>();
  isConnected = true;
  disabled = false;
  rect = { left: 0, top: 0, right: 100, bottom: 20, width: 100, height: 20 };
  constructor(readonly innerText: string, readonly tagName = "DIV", attributes: Record<string, string> = {}) {
    for (const [key, value] of Object.entries(attributes)) this.attributes.set(key, value);
  }
  getAttribute(name: string): string | null { return this.attributes.get(name) ?? null; }
  getBoundingClientRect() { return this.rect; }
  scrollIntoView(): void {}
  dispatchEvent(): boolean { return true; }
  closest(): null { return null; }
  contains(element: unknown): boolean { return element === this; }
  matches(): boolean { return false; }
}

/* A field whose own value property ignores writes, like a framework-controlled input; only the
   prototype setter (what typing goes through) changes it. */
class FakeInputBase extends FakeElement {
  stored = "";
  type = "text"; name = ""; id = ""; autocomplete = "";
  constructor(text = "") { super(text, "INPUT"); }
}
Object.defineProperty(FakeInputBase.prototype, "value", { get(this: FakeInputBase) { return this.stored; }, set(this: FakeInputBase, next: string) { this.stored = next; }, configurable: true });
class ControlledInput extends FakeInputBase {
  constructor() { super(); Object.defineProperty(this, "value", { get: () => this.stored, set: () => { /* ignored */ }, configurable: true }); }
}
class RejectingInput extends FakeInputBase {
  constructor() { super(); Object.defineProperty(this, "value", { get: () => "", set: () => {}, configurable: true }); }
}
Object.defineProperty(RejectingInput.prototype, "value", { get: () => "", set: () => {}, configurable: true });

function page(elements: FakeElement[], hit?: FakeElement) {
  const document = {
    title: "Fixture", body: { innerText: "Tersimpan" }, activeElement: null, documentElement: {},
    /* Enough of selector matching for the reads: tag names and [role] in a comma list. */
    querySelectorAll: (selector: string) => selector === "*" || selector === "body *" ? elements : elements.filter(element => selector.split(",").some(part => {
      const trimmed = part.trim();
      if (trimmed === "[role]") return element.getAttribute("role") !== null;
      return /^[a-z0-9]+$/.test(trimmed) && element.tagName.toLowerCase() === trimmed;
    })),
    querySelector: () => null,
    elementFromPoint: () => hit ?? elements[0]
  };
  return document;
}

function harness(elements: FakeElement[], options: { hit?: FakeElement } = {}) {
  const listeners = { addListener: vi.fn() };
  const debuggerEvents: Array<(source: { tabId?: number }, method: string, params?: object) => void> = [];
  const commands: Array<{ method: string; params?: Record<string, unknown> }> = [];
  const tab = { id: 7, windowId: 9, url: "http://localhost:5180/a", title: "Fixture", status: "complete" };
  vi.stubGlobal("chrome", {
    tabs: { onRemoved: listeners, onUpdated: listeners, get: vi.fn(async () => ({ ...tab })), query: vi.fn(async () => [{ id: 7, windowId: 9 }]) },
    webNavigation: { onCommitted: listeners },
    debugger: {
      onEvent: { addListener: (handler: (typeof debuggerEvents)[number]) => debuggerEvents.push(handler) },
      onDetach: listeners,
      attach: async () => {},
      sendCommand: async (_target: unknown, method: string, params?: Record<string, unknown>) => {
        commands.push({ method, params });
        if (method === "Page.getLayoutMetrics") return { cssVisualViewport: { pageX: 0, pageY: 0, clientWidth: 2400, clientHeight: 1200 } };
        if (method === "Input.dispatchMouseEvent" && params?.type === "mousePressed") {
          for (const handler of debuggerEvents) {
            handler({ tabId: 7 }, "Runtime.exceptionThrown", { timestamp: 1, exceptionDetails: { text: "TypeError: cannot read shipment" } });
            handler({ tabId: 7 }, "Network.requestWillBeSent", { requestId: "r1", request: { method: "POST", url: "http://localhost:3021/shipments?token=abc" } });
            handler({ tabId: 7 }, "Network.responseReceived", { requestId: "r1", response: { status: 409 } });
            handler({ tabId: 7 }, "Network.loadingFinished", { requestId: "r1" });
          }
        }
        return {};
      }
    },
    scripting: { executeScript: async (input: { func: (...args: unknown[]) => unknown; args?: unknown[] }) => [{ result: await input.func(...(input.args ?? [])) }] }
  });
  vi.stubGlobal("document", page(elements, options.hit));
  vi.stubGlobal("location", { origin: "http://localhost:5180", pathname: "/a", href: "http://localhost:5180/a" });
  vi.stubGlobal("innerWidth", 1200); vi.stubGlobal("innerHeight", 800);
  vi.stubGlobal("getComputedStyle", () => ({ visibility: "visible" }));
  vi.stubGlobal("MutationObserver", class { observe() {} });
  vi.stubGlobal("HTMLElement", FakeElement);
  vi.stubGlobal("HTMLInputElement", FakeInputBase);
  vi.stubGlobal("HTMLButtonElement", class {});
  vi.stubGlobal("HTMLTextAreaElement", class {});
  vi.stubGlobal("HTMLSelectElement", class {});
  vi.stubGlobal("HTMLAnchorElement", class {});
  return { controller: new BrowserController(), commands, tab };
}

async function refs(controller: BrowserController, filter?: string) {
  return await controller.dispatch("read_page", { tabId: 7, ...(filter ? { filter } : {}) }, new Set([7])) as { nodes: Array<Record<string, unknown>> };
}

afterEach(() => { vi.unstubAllGlobals(); delete (globalThis as { __browserConnectorPageRefState?: unknown; __browserConnectorMutations?: unknown }).__browserConnectorPageRefState; delete (globalThis as { __browserConnectorMutations?: unknown }).__browserConnectorMutations; });

describe("agent ergonomics", () => {
  it("a click reports what it caused: console errors and failed requests, redacted, once the page settles", async () => {
    const button = new FakeElement("Simpan", "BUTTON");
    const h = harness([button]);
    const [node] = (await refs(h.controller)).nodes;
    await h.controller.dispatch("tabs_context", {}, new Set([7])).catch(() => undefined);
    await h.controller.dispatch("computer", { tabId: 7, action: "screenshot" }, new Set([7]));
    const result = await h.controller.dispatch("computer", { tabId: 7, action: "click", pageRef: node!.ref }, new Set([7])) as { after: Record<string, unknown> };
    expect(result.after).toMatchObject({ settled: true, urlChanged: false, consoleErrors: ["TypeError: cannot read shipment"] });
    expect(result.after.failedRequests).toEqual([{ method: "POST", url: "http://localhost:3021/shipments?token=%5Bredacted%5D", status: 409 }]);
  });

  it("a click on a covered element fails with the covering element named and a next step", async () => {
    const target = new FakeElement("Kiriman", "DIV", { role: "tab" });
    const overlay = new FakeElement("Memuat data", "DIV", { role: "dialog" });
    const h = harness([target], { hit: overlay });
    const [node] = (await refs(h.controller)).nodes;
    const failure = await h.controller.dispatch("computer", { tabId: 7, action: "click", pageRef: node!.ref }, new Set([7])).catch(error => normalizeError(error));
    expect(failure).toMatchObject({ code: "click_intercepted", hint: ERROR_HINTS.click_intercepted });
    expect(String((failure as { message: string }).message)).toContain('dialog "Memuat data"');
  });

  it("a disabled control is refused before any click is dispatched", async () => {
    const button = new FakeElement("Kirim", "BUTTON");
    button.disabled = true;
    const h = harness([button]);
    const [node] = (await refs(h.controller)).nodes;
    await expect(h.controller.dispatch("computer", { tabId: 7, action: "click", pageRef: node!.ref }, new Set([7]))).rejects.toMatchObject({ code: "element_disabled" });
    expect(h.commands.some(command => command.method === "Input.dispatchMouseEvent")).toBe(false);
  });

  it("form_input writes through the native setter that framework-controlled fields honour, and reports a value that did not stick", async () => {
    const controlled = new ControlledInput();
    const rejecting = new RejectingInput();
    const h = harness([controlled, rejecting]);
    const [first, second] = (await refs(h.controller)).nodes;
    await expect(h.controller.dispatch("form_input", { tabId: 7, pageRef: first!.ref, value: "admin@example.test", settle: false }, new Set([7])))
      .resolves.toMatchObject({ matched: true, actual: "admin@example.test" });
    // (the read-back goes through the instance getter, which reports the stored value)
    expect(controlled.stored).toBe("admin@example.test");
    await expect(h.controller.dispatch("form_input", { tabId: 7, pageRef: second!.ref, value: "x", settle: false }, new Set([7])))
      .resolves.toMatchObject({ matched: false, hint: ERROR_HINTS.value_not_applied });
  });

  it("read_page by default keeps controls and their state, and drops prose", async () => {
    const tab = new FakeElement("Kiriman", "DIV", { role: "tab", "aria-selected": "true" });
    const prose = new FakeElement("Paragraf panjang", "P");
    const wrapper = new FakeElement("Semua isi", "DIV", { role: "presentation" });
    const h = harness([tab, prose, wrapper]);
    const nodes = (await refs(h.controller)).nodes;
    expect(nodes).toEqual([expect.objectContaining({ role: "tab", name: "Kiriman", selected: true })]);
    expect((await refs(h.controller, "all")).nodes.map(node => node.role)).toEqual(["tab", "p", "presentation"]);
  });

  it("wait_for returns when the text shows, and a timeout says what is still missing and where the tab is", async () => {
    const h = harness([]);
    await expect(h.controller.dispatch("wait_for", { tabId: 7, text: "Tersimpan" }, new Set([7]))).resolves.toMatchObject({ met: true });
    const failure = await h.controller.dispatch("wait_for", { tabId: 7, text: "Gagal", timeoutMs: 300 }, new Set([7])).catch(error => normalizeError(error));
    expect(failure).toMatchObject({ code: "wait_timeout", hint: ERROR_HINTS.wait_timeout });
    expect((failure as { message: string }).message).toContain('text "Gagal"');
    await expect(h.controller.dispatch("wait_for", { tabId: 7 }, new Set([7]))).rejects.toMatchObject({ code: "invalid_arguments" });
  });

  it("screenshots default to a downscaled JPEG and say how the image maps to CSS pixels", async () => {
    const h = harness([]);
    const shot = await h.controller.dispatch("computer", { tabId: 7, action: "screenshot" }, new Set([7])) as Record<string, unknown>;
    expect(shot).toMatchObject({ mimeType: "image/jpeg", imageScale: 1600 / 2400, cssViewport: { width: 2400, height: 1200 } });
    expect(h.commands.find(command => command.method === "Page.captureScreenshot")?.params).toMatchObject({ format: "jpeg", quality: 70, clip: { width: 2400, height: 1200, scale: 1600 / 2400 } });
  });

  it("resize_window takes a preset without a window id, and clamps a too-narrow width instead of failing", async () => {
    const h = harness([]);
    await expect(h.controller.dispatch("resize_window", { preset: "mobile" }, new Set([7]))).resolves.toMatchObject({ width: 390, height: 844, tabIds: [7] });
    await expect(h.controller.dispatch("resize_window", { tabId: 7, width: 300, height: 700 }, new Set([7]))).resolves.toMatchObject({ width: 320, clamped: true });
  });
});

describe("find", () => {
  it("returns the innermost matches, controls first, not every ancestor that contains the text", async () => {
    const button = new FakeElement("Masuk", "BUTTON");
    const wrapper = new FakeElement("Selamat datang Masuk", "DIV");
    wrapper.contains = (element: unknown) => element === wrapper || element === button;
    const heading = new FakeElement("Masuk ke akun", "H1");
    const h = harness([wrapper, heading, button]);
    const found = await h.controller.dispatch("find", { tabId: 7, query: "masuk" }, new Set([7])) as { matches: Array<{ role: string; name: string }> };
    expect(found.matches.map(match => match.role)).toEqual(["button", "h1"]);
    expect(found.matches[0]!.name).toBe("Masuk");
  });
});
