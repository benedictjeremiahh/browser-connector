import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserController } from "../src/browser";

function event() {
  return { addListener: vi.fn(), removeListener: vi.fn() };
}

interface FakeTab {
  id: number;
  windowId: number;
  url?: string;
  pendingUrl?: string;
  title?: string;
  active?: boolean;
  pinned?: boolean;
  incognito?: boolean;
  groupId?: number;
  favIconUrl?: string;
}

/* A small Chrome stand-in: just the tab, group and scripting calls these paths make. */
function harness(initial: FakeTab[]) {
  const tabs = new Map(initial.map(tab => [tab.id, { ...tab }]));
  const created: Array<{ url?: string; active?: boolean }> = [];
  const updates: Array<[number, Record<string, unknown>]> = [];
  const grouped: Array<[number, number | undefined]> = [];
  const api = {
    onRemoved: event(),
    onUpdated: event(),
    get: vi.fn(async (tabId: number) => {
      const tab = tabs.get(tabId);
      if (!tab) throw new Error(`No tab ${tabId}`);
      return { ...tab };
    }),
    query: vi.fn(async () => [...tabs.values()].map(tab => ({ ...tab }))),
    create: vi.fn(async (args: { url?: string; active?: boolean }) => {
      created.push(args);
      const tab: FakeTab = {
        id: 100 + created.length - 1,
        windowId: 9,
        url: args.url,
        title: "",
        active: args.active ?? true,
        pinned: false,
        incognito: false,
        groupId: -1
      };
      tabs.set(tab.id, tab);
      return { ...tab };
    }),
    update: vi.fn(async (tabId: number, args: Record<string, unknown>) => {
      updates.push([tabId, args]);
      const tab = tabs.get(tabId);
      if (!tab) throw new Error(`No tab ${tabId}`);
      if (typeof args.url === "string") tab.url = args.url;
      if (typeof args.active === "boolean") tab.active = args.active;
      return { ...tab };
    }),
    group: vi.fn(async (args: { tabIds: number[]; groupId?: number }) => {
      grouped.push([args.tabIds[0]!, args.groupId]);
      return args.groupId ?? 99;
    }),
    remove: vi.fn(async () => undefined)
  };
  const tabGroups = { update: vi.fn(async () => ({})) };
  vi.stubGlobal("chrome", {
    tabs: api,
    tabGroups,
    windows: {
      getLastFocused: vi.fn(async () => ({ id: 9 })),
      getAll: vi.fn(async () => [{ id: 9, focused: true }]),
      get: vi.fn(async () => ({ id: 9, state: "normal", width: 1200, height: 900 }))
    },
    webNavigation: { onCommitted: event(), onCompleted: event() },
    debugger: { onEvent: event(), onDetach: event(), attach: vi.fn(), sendCommand: vi.fn() },
    scripting: { executeScript: vi.fn(async () => [{ result: undefined }]) }
  });
  return { controller: new BrowserController(), api, tabGroups, created, updates, grouped, tabs };
}

afterEach(() => vi.unstubAllGlobals());

