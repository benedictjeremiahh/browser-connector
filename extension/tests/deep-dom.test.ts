import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserController, matchesPattern, normalizeError, parseExpectations } from "../src/browser";
import { SnapshotStore, diffNodes, type PageNode } from "../src/snapshots";

/* A tiny DOM with just enough structure for shadow roots and same-origin iframes: every element
   knows its root, a root knows its host, and an iframe document reaches its frame element through
   its window, as in a browser. */
type Rect = { left: number; top: number; right: number; bottom: number; width: number; height: number };
const box = (left: number, top: number, width: number, height: number): Rect => ({ left, top, right: left + width, bottom: top + height, width, height });

class El {
  readonly dataset: Record<string, string> = {};
  readonly attributes = new Map<string, string>();
  isConnected = true;
  disabled = false;
  shadowRoot: Root | null = null;
  contentDocument: Root | null = null;
  clientLeft = 0;
  clientTop = 0;
  rect = box(0, 0, 100, 20);
  root!: Root;
  constructor(public innerText: string, readonly tagName = "DIV", attributes: Record<string, string> = {}) {
    for (const [key, value] of Object.entries(attributes)) this.attributes.set(key, value);
  }
  get ownerDocument(): Root { return this.root.document ?? this.root; }
  getAttribute(name: string): string | null { return this.attributes.get(name) ?? null; }
  hasAttribute(name: string): boolean { return this.attributes.has(name); }
  getBoundingClientRect() { return this.rect; }
  getRootNode(): Root { return this.root; }
  scrollIntoView(): void {}
  dispatchEvent(): boolean { return true; }
  closest(): null { return null; }
  contains(other: unknown): boolean { return other === this; }
  matches(): boolean { return false; }
  focus(): void { this.root.activeElement = this; }
  blur(): void {}
}

class Input extends El {
  stored = "";
  type = "text"; name = ""; id = ""; autocomplete = "";
  constructor(text = "", attributes: Record<string, string> = {}) { super(text, "INPUT", attributes); }
  get value(): string { return this.stored; }
  set value(next: string) { this.stored = next; }
}

class Root {
  elements: El[] = [];
  activeElement: El | null = null;
  readonly body: { innerText: string };
  readonly documentElement = {};
  title = "Fixture";
  hit: ((x: number, y: number) => El | null) | undefined;
  /* The owning document of a shadow root; undefined for a document. */
  document?: Root;
  defaultView: { frameElement: El | null; getComputedStyle: () => { visibility: string } };
  constructor(readonly nodeType: 9 | 11, text = "", public host: El | null = null) {
    this.body = { innerText: text };
    this.defaultView = { frameElement: nodeType === 9 ? host : null, getComputedStyle: () => ({ visibility: "visible" }) };
  }
  add<T extends El>(element: T): T { element.root = this; this.elements.push(element); return element; }
  querySelectorAll(selector: string): El[] {
    if (selector === "*" || selector === "body *") return this.elements;
    const parts = selector.split(",").map(part => part.trim());
    return this.elements.filter(element => parts.some(part => {
      if (part === "[role]") return element.attributes.has("role");
      if (part === "[tabindex]") return element.attributes.has("tabindex");
      const match = /^([a-z0-9-]*)(?:\.([\w-]+))?$/.exec(part);
      if (!match) return false;
      return (!match[1] || element.tagName.toLowerCase() === match[1]) && (!match[2] || (element.getAttribute("class") ?? "").split(" ").includes(match[2]));
    }));
  }
  querySelector(): null { return null; }
  elementFromPoint(x: number, y: number): El | null { return this.hit ? this.hit(x, y) : null; }
}

interface Page { top: Root; tab: { id: number; windowId: number; url: string; title: string; status: string } }

