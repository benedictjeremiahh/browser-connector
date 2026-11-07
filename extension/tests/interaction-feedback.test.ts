import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserController } from "../src/browser";

function event() {
  return { addListener: vi.fn(), removeListener: vi.fn() };
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
});