describe("tab creation", () => {
  it("never creates a tab from tabs_context, even when an older caller asks it to", async () => {
    const h = harness([]);
    const result = await h.controller.dispatch("tabs_context", { createIfEmpty: true }, new Set()) as { tabs: unknown[]; hint?: string };

    expect(h.api.create).not.toHaveBeenCalled();
    expect(result.tabs).toEqual([]);
    expect(result.hint).toContain("tabs_create");
  });

  it("navigates a controlled background blank instead of opening a second tab", async () => {
    const h = harness([{ id: 7, windowId: 9, url: "about:blank", active: false }]);
    const controlled = new Set([7]);
    const result = await h.controller.dispatch(
      "tabs_create",
      { url: "http://localhost:5180/a", settle: false },
      controlled
    ) as { tabId: number; reused: boolean; reusedBlank: boolean };

    expect(h.api.create).not.toHaveBeenCalled();
    expect(h.updates).toContainEqual([7, { url: "http://localhost:5180/a", active: false }]);
    expect(result).toMatchObject({ tabId: 7, reused: true, reusedBlank: true });
    expect([...controlled]).toEqual([7]);
  });

  it("does not navigate an active blank that may be the person's", async () => {
    const h = harness([{ id: 7, windowId: 9, url: "about:blank", active: true }]);
    await h.controller.dispatch(
      "tabs_create",
      { url: "http://localhost:5180/a", settle: false },
      new Set([7])
    );

    expect(h.api.update).not.toHaveBeenCalledWith(7, expect.objectContaining({ url: "http://localhost:5180/a" }));
    expect(h.api.create).toHaveBeenCalledWith({ url: "http://localhost:5180/a", active: false });
  });

  it("reuses a controlled blank when tabs_create is called without a URL", async () => {
    const h = harness([{ id: 7, windowId: 9, url: "about:blank", active: false }]);
    const result = await h.controller.dispatch("tabs_create", {}, new Set([7])) as { tabId: number; reusedBlank: boolean };

    expect(h.api.create).not.toHaveBeenCalled();
    expect(result).toMatchObject({ tabId: 7, reusedBlank: true });
  });

  it("returns the controlled tab already at the URL before a controlled blank", async () => {
    const h = harness([
      { id: 1, windowId: 9, url: "http://localhost:5180/a", active: false },
      { id: 2, windowId: 9, url: "about:blank", active: false }
    ]);
    const result = await h.controller.dispatch(
      "tabs_create",
      { url: "http://localhost:5180/a", settle: false },
      new Set([1, 2])
    ) as { tabId: number; reused: boolean };

    expect(result).toMatchObject({ tabId: 1, reused: true });
    expect(result).not.toHaveProperty("reusedBlank");
    expect(h.api.update).not.toHaveBeenCalled();
    expect(h.api.create).not.toHaveBeenCalled();
  });

  it("reuses a chrome://newtab tab, including one that has not committed yet", async () => {
    const h = harness([{ id: 7, windowId: 9, url: undefined, pendingUrl: "chrome://newtab/", active: false }]);
    const result = await h.controller.dispatch(
      "tabs_create",
      { url: "http://localhost:5180/a", settle: false },
      new Set([7])
    ) as { tabId: number; reusedBlank: boolean };

    expect(result).toMatchObject({ tabId: 7, reusedBlank: true });
    expect(h.api.create).not.toHaveBeenCalled();
  });

  it("falls back to creating when navigating the blank fails", async () => {
    const h = harness([{ id: 7, windowId: 9, url: "about:blank", active: false }]);
    h.api.update.mockRejectedValueOnce(new Error("No tab with id: 7"));
    const result = await h.controller.dispatch(
      "tabs_create",
      { url: "http://localhost:5180/a", settle: false },
      new Set([7])
    ) as { tabId: number; reused: boolean };

    expect(h.api.create).toHaveBeenCalledWith({ url: "http://localhost:5180/a", active: false });
    expect(result).toMatchObject({ tabId: 100, reused: false });
  });

  it("moves a tab into a new session group instead of taking over the group it is in", async () => {
    const h = harness([{ id: 7, windowId: 9, url: "http://localhost:5180/a", active: false, groupId: 42 }]);
    await h.controller.ensureTabGroup({ key: "session", label: "🔌 work", color: "blue" }, 7);

    expect(h.grouped[0]).toEqual([7, undefined]);
    expect(h.tabGroups.update).toHaveBeenCalledWith(99, expect.objectContaining({ title: "🔌 work" }));
    expect(h.tabGroups.update).not.toHaveBeenCalledWith(42, expect.anything());
  });

  it("opens a background tab in the group when neither a URL match nor a blank exists", async () => {
    const h = harness([]);
    const controlled = new Set<number>();
    const result = await h.controller.dispatch(
      "tabs_create",
      { url: "http://localhost:5180/a", settle: false },
      controlled
    ) as { tabId: number; reused: boolean };

    expect(h.api.create).toHaveBeenCalledWith({ url: "http://localhost:5180/a", active: false });
    expect(result).toMatchObject({ tabId: 100, reused: false });
    expect([...controlled]).toEqual([100]);
    expect(h.grouped[0]?.[0]).toBe(100);
    expect(h.tabGroups.update).toHaveBeenCalledWith(99, expect.objectContaining({ title: expect.any(String) }));
  });
});
