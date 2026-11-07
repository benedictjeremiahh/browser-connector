import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserController, injectedActiveElement, injectedClickGuard, parseExpectations } from "../src/browser";
import { SnapshotStore } from "../src/snapshots";
import { injectedAssert } from "../src/page-runtime";
import { sameTargetDifferentHash } from "../src/policy";

function event() {
  const listeners = new Set<(...args: unknown[]) => void>();
  return {
    addListener: vi.fn((listener: (...args: unknown[]) => void) => listeners.add(listener)),
    removeListener: vi.fn((listener: (...args: unknown[]) => void) => listeners.delete(listener)),
    emit: (...args: unknown[]) => { for (const listener of [...listeners]) listener(...args); },
    size: () => listeners.size
  };
}

function harness(respond: (name: string, args: unknown[]) => unknown) {
  const tab = { id: 7, windowId: 9, url: "https://example.test/", title: "Page", active: true, status: "complete" };
  const tabs = {
    get: vi.fn(async () => ({ ...tab })),
    update: vi.fn(async () => ({ ...tab })),
    query: vi.fn(async () => [{ ...tab }]),
    group: vi.fn(async () => 1),
    onUpdated: event(),
    onRemoved: event(),
    onCreated: event()
  };
  const debuggerApi = {
    attach: vi.fn(async () => {}),
    detach: vi.fn(async () => {}),
    sendCommand: vi.fn(async (_target: unknown, method: string, _params?: Record<string, unknown>) => {
      if (method === "Page.getLayoutMetrics") return { cssVisualViewport: { clientWidth: 800, clientHeight: 600 } };
      return {};
    }),
    onEvent: event(),
    onDetach: event()
  };
  const scripting = {
    executeScript: vi.fn(async ({ func, args }: { func: (...values: never[]) => unknown; args: unknown[] }) => {
      const name = (func as { name?: string }).name ?? "";
      if (name === "injectedInstallRuntime") return [{ result: undefined }];
      return [{ result: respond(name, args) }];
    })
  };
  vi.stubGlobal("chrome", {
    tabs,
    windows: { get: vi.fn(async () => ({ id: 9, state: "normal" })), update: vi.fn() },
    debugger: debuggerApi,
    scripting,
    webNavigation: { onCommitted: event() },
    runtime: { lastError: undefined }
  } as unknown as typeof chrome);
  return { controller: new BrowserController(), tabs, debuggerApi, scripting };
}

afterEach(() => { vi.unstubAllGlobals(); delete (globalThis as { __browserConnectorRuntime?: unknown }).__browserConnectorRuntime; });

