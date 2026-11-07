import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserController, parseExpectations } from "../src/browser";
import { SnapshotStore } from "../src/snapshots";

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
    sendCommand: vi.fn(async (_target: unknown, method: string) => {
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

afterEach(() => { vi.unstubAllGlobals(); });

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
  });
});