function install(build: (top: Root) => void, options: { closedHosts?: string[] } = {}) {
  const top = new Root(9, "Welcome to the fixture");
  top.defaultView.frameElement = null;
  build(top);
  const commands: Array<{ method: string; params?: Record<string, unknown> }> = [];
  const removed: Array<(tabId: number) => void> = [];
  const listeners = { addListener: vi.fn() };
  const tab = { id: 7, windowId: 9, url: "http://localhost:5180/a?tab=orders", title: "Fixture", status: "complete" };
  vi.stubGlobal("chrome", {
    tabs: { onRemoved: { addListener: (handler: (tabId: number) => void) => removed.push(handler) }, onUpdated: listeners, get: vi.fn(async () => ({ ...tab })), query: vi.fn(async () => [{ id: 7, windowId: 9 }]) },
    webNavigation: { onCommitted: listeners },
    debugger: { onEvent: listeners, onDetach: listeners, attach: async () => {}, sendCommand: async (_target: unknown, method: string, params?: Record<string, unknown>) => { commands.push({ method, params }); return {}; } },
    dom: { openOrClosedShadowRoot: (element: El) => options.closedHosts?.includes(element.tagName.toLowerCase()) ? {} : null },
    scripting: { executeScript: async (input: { func: (...args: unknown[]) => unknown; args?: unknown[] }) => [{ result: await input.func(...(input.args ?? [])) }] }
  });
  vi.stubGlobal("document", top);
  vi.stubGlobal("location", { origin: "http://localhost:5180", pathname: "/a", href: "http://localhost:5180/a" });
  vi.stubGlobal("innerWidth", 1200); vi.stubGlobal("innerHeight", 800);
  vi.stubGlobal("getComputedStyle", () => ({ visibility: "visible" }));
  vi.stubGlobal("MutationObserver", class { observe() {} });
  vi.stubGlobal("HTMLElement", El);
  vi.stubGlobal("HTMLInputElement", Input);
  for (const name of ["HTMLButtonElement", "HTMLTextAreaElement", "HTMLSelectElement", "HTMLAnchorElement"]) vi.stubGlobal(name, class {});
  return { top, commands, tab, controller: new BrowserController(), removeTab: () => removed.forEach(handler => handler(7)) };
}

const controlled = new Set([7]);
type Node = Record<string, unknown>;
const read = async (controller: BrowserController, params: Record<string, unknown> = {}) =>
  await controller.dispatch("read_page", { tabId: 7, ...params }, controlled) as { nodes: Node[]; snapshotId: string; diff?: Record<string, Node[]>; summary?: Record<string, number>; diffUnavailable?: string };

afterEach(() => {
  vi.unstubAllGlobals();
  const g = globalThis as { __browserConnectorPageRefState?: unknown; __browserConnectorRuntime?: unknown };
  delete g.__browserConnectorPageRefState; delete g.__browserConnectorRuntime;
});

/* A page with a button in the light DOM, a field in an open shadow root, and a field in a same-origin iframe. */
function nestedPage(top: Root) {
  const saveButton = top.add(new El("Save", "BUTTON"));
  const host = top.add(new El("", "USER-CARD"));
  const shadow = new Root(11, "", host);
  shadow.document = top;
  host.shadowRoot = shadow;
  const shadowField = shadow.add(new Input("", { "aria-label": "Nickname" }));
  const frame = top.add(new El("", "IFRAME"));
  frame.rect = box(100, 50, 400, 300);
  frame.clientLeft = 1; frame.clientTop = 1;
  const inner = new Root(9, "Payment form inside", frame);
  frame.contentDocument = inner;
  const frameField = inner.add(new Input("", { "aria-label": "Card holder" }));
  frameField.rect = box(10, 20, 100, 20);
  const frameButton = inner.add(new El("Pay", "BUTTON"));
  frameButton.rect = box(10, 60, 100, 20);
  return { saveButton, host, shadow, shadowField, frame, inner, frameField, frameButton };
}

