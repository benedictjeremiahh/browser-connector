import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserController } from "../src/browser";

function event() {
  const listeners = new Set<(...args: unknown[]) => void>();
  return {
    addListener: vi.fn((listener: (...args: unknown[]) => void) => listeners.add(listener)),
    removeListener: vi.fn((listener: (...args: unknown[]) => void) => listeners.delete(listener)),
    emit: (...args: unknown[]) => { for (const listener of [...listeners]) listener(...args); },
    size: () => listeners.size
  };
}

function harness() {
  const updated = event();
  const committed = event();
  const trace: string[] = [];
  const tab = { id: 7, windowId: 9, status: "complete", url: "https://example.test/b", title: "Generic page", active: false };
  const window = { id: 9, state: "normal", width: 1200, height: 900 };
  function navigate(url: string): void {
    tab.status = "loading";
    updated.emit(7, { status: "loading" }, { ...tab });
    tab.url = url;
    tab.status = "complete";
    updated.emit(7, { status: "complete", url }, { ...tab });
  }
  const tabs = {
    onUpdated: updated, onRemoved: event(),
    get: vi.fn(async () => ({ ...tab })),
    update: vi.fn(async (_id: number, args: { active?: boolean; url?: string }) => {
      if (args.active !== undefined) tab.active = args.active;
      if (args.url) navigate(args.url);
      return { ...tab };
    }),
    reload: vi.fn(async () => { navigate(tab.url); }),
    goBack: vi.fn(async () => { navigate("https://example.test/a"); }),
    goForward: vi.fn(async () => { navigate("https://example.test/c"); })
  };
  const windows = {
    get: vi.fn(async () => ({ ...window })),
    update: vi.fn(async (_id: number, args: Partial<typeof window>) => { Object.assign(window, args); return { ...window }; })
  };
  const debuggerApi = {
    onEvent: event(), onDetach: event(), attach: vi.fn(async () => {}),
    sendCommand: vi.fn(async (_target: unknown, method: string, params?: Record<string, unknown>) => {
      if (method === "Page.getNavigationHistory") return { currentIndex: 1, entries: [{ id: 10, url: "https://example.test/a" }, { id: 11, url: tab.url }] };
      if (method === "Page.navigateToHistoryEntry") navigate("https://example.test/a");
      if (method === "Input.dispatchMouseEvent") trace.push(String(params?.type));
      return {};
    })
  };
  const scripting = {
    executeScript: vi.fn(async (args: { args?: unknown[] }): Promise<Array<{ result: { x: number; y: number } | null }>> => {
      const ref = args.args?.[0];
      trace.push(`resolve:${ref}`);
      return [{ result: ref === "p1-start" ? { x: 20, y: 40 } : { x: 50, y: 80 } }];
    })
  };
  vi.stubGlobal("chrome", { tabs, windows, debugger: debuggerApi, scripting, webNavigation: { onCommitted: committed } });
  return { controller: new BrowserController(), tabs, windows, debuggerApi, scripting, tab, window, updated, committed, trace, navigate };
}

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("native browser method completion", () => {
  it("observes a fast navigation that completes before its API promise resolves", async () => {
    const h = harness();
    await expect(h.controller.dispatch("navigate", { tabId: 7, action: "go_to", url: "https://example.test/new" }, new Set([7])))
      .resolves.toMatchObject({ tabId: 7, url: "https://example.test/new" });
    expect(h.updated.size()).toBe(0);
    expect(h.committed.size()).toBe(1); // The controller's document-generation listener remains.
  });

  it("does not mistake the old document's complete status for a finished navigation", async () => {
    vi.useFakeTimers();
    const h = harness();
    h.tabs.update.mockImplementation(async () => ({ ...h.tab }));
    const result = h.controller.dispatch("navigate", { tabId: 7, action: "go_to", url: "https://example.test/new" }, new Set([7]));
    const failure = expect(result).rejects.toMatchObject({ code: "navigation_timeout", outcomeUnknown: true });
    await vi.advanceTimersByTimeAsync(15_001);
    await failure;
    expect(h.updated.size()).toBe(0);
  });

  it("uses the renderer's exact prior history entry only after a native history-boundary error", async () => {
    const h = harness();
    h.tabs.goBack.mockRejectedValue(new Error("Cannot find a next page in history."));
    await expect(h.controller.dispatch("navigate", { tabId: 7, action: "back" }, new Set([7])))
      .resolves.toMatchObject({ url: "https://example.test/a" });
    expect(h.debuggerApi.sendCommand).toHaveBeenCalledWith({ tabId: 7 }, "Page.navigateToHistoryEntry", { entryId: 10 });
  });

  it("never works around permission errors or navigates to an absent history entry", async () => {
    const denied = harness();
    denied.tabs.goBack.mockRejectedValue(new Error("Permission denied"));
    await expect(denied.controller.dispatch("navigate", { tabId: 7, action: "back" }, new Set([7]))).rejects.toThrow("Permission denied");
    expect(denied.debuggerApi.sendCommand).not.toHaveBeenCalled();

    const boundary = harness();
    boundary.tabs.goBack.mockRejectedValue(new Error("Cannot find a previous page in history."));
    boundary.debuggerApi.sendCommand.mockImplementation(async () => ({ currentIndex: 0, entries: [] }));
    await expect(boundary.controller.dispatch("navigate", { tabId: 7, action: "back" }, new Set([7]))).rejects.toThrow("Cannot find a previous page");
    expect(boundary.debuggerApi.sendCommand.mock.calls.some(call => call[1] === "Page.navigateToHistoryEntry")).toBe(false);
  });

  it("restores a minimized window only when explicitly activating its controlled tab", async () => {
    const h = harness();
    h.window.state = "minimized";
    await h.controller.dispatch("tabs_activate", { tabId: 7 }, new Set([7]));
    expect(h.windows.update).toHaveBeenCalledWith(9, { state: "normal", focused: true });
    expect(h.window.state).toBe("normal");
  });

  it("verifies resized bounds without silently leaving fullscreen", async () => {
    const h = harness();
    await expect(h.controller.dispatch("resize_window", { windowId: 9, width: 1000, height: 700 }, new Set([7])))
      .resolves.toMatchObject({ width: 1000, height: 700, state: "normal" });
    expect(h.windows.get).toHaveBeenCalledTimes(2);
    h.window.state = "fullscreen";
    h.windows.update.mockClear();
    await expect(h.controller.dispatch("resize_window", { windowId: 9, width: 900, height: 600 }, new Set([7])))
      .rejects.toMatchObject({ code: "window_not_resizable", outcomeUnknown: false });
    expect(h.windows.update).not.toHaveBeenCalled();
  });

  it("reports unknown resize outcome if the browser never applies the requested bounds", async () => {
    vi.useFakeTimers();
    const h = harness();
    h.windows.update.mockImplementation(async () => ({ ...h.window, width: 1000, height: 700 }));
    const result = h.controller.dispatch("resize_window", { windowId: 9, width: 1000, height: 700 }, new Set([7]));
    const failure = expect(result).rejects.toMatchObject({ code: "window_resize_unconfirmed", outcomeUnknown: true });
    await vi.advanceTimersByTimeAsync(1_001);
    await failure;
  });

  it("presses the drag source before resolving a destination that may scroll", async () => {
    const h = harness();
    await h.controller.dispatch("computer", { tabId: 7, action: "drag", pageRef: "p1-start", toPageRef: "p1-end" }, new Set([7]));
    expect(h.trace.indexOf("mousePressed")).toBeLessThan(h.trace.indexOf("resolve:p1-end"));
    expect(h.trace.at(-1)).toBe("mouseReleased");
  });

  it("releases the pointer and reports unknown effects when a drag target becomes stale", async () => {
    const h = harness();
    h.scripting.executeScript.mockImplementation(async args => [{ result: args.args?.[0] === "p1-start" ? { x: 20, y: 40 } : null }]);
    await expect(h.controller.dispatch("computer", { tabId: 7, action: "drag", pageRef: "p1-start", toPageRef: "p1-end" }, new Set([7])))
      .rejects.toMatchObject({ code: "stale_page_ref", outcomeUnknown: true });
    expect(h.trace.at(-1)).toBe("mouseReleased");
  });
});