describe("interaction feedback", () => {
  it("reports changed:false when the page rejected the value", async () => {
    const h = harness((name) => name === "injectedFormInput" ? { matched: false, actual: "kept" } : null);
    const result = await h.controller.dispatch("form_input", { tabId: 7, pageRef: "p7-1", value: "new", settle: false }, new Set([7])) as { changed: boolean; matched: boolean; actual: unknown };
    expect(result.changed).toBe(false);
    expect(result.matched).toBe(false);
    expect(result.actual).toBe("kept");
  });

  it("refuses a non-boolean checkbox value", async () => {
    const h = harness((name) => name === "injectedFormInput" ? { invalidType: "boolean" } : null);
    await expect(h.controller.dispatch("form_input", { tabId: 7, pageRef: "p7-1", value: "false", settle: false }, new Set([7])))
      .rejects.toMatchObject({ code: "invalid_arguments" });
  });

  it("gives an unchecked radio its own error code", async () => {
    const h = harness((name) => name === "injectedFormInput" ? { radioCannotUncheck: true } : null);
    await expect(h.controller.dispatch("form_input", { tabId: 7, pageRef: "p7-1", value: false, settle: false }, new Set([7])))
      .rejects.toMatchObject({ code: "radio_cannot_uncheck" });
  });

  it("returns the fields it wrote when a later field fails", async () => {
    const h = harness((name, args) => {
      if (name !== "injectedFormInput") return null;
      return String(args[0]) === "p7-2" ? false : { matched: true, actual: "ok" };
    });
    const result = await h.controller.dispatch("fill_form", {
      tabId: 7,
      settle: false,
      fields: [{ pageRef: "p7-1", value: "a" }, { pageRef: "p7-2", value: "b" }, { pageRef: "p7-3", value: "c" }]
    }, new Set([7])) as { failedAt?: number; allMatched: boolean; fields: Array<Record<string, unknown>> };
    expect(result.failedAt).toBe(1);
    expect(result.allMatched).toBe(false);
    expect(result.fields).toHaveLength(2);
    expect(result.fields[0]).toMatchObject({ pageRef: "p7-1", ok: true, changed: true });
    expect(result.fields[1]).toMatchObject({ pageRef: "p7-2", ok: false });
    expect((result.fields[1]!.error as { code: string }).code).toBe("stale_page_ref");
  });

  it("reads back the focused field after typing", async () => {
    const h = harness((name) => {
      if (name === "injectedFocusRef") return true;
      if (name === "injectedRefPoint") return { x: 10, y: 20 };
      if (name === "injectedActiveElement") return { tag: "input", type: "text", editable: true, value: "hello" };
      return null;
    });
    const result = await h.controller.dispatch("computer", { tabId: 7, action: "type", pageRef: "p7-1", text: "hello", settle: false }, new Set([7])) as { typed: boolean; actual: string; focused: Record<string, unknown> };
    expect(result.typed).toBe(true);
    expect(result.actual).toBe("hello");
    expect(result.focused).toMatchObject({ tag: "input", type: "text" });
  });

  it("reports the scroll position before and after and whether it moved", async () => {
    let call = 0;
    const h = harness((name) => {
      if (name !== "injectedScrollState") return null;
      call += 1;
      return call === 1 ? { x: 0, y: 0 } : { x: 0, y: 600 };
    });
    const result = await h.controller.dispatch("computer", { tabId: 7, action: "scroll", deltaY: 600, x: 10, y: 10 }, new Set([7])) as { moved: boolean; before: unknown; after: unknown };
    expect(result.moved).toBe(true);
    expect(result.before).toEqual({ x: 0, y: 0 });
    expect(result.after).toEqual({ x: 0, y: 600 });
  });

  it("does not scroll vertically when only deltaX is supplied", async () => {
    const h = harness((name) => name === "injectedScrollState" ? { x: 0, y: 0 } : null);
    const result = await h.controller.dispatch("computer", { tabId: 7, action: "scroll", deltaX: 100, x: 10, y: 10 }, new Set([7])) as { scrolled: unknown };
    expect(result.scrolled).toEqual({ x: 100, y: 0 });
  });

  it("reports whether console and network were monitored, and what changed", async () => {
    let mutations = 0;
    const h = harness((name) => {
      if (name === "injectedMutationState") {
        mutations += 1;
        return { count: mutations === 1 ? 0 : 2, sequence: 0, notices: [], present: [] };
      }
      if (name === "injectedFormInput") return { matched: true, actual: "ok" };
      if (name === "injectedFocusInfo") return { ref: "p7-1", role: "textbox", name: "Email" };
      return null;
    });
    const result = await h.controller.dispatch("form_input", { tabId: 7, pageRef: "p7-1", value: "x" }, new Set([7])) as { after: Record<string, unknown> };
    expect(result.after.monitoring).toEqual({ console: false, network: false });
    expect(result.after.changeCount).toBe(2);
    expect(result.after.focus).toEqual({ ref: "p7-1", role: "textbox", name: "Email" });
  });

  it("finds the last node seen for a stale ref", () => {
    const store = new SnapshotStore();
    store.record(7, { generation: 1, key: "k", complete: true, nodes: [{ ref: "p7-1", role: "button", name: "Save" }] });
    expect(store.forRef(7, "p7-1")).toMatchObject({ role: "button", name: "Save" });
    expect(store.forRef(7, "p7-9")).toBeUndefined();
  });

  it("accepts the new element states and a count by role", () => {
    const parsed = parseExpectations([
      { kind: "element", role: "button", state: "expanded" },
      { kind: "count", role: "button", equals: 2 }
    ]);
    expect(parsed).toHaveLength(2);
    expect(() => parseExpectations([{ kind: "element", role: "button", state: "bogus" }])).toThrow();
  });

  it("waits for any condition when mode is any", async () => {
    const h = harness((name) => name === "injectedWaitCheck" ? { text: false, selector: true } : null);
    const result = await h.controller.dispatch("wait_for", { tabId: 7, text: "Done", selector: "#done", mode: "any" }, new Set([7])) as { met: boolean };
    expect(result.met).toBe(true);
  });

  it("rejects an invalid selector immediately instead of waiting", async () => {
    const h = harness((name) => name === "injectedWaitCheck" ? { invalidSelector: true } : null);
    await expect(h.controller.dispatch("wait_for", { tabId: 7, selector: "[[[", timeoutMs: 1000 }, new Set([7])))
      .rejects.toMatchObject({ code: "invalid_arguments" });
  });

  it("navigates a reused tab when only the hash differs", async () => {
    const h = harness(() => null);
    h.tabs.get.mockResolvedValue({ id: 7, windowId: 9, url: "https://example.test/#/orders/1", title: "Orders", active: true, status: "complete" } as never);
    await h.controller.dispatch("tabs_create", { url: "https://example.test/#/orders/2", settle: false }, new Set([7]));
    expect(h.tabs.update).toHaveBeenCalledWith(7, { url: "https://example.test/#/orders/2" });
  });

  it("reports an offscreen target instead of clicking", async () => {
    const h = harness((name) => name === "injectedRefPoint" ? { blocked: "offscreen" } : null);
    await expect(h.controller.dispatch("computer", { tabId: 7, action: "click", pageRef: "p7-1", settle: false }, new Set([7])))
      .rejects.toMatchObject({ code: "element_not_visible" });
  });

  it("rejects the click when the target is covered after the dwell", async () => {
    const h = harness((name) => {
      if (name === "injectedRefPoint") return { x: 10, y: 20 };
      if (name === "injectedClickGuard") return { blockedBy: 'dialog "Confirm"' };
      return null;
    });
    await expect(h.controller.dispatch("computer", { tabId: 7, action: "click", pageRef: "p7-1", settle: false }, new Set([7])))
      .rejects.toMatchObject({ code: "click_intercepted" });
  });

  it("reports a tab the page opened during a settled action", async () => {
    const h = harness((name) => {
      if (name === "injectedRefPoint") return { x: 10, y: 20 };
      if (name === "injectedClickGuard") return { point: { x: 10, y: 20 }, role: "button", name: "Open" };
      if (name === "injectedMutationState") return { count: 0, sequence: 0, notices: [], present: [] };
      return null;
    });
    h.debuggerApi.sendCommand.mockImplementation(async (_target: unknown, method: string, params?: Record<string, unknown>) => {
      if (method === "Input.dispatchMouseEvent" && params?.type === "mousePressed") {
        h.tabs.onCreated.emit({ id: 99, openerTabId: 7, url: "https://example.test/new", title: "New" });
      }
      return {};
    });
    const result = await h.controller.dispatch("computer", { tabId: 7, action: "click", pageRef: "p7-1" }, new Set([7])) as { after: Record<string, unknown> };
    expect(result.after.openedTabs).toEqual([{ tabId: 99, url: "https://example.test/new", title: "New" }]);
  });

  it("adopts the page's document generation after a worker restart", async () => {
    const h = harness((name) => name === "injectedDocumentGeneration" ? 5 : null);
    await h.controller.dispatch("read_page", { tabId: 7 }, new Set([7])).catch(() => undefined);
    const context = await h.controller.dispatch("tabs_context", {}, new Set([7])) as { tabs: Array<Record<string, unknown>> };
    expect(context.tabs[0]!.documentGeneration).toBe(5);
    const read = h.scripting.executeScript.mock.calls.find(([input]) => (input as { func?: { name?: string } }).func?.name === "injectedReadPage");
    expect((read?.[0] as { args?: unknown[] }).args?.[0]).toBe(5);
  });

  it("fails fast when a JavaScript dialog blocks the page", async () => {
    const h = harness(() => null);
    h.debuggerApi.onEvent.emit({ tabId: 7 }, "Page.javascriptDialogOpening", { type: "confirm", message: "Delete this?" });
    await expect(h.controller.dispatch("read_page", { tabId: 7 }, new Set([7])))
      .rejects.toMatchObject({ code: "javascript_dialog_open", after: { dialog: { type: "confirm", message: "Delete this?" } } });
  });

  it("reports the page's drag events and passes modifiers", async () => {
    const h = harness((name) => {
      if (name === "injectedRefPoint") return { x: 10, y: 20 };
      if (name === "injectedDragProbe") return { dragstart: 1, dragover: 3, drop: 0 };
      return null;
    });
    const result = await h.controller.dispatch("computer", { tabId: 7, action: "drag", pageRef: "p7-1", toPageRef: "p7-2", modifiers: "shift", settle: false }, new Set([7])) as { events: unknown };
    expect(result.events).toEqual({ dragstart: 1, dragover: 3, drop: 0 });
    const pressed = h.debuggerApi.sendCommand.mock.calls.find(([, method, params]) => method === "Input.dispatchMouseEvent" && (params as { type?: string })?.type === "mousePressed");
    expect((pressed?.[2] as { modifiers?: number }).modifiers).toBe(8);
  });

  it("click guards an element inside an open shadow root without blocking it", () => {
    const element = {
      tagName: "BUTTON",
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 20 }),
      getAttribute: () => null,
      getRootNode: () => ({ nodeType: 11, elementFromPoint: () => element }),
      contains: () => false,
      labels: []
    };
    vi.stubGlobal("document", { elementFromPoint: () => null, getElementById: () => null });
    vi.stubGlobal("getComputedStyle", () => ({ visibility: "visible" }));
    (globalThis as { __browserConnectorRuntime?: unknown }).__browserConnectorRuntime = {
      currentState: () => ({}),
      scan: () => ({ resolve: () => element }),
      nameOf: () => "Save",
      hostChain: () => [],
      frameOffset: () => ({ x: 0, y: 0 }),
      sensitive: () => false
    };
    expect(injectedClickGuard("p1-1", 1, 50, 10)).toEqual({ point: { x: 50, y: 10 }, role: "button", name: "Save" });
  });

  it("redacts a sensitive field that is not type=password", () => {
    const field = { tagName: "INPUT", type: "text", value: "123456", name: "otp", id: "otp", autocomplete: "one-time-code", readOnly: false, disabled: false, shadowRoot: null, getAttribute: () => null };
    vi.stubGlobal("document", { activeElement: field, getElementById: () => null });
    (globalThis as { __browserConnectorRuntime?: unknown }).__browserConnectorRuntime = { sensitive: () => true };
    expect(injectedActiveElement()).toMatchObject({ value: "[redacted]" });
  });

  it("reports the scroll a pageRef performed", async () => {
    let call = 0;
    const h = harness((name) => {
      if (name === "injectedRefPoint") return { x: 10, y: 20 };
      if (name === "injectedScrollState") { call += 1; return call === 1 ? { x: 0, y: 0 } : { x: 0, y: 300 }; }
      return null;
    });
    const result = await h.controller.dispatch("computer", { tabId: 7, action: "scroll", pageRef: "p7-1" }, new Set([7])) as { moved: boolean };
    expect(result.moved).toBe(true);
  });

  it("clears a dialog when the debugger detaches", async () => {
    const h = harness(() => null);
    h.debuggerApi.onEvent.emit({ tabId: 7 }, "Page.javascriptDialogOpening", { type: "alert", message: "Saved" });
    h.debuggerApi.onDetach.emit({ tabId: 7 });
    await expect(h.controller.dispatch("computer", { tabId: 7, action: "screenshot", settle: false }, new Set([7]))).resolves.toBeDefined();
  });

  it("does not reload a tab when only the query order differs", async () => {
    const h = harness(() => null);
    h.tabs.get.mockResolvedValue({ id: 7, windowId: 9, url: "https://example.test/?a=1&b=2", title: "Page", active: true, status: "complete" } as never);
    await h.controller.dispatch("tabs_create", { url: "https://example.test/?b=2&a=1", settle: false }, new Set([7]));
    expect(h.tabs.update).not.toHaveBeenCalledWith(7, { url: "https://example.test/?b=2&a=1" });
  });

  it("judges a hidden control by its control, not by its visible label", () => {
    const label: Record<string, unknown> = {
      tagName: "LABEL", control: null, innerText: "Accept", textContent: "Accept",
      getBoundingClientRect: () => ({ width: 100, height: 20 }), getAttribute: () => null
    };
    const input: Record<string, unknown> = {
      tagName: "INPUT", type: "checkbox", checked: true, disabled: false, labels: [label],
      getBoundingClientRect: () => ({ width: 0, height: 0 }), getAttribute: () => null,
      matches: () => false, closest: () => null
    };
    label.control = input;
    (globalThis as { __browserConnectorRuntime?: unknown }).__browserConnectorRuntime = {
      scan: () => ({ query: () => [label, input], resolve: () => null }),
      visible: (element: unknown) => element === label,
      nameOf: () => "Accept",
      roleMatches: () => true,
      is: (element: unknown, name: string) => name === "HTMLInputElement" && element === input,
      activeIn: () => null,
      visibleText: () => ""
    };
    expect(injectedAssert([{ index: 0, kind: "element", name: "Accept", state: "checked" }], 1)[0]).toMatchObject({ passed: true });
    expect(injectedAssert([{ index: 0, kind: "count", name: "Accept", equals: 1 }], 1)[0]).toMatchObject({ passed: true });
  });

  it("treats a hash route as a navigation only when the fragment differs", () => {
    expect(sameTargetDifferentHash("https://x/a?a=1&b=2#/route1", "https://x/a?b=2&a=1#/route2")).toBe(true);
    expect(sameTargetDifferentHash("https://x/a#/route2", "HTTPS://X/a#/route2")).toBe(false);
    expect(sameTargetDifferentHash("https://x/a#/route1", "https://x/a#/route1")).toBe(false);
  });
});