describe("open shadow roots and same-origin iframes", () => {
  it("read_page lists elements inside both, each with its own unique reference", async () => {
    const h = install(top => nestedPage(top));
    const { nodes } = await read(h.controller);
    expect(nodes.map(node => node.name)).toEqual(expect.arrayContaining(["Save", "Nickname", "Card holder", "Pay"]));
    const refs = nodes.map(node => node.ref);
    expect(new Set(refs).size).toBe(refs.length);
  });

  it("find locates a match inside a shadow root and inside a frame, and not the host that merely contains it", async () => {
    const h = install(top => { const parts = nestedPage(top); parts.host.innerText = "Nickname card"; });
    const found = await h.controller.dispatch("find", { tabId: 7, query: "nickname" }, controlled) as { matches: Node[] };
    expect(found.matches).toHaveLength(1);
    expect(found.matches[0]).toMatchObject({ role: "input", name: "Nickname" });
    const inFrame = await h.controller.dispatch("find", { tabId: 7, query: "card holder" }, controlled) as { matches: Node[] };
    expect(inFrame.matches.map(match => match.name)).toEqual(["Card holder"]);
  });

  it("reports a cross-origin frame and a closed shadow root as placeholders instead of failing", async () => {
    const h = install(top => {
      const opaqueFrame = top.add(new El("", "IFRAME", { title: "Chat widget" }));
      opaqueFrame.contentDocument = null;
      top.add(new El("", "SECRET-BOX"));
    }, { closedHosts: ["secret-box"] });
    const { nodes } = await read(h.controller);
    expect(nodes).toContainEqual(expect.objectContaining({ role: "iframe", opaque: true, name: 'iframe "Chat widget" (cross-origin, not inspected)' }));
    expect(nodes).toContainEqual(expect.objectContaining({ role: "secret-box", opaque: true, name: "secret-box (closed shadow root, not inspected)" }));
  });

  it("stops at a bounded depth and says so", async () => {
    const h = install(top => {
      let container: Root = top;
      for (let depth = 0; depth < 9; depth += 1) {
        const host = container.add(new El("", "WRAP-BOX"));
        const next = new Root(11, "", host);
        next.document = top;
        host.shadowRoot = next;
        container = next;
      }
      container.add(new El("Deep", "BUTTON"));
    });
    const { nodes } = await read(h.controller);
    expect(nodes.some(node => node.name === "Deep")).toBe(false);
    expect(nodes.some(node => node.opaque === true && String(node.name).includes("depth limit"))).toBe(true);
  });

  it("translates a click inside an iframe to top-level viewport coordinates", async () => {
    let frameElement: El | undefined;
    const h = install(top => {
      const parts = nestedPage(top);
      frameElement = parts.frame;
      parts.inner.hit = () => parts.frameButton;
      top.hit = () => parts.frame;
    });
    const { nodes } = await read(h.controller);
    const pay = nodes.find(node => node.name === "Pay")!;
    const result = await h.controller.dispatch("computer", { tabId: 7, action: "click", pageRef: pay.ref, settle: false }, controlled);
    expect(frameElement).toBeDefined();
    /* Button centre (60, 70) in the frame, plus the frame at (100, 50) and its 1px border. */
    const pressed = h.commands.find(command => command.method === "Input.dispatchMouseEvent" && command.params?.type === "mousePressed");
    expect(pressed?.params).toMatchObject({ x: 161, y: 121 });
    expect(result).toBeDefined();
  });

  it("refuses a click on a frame element that something in the top page covers", async () => {
    const h = install(top => {
      const parts = nestedPage(top);
      const overlay = top.add(new El("Cookie banner", "DIV", { role: "dialog" }));
      parts.inner.hit = () => parts.frameButton;
      top.hit = () => overlay;
    });
    const { nodes } = await read(h.controller);
    const pay = nodes.find(node => node.name === "Pay")!;
    const failure = await h.controller.dispatch("computer", { tabId: 7, action: "click", pageRef: pay.ref, settle: false }, controlled).catch(error => normalizeError(error));
    expect(failure).toMatchObject({ code: "click_intercepted" });
  });

  it("form_input writes to a field inside a shadow root and inside an iframe, and reads it back", async () => {
    const h = install(top => nestedPage(top));
    const { nodes } = await read(h.controller);
    const nickname = nodes.find(node => node.name === "Nickname")!;
    const holder = nodes.find(node => node.name === "Card holder")!;
    expect(await h.controller.dispatch("form_input", { tabId: 7, pageRef: nickname.ref, value: "bee", settle: false }, controlled)).toMatchObject({ matched: true, actual: "bee" });
    expect(await h.controller.dispatch("form_input", { tabId: 7, pageRef: holder.ref, value: "A. Person", settle: false }, controlled)).toMatchObject({ matched: true, actual: "A. Person" });
  });

  it("never echoes the value of a sensitive field inside a frame", async () => {
    const h = install(top => {
      const parts = nestedPage(top);
      const password = parts.inner.add(new Input("", { "aria-label": "Passphrase" }));
      password.type = "password";
      password.stored = "hunter2";
    });
    const { nodes } = await read(h.controller);
    const field = nodes.find(node => node.name === "Passphrase")!;
    expect(field.value).toBe("[redacted]");
    const written = await h.controller.dispatch("form_input", { tabId: 7, pageRef: field.ref, value: "correct horse", settle: false }, controlled);
    expect(JSON.stringify(written)).not.toContain("correct horse");
    expect(JSON.stringify(written)).not.toContain("hunter2");
  });

  it("a read scoped to a shadow host lists what is inside its shadow root", async () => {
    const h = install(top => { nestedPage(top).host.attributes.set("role", "group"); });
    const { nodes } = await read(h.controller);
    const host = nodes.find(node => node.role === "group")!;
    const scoped = await read(h.controller, { scopeRef: host.ref });
    expect(scoped.nodes.map(node => node.name)).toEqual(expect.arrayContaining(["Nickname"]));
    expect(scoped.nodes.map(node => node.name)).not.toContain("Save");
  });
});

describe("page runtime", () => {
  it("installs the runtime again when a page lost it", async () => {
    const h = install(top => nestedPage(top));
    await read(h.controller);
    delete (globalThis as { __browserConnectorRuntime?: unknown }).__browserConnectorRuntime;
    const { nodes } = await read(h.controller);
    expect(nodes.length).toBeGreaterThan(0);
  });
});

describe("assert", () => {
  const assertOn = async (controller: BrowserController, expect: unknown[], extra: Record<string, unknown> = {}) =>
    await controller.dispatch("assert", { tabId: 7, expect, ...extra }, controlled) as { passed: boolean; failed: number; results: Array<{ index: number; kind: string; passed: boolean; observed: string }> };

  it("checks text, url, title, element state and count in one call, with a result for each", async () => {
    const h = install(top => {
      const parts = nestedPage(top);
      parts.saveButton.disabled = true;
      for (let index = 0; index < 3; index += 1) top.add(new El(`Row ${index}`, "LI", { class: "row" }));
    });
    const outcome = await assertOn(h.controller, [
      { kind: "text_present", text: "WELCOME to" },
      { kind: "text_absent", text: "Error" },
      { kind: "url_matches", pattern: "/a?tab=orders" },
      { kind: "url_matches", pattern: "/\\/A\\?tab=(orders|users)$/i" },
      { kind: "title_matches", pattern: "fixture" },
      { kind: "element", name: "save", role: "button", state: "disabled" },
      { kind: "element", name: "Save", state: "enabled" },
      { kind: "element", name: "Nickname", role: "textbox" },
      { kind: "element", selector: ".nothing", state: "hidden" },
      { kind: "count", selector: "li.row", equals: 3 },
      { kind: "count", selector: "li.row", atLeast: 4 }
    ]);
    expect(outcome.results.map(result => result.passed)).toEqual([true, true, true, true, true, true, false, true, true, true, false]);
    expect(outcome.passed).toBe(false);
    expect(outcome.failed).toBe(2);
    expect(outcome.results.map(result => result.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(outcome.results[0]).toMatchObject({ kind: "text_present", observed: "found" });
    expect(outcome.results[10]!.observed).toBe("3 matches");
  });

  it("sees text and elements inside an iframe, and a shadow root", async () => {
    const h = install(top => nestedPage(top));
    const outcome = await assertOn(h.controller, [
      { kind: "text_present", text: "payment form inside" },
      { kind: "element", name: "Card holder", state: "visible" },
      { kind: "element", name: "Nickname", state: "visible" },
      { kind: "count", selector: "input", equals: 2 }
    ]);
    expect(outcome.passed).toBe(true);
  });

  it("matches a field value but never compares or echoes a sensitive one", async () => {
    const h = install(top => {
      const parts = nestedPage(top);
      parts.shadowField.stored = "bee";
      const password = top.add(new Input("", { "aria-label": "Password" }));
      password.type = "password";
      password.stored = "hunter2";
    });
    const outcome = await assertOn(h.controller, [
      { kind: "element", name: "Nickname", value: "bee" },
      { kind: "element", name: "Nickname", value: "nope" },
      { kind: "element", name: "Password", value: "hunter2" }
    ]);
    expect(outcome.results.map(result => result.passed)).toEqual([true, false, false]);
    expect(outcome.results[1]!.observed).toContain('value "bee"');
    expect(JSON.stringify(outcome)).not.toContain("hunter2");
    expect(outcome.results[2]!.observed).toContain("[redacted]");
  });

  it("checks a value against the field, not the label that shares its name", async () => {
    const h = install(top => {
      top.add(new El("Store name", "LABEL"));
      top.add(new Input("", { "aria-label": "Store name" })).stored = "Toko";
    });
    const outcome = await assertOn(h.controller, [
      { kind: "element", name: "Store name", value: "Toko" },
      { kind: "element", name: "Store name", state: "visible" }
    ]);
    expect(outcome.results.map(result => result.passed)).toEqual([true, true]);
    expect(outcome.results[0]!.observed).toBe('2 matches; visible; value "Toko"');
  });

  it("matches the redacted URL, so an expectation cannot confirm a guess at a redacted part", async () => {
    const h = install(top => nestedPage(top));
    h.tab.url = "http://localhost:5180/reset?token=abc&tab=orders";
    const outcome = await assertOn(h.controller, [{ kind: "url_matches", pattern: "abc" }, { kind: "url_matches", pattern: "tab=orders" }]);
    expect(outcome.results.map(result => result.passed)).toEqual([false, true]);
    expect(outcome.results[0]!.observed).not.toContain("abc");
  });

  it("with timeoutMs keeps checking until the page catches up, and reports a failure rather than throwing when it does not", async () => {
    const h = install(top => nestedPage(top));
    setTimeout(() => { h.top.body.innerText = "All saved"; }, 150);
    const caught = await assertOn(h.controller, [{ kind: "text_present", text: "all saved" }], { timeoutMs: 2000 });
    expect(caught.passed).toBe(true);
    const missed = await assertOn(h.controller, [{ kind: "text_present", text: "never shown" }], { timeoutMs: 300 });
    expect(missed.passed).toBe(false);
    expect((missed as unknown as { waitedMs: number }).waitedMs).toBeGreaterThanOrEqual(300);
  });

  it("rejects a malformed expectation before checking any", async () => {
    const h = install(top => nestedPage(top));
    await expect(assertOn(h.controller, [{ kind: "text_present", text: "x" }, { kind: "count", selector: "li" }])).rejects.toMatchObject({ code: "invalid_arguments", message: expect.stringContaining("expect[1]") });
    await expect(assertOn(h.controller, [])).rejects.toMatchObject({ code: "invalid_arguments" });
    await expect(assertOn(h.controller, [{ kind: "screenshot" }])).rejects.toMatchObject({ code: "invalid_arguments" });
    await expect(assertOn(h.controller, [{ kind: "url_matches", pattern: "/(/" }])).rejects.toMatchObject({ code: "invalid_arguments" });
  });

  it("reports a stale Page Reference as a failed expectation with a next step", async () => {
    const h = install(top => nestedPage(top));
    const outcome = await assertOn(h.controller, [{ kind: "element", pageRef: "p1-999" }]);
    expect(outcome.results[0]).toMatchObject({ passed: false });
    expect(outcome.results[0]!.observed).toContain("stale");
  });
});

describe("read_page snapshots and diffFrom", () => {
  it("returns a snapshotId and, with diffFrom, only what was added, removed or changed", async () => {
    let parts!: ReturnType<typeof nestedPage>;
    const h = install(top => { parts = nestedPage(top); });
    const first = await read(h.controller);
    expect(first.snapshotId).toMatch(/^s/);
    parts.saveButton.disabled = true;
    parts.frameButton.isConnected = false;
    parts.inner.elements = parts.inner.elements.filter(element => element !== parts.frameButton);
    const added = h.top.add(new El("Undo", "BUTTON"));
    const second = await read(h.controller, { diffFrom: first.snapshotId });
    expect(second.nodes).toBeUndefined();
    expect(second.snapshotId).not.toBe(first.snapshotId);
    expect(second.summary).toMatchObject({ added: 1, removed: 1, changed: 1 });
    expect(second.diff?.added?.[0]).toMatchObject({ name: "Undo", ref: expect.any(String) });
    expect(second.diff?.removed?.[0]).toMatchObject({ name: "Pay" });
    expect(second.diff?.changed?.[0]).toMatchObject({ name: "Save", changes: { disabled: { from: false, to: true } } });
    expect(added).toBeDefined();
    /* Chaining: the second snapshot is a valid base for the next read. */
    const third = await read(h.controller, { diffFrom: second.snapshotId });
    expect(third.summary).toMatchObject({ added: 0, removed: 0, changed: 0 });
  });

  it("returns the full tree and says so when the snapshot is unknown or was read differently", async () => {
    const h = install(top => nestedPage(top));
    const unknown = await read(h.controller, { diffFrom: "s0000-99" });
    expect(unknown.nodes.length).toBeGreaterThan(0);
    expect(unknown.diffUnavailable).toContain("unknown or expired");
    const interactive = await read(h.controller);
    const other = await read(h.controller, { diffFrom: interactive.snapshotId, filter: "all" });
    expect(other.diffUnavailable).toContain("different filter");
    expect(other.nodes.length).toBeGreaterThan(0);
  });

  it("keeps only the last few snapshots per tab, and drops them when the tab closes", async () => {
    const h = install(top => nestedPage(top));
    const first = await read(h.controller);
    for (let index = 0; index < 4; index += 1) await read(h.controller);
    expect((await read(h.controller, { diffFrom: first.snapshotId })).diffUnavailable).toContain("unknown or expired");
    const live = await read(h.controller);
    h.removeTab();
    expect((await read(h.controller, { diffFrom: live.snapshotId })).diffUnavailable).toContain("unknown or expired");
  });

  it("drops a tab's snapshots when its session ends", async () => {
    const h = install(top => nestedPage(top));
    const snapshot = await read(h.controller);
    await h.controller.detachTabs([7]);
    expect((await read(h.controller, { diffFrom: snapshot.snapshotId })).diffUnavailable).toContain("unknown or expired");
  });

  it("does not diff a truncated read, which cannot tell a removed node from one beyond the cut", async () => {
    const h = install(top => { for (let index = 0; index < 600; index += 1) top.add(new El(`Item ${index}`, "BUTTON")); });
    const first = await read(h.controller);
    expect(first.nodes).toHaveLength(500);
    const second = await read(h.controller, { diffFrom: first.snapshotId });
    expect(second.diffUnavailable).toContain("truncated");
  });
});

describe("snapshot helpers", () => {
  const node = (ref: string, name: string, extra: Record<string, unknown> = {}): PageNode => ({ ref, role: "button", name, ...extra });

  it("pairs a re-created element with its old self by role and name instead of reporting churn", () => {
    const diff = diffNodes([node("p1-1", "Save"), node("p1-2", "Cancel")], [node("p1-7", "Save"), node("p1-8", "Cancel", { disabled: true }), node("p1-9", "Help")]);
    expect(diff.summary).toEqual({ added: 1, removed: 0, changed: 1, rerendered: 1, unchanged: 0 });
    expect(diff.changed[0]).toMatchObject({ ref: "p1-8", previousRef: "p1-2" });
  });

  it("clips long values in a change", () => {
    const diff = diffNodes([node("p1-1", "Notes", { value: "a" })], [node("p1-1", "Notes", { value: "b".repeat(500) })]);
    expect(String((diff.changed[0]!.changes.value!.to as string).length)).toBe("123");
  });

  it("caps snapshots per tab and separates tabs", () => {
    const store = new SnapshotStore();
    const ids = Array.from({ length: 6 }, () => store.record(1, { generation: 1, key: "k", complete: true, nodes: [] }));
    const other = store.record(2, { generation: 1, key: "k", complete: true, nodes: [] });
    expect(store.find(1, ids[0]!)).toBeUndefined();
    expect(store.find(1, ids[5]!)).toBeDefined();
    expect(store.find(1, other)).toBeUndefined();
    store.clear(1);
    expect(store.find(1, ids[5]!)).toBeUndefined();
    expect(store.find(2, other)).toBeDefined();
  });

  it("matches a pattern as a case-insensitive substring or a /regex/", () => {
    expect(matchesPattern("https://Example.test/Orders", "/orders")).toBe(true);
    expect(matchesPattern("https://example.test/orders/12", "/\\/orders\\/\\d+$/")).toBe(true);
    expect(matchesPattern("https://example.test/orders", "/\\/orders\\/\\d+$/")).toBe(false);
  });

  it("validates an expectation list as a whole", () => {
    expect(() => parseExpectations([{ kind: "element", state: "enabled" }])).toThrow(/expect\[0\]/);
    expect(() => parseExpectations([{ kind: "element", name: "Save", state: "glowing" }])).toThrow(/state must be/);
    expect(parseExpectations([{ kind: "count", selector: "li", atMost: 2, visible: true }])).toEqual([{ index: 0, kind: "count", selector: "li", atMost: 2, visible: true }]);
  });
});
