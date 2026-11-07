import { describe, expect, it } from "vitest";
import { RELEASED_TAB_TTL_MS, adoptableOpenTab, adoptableTabs, orphanBlankTabsToClose, releasedTabsToClose, reusableReleasedTab, shouldRecordAgentTab } from "../src/adoption";

const records = {
  "1": { hostId: "studio", label: "Surat Jalan" },
  "2": { hostId: "studio", label: "Surat Jalan" },
  "3": { hostId: "studio", label: "Other work" },
  "4": { hostId: "codex", label: "Surat Jalan" },
  "5": { hostId: "studio" }
};

describe("adoptableTabs", () => {
  it("returns open agent tabs from the same host and label that no live session holds", () => {
    expect(adoptableTabs(records, { hostId: "studio", label: "Surat Jalan" }, new Set([2]), new Set([1, 2, 3, 4, 5]))).toEqual([1]);
  });

  it("adopts nothing for an unlabelled session, a closed tab, or another host", () => {
    expect(adoptableTabs(records, { hostId: "studio" }, new Set(), new Set([1, 5]))).toEqual([]);
    expect(adoptableTabs(records, { hostId: "studio", label: "Surat Jalan" }, new Set(), new Set([3]))).toEqual([]);
    expect(adoptableTabs(records, { hostId: "other", label: "Surat Jalan" }, new Set(), new Set([1, 2, 4]))).toEqual([]);
  });
});

describe("adoptableOpenTab", () => {
  const options = {
    records: { "9": { hostId: "other" } },
    liveControlled: new Set<number>(),
    sessionControlled: new Set<number>(),
    matches: (url: string) => url === "http://localhost:5180/a"
  };
  const tab = (overrides: Record<string, unknown> = {}) => ({
    id: 1, url: "http://localhost:5180/a", windowId: 1, ...overrides
  });

  it("takes an open tab at the URL, preferring the active tab of the focused window", () => {
    const tabs = [
      tab({ id: 1, lastAccessed: 10 }),
      tab({ id: 2, windowId: 2, active: true, lastAccessed: 5 }),
      tab({ id: 3, url: "http://localhost:5180/b" })
    ];
    expect(adoptableOpenTab(tabs, { ...options, focusedWindowId: 2 })).toBe(2);
    expect(adoptableOpenTab(tabs, { ...options, focusedWindowId: 1 })).toBe(1);
    expect(adoptableOpenTab([tab({ id: 1, lastAccessed: 1 }), tab({ id: 2, lastAccessed: 2 })], options)).toBe(2);
  });

  it("never takes a tab a live session or this session holds, a recorded tab, a pinned or incognito tab, or one outside the window", () => {
    expect(adoptableOpenTab([tab()], { ...options, liveControlled: new Set([1]) })).toBeUndefined();
    expect(adoptableOpenTab([tab()], { ...options, sessionControlled: new Set([1]) })).toBeUndefined();
    expect(adoptableOpenTab([tab({ id: 9 })], options)).toBeUndefined();
    expect(adoptableOpenTab([tab({ pinned: true })], options)).toBeUndefined();
    expect(adoptableOpenTab([tab({ incognito: true })], options)).toBeUndefined();
    expect(adoptableOpenTab([tab({ url: "http://localhost:5180/b" })], options)).toBeUndefined();
    expect(adoptableOpenTab([tab({ windowId: 2 })], { ...options, windowIds: new Set([1]) })).toBeUndefined();
  });
});

describe("adoptableOpenTab edge cases", () => {
  const options = {
    records: {},
    liveControlled: new Set<number>(),
    sessionControlled: new Set<number>(),
    matches: (url: string) => url === "http://localhost:5180/a"
  };
  const tab = (overrides: Record<string, unknown> = {}) => ({ id: 1, url: "http://localhost:5180/a", windowId: 1, ...overrides });

  it("allows any window when the session has none, and breaks ties by lowest id", () => {
    expect(adoptableOpenTab([tab({ windowId: 7 })], options)).toBe(1);
    expect(adoptableOpenTab([
      tab({ id: 4, lastAccessed: 5 }),
      tab({ id: 3, lastAccessed: 5 })
    ], options)).toBe(3);
  });

  it("excludes a tab with no id and any tab the connector already recorded", () => {
    expect(adoptableOpenTab([{ url: "http://localhost:5180/a", windowId: 1 }], options)).toBeUndefined();
    expect(adoptableOpenTab([tab()], { ...options, records: { "1": { hostId: "codex" } } })).toBeUndefined();
  });

  it("returns undefined when nothing matches", () => {
    expect(adoptableOpenTab([], options)).toBeUndefined();
    expect(adoptableOpenTab([tab({ url: "http://localhost:5180/b" })], options)).toBeUndefined();
  });
});

describe("agent tab recording", () => {
  it("records only a tab the agent created", () => {
    expect(shouldRecordAgentTab({ reused: false, tabId: 4 })).toBe(true);
    expect(shouldRecordAgentTab({ reused: true, tabId: 4 })).toBe(false);
    expect(shouldRecordAgentTab({ reused: true, adopted: true, tabId: 4 })).toBe(false);
    expect(shouldRecordAgentTab({ reused: false })).toBe(false);
    expect(shouldRecordAgentTab(null)).toBe(false);
  });
});

describe("orphan blank sweep", () => {
  const options = {
    liveControlled: new Set<number>(),
    focusedWindowIds: new Set([1]),
    connectorTitlePrefix: "🔌"
  };
  const tab = (overrides: Record<string, unknown> = {}) => ({
    id: 1, url: "about:blank", windowId: 1, groupTitle: "🔌 work", ...overrides
  });

  it("closes only a blank in a connector group that nobody holds or is looking at", () => {
    expect(orphanBlankTabsToClose([tab()], options)).toEqual([1]);
    expect(orphanBlankTabsToClose([tab({ url: undefined, pendingUrl: "chrome://newtab/" })], options)).toEqual([1]);
    expect(orphanBlankTabsToClose([tab({ groupTitle: "Personal" })], options)).toEqual([]);
    expect(orphanBlankTabsToClose([tab({ pinned: true })], options)).toEqual([]);
    expect(orphanBlankTabsToClose([tab()], { ...options, liveControlled: new Set([1]) })).toEqual([]);
    expect(orphanBlankTabsToClose([tab({ active: true })], options)).toEqual([]);
    expect(orphanBlankTabsToClose([tab({ url: "https://example.com/" })], options)).toEqual([]);
    expect(orphanBlankTabsToClose([tab()], { ...options, agentCreated: new Set([2]) })).toEqual([]);
    expect(orphanBlankTabsToClose([tab()], { ...options, agentCreated: new Set([1]) })).toEqual([1]);
    expect(orphanBlankTabsToClose([], options)).toEqual([]);
  });
});

describe("released agent tabs", () => {
  const records = {
    "1": { hostId: "opencode", releasedAt: 0 },
    "2": { hostId: "opencode", releasedAt: 0 },
    "3": { hostId: "codex", releasedAt: 0 },
    "4": { hostId: "opencode" }
  };

  it("a new session reuses a released tab of the same host that already shows the URL", () => {
    const open = [{ id: 1, url: "http://localhost:5180/a" }, { id: 2, url: "http://localhost:5180/b" }, { id: 3, url: "http://localhost:5180/b" }, { id: 9, url: "http://localhost:5180/b" }];
    const same = (target: string) => (url: string) => url === target;
    expect(reusableReleasedTab(records, "opencode", new Set(), open, same("http://localhost:5180/b"))).toBe(2);
    expect(reusableReleasedTab(records, "opencode", new Set([2]), open, same("http://localhost:5180/b"))).toBeUndefined();
    expect(reusableReleasedTab(records, "codex", new Set(), open, same("http://localhost:5180/a"))).toBeUndefined();
    expect(reusableReleasedTab(records, "opencode", new Set(), [{ id: 1, url: "http://localhost:5180/a", pinned: true }], same("http://localhost:5180/a"))).toBeUndefined();
    expect(reusableReleasedTab(records, "opencode", new Set(), [{ id: 1, url: "http://localhost:5180/a", incognito: true }], same("http://localhost:5180/a"))).toBeUndefined();
  });

  it("closes released agent tabs after ten minutes, never one in view, moved out of the group, still held, or never released", () => {
    const later = RELEASED_TAB_TTL_MS;
    const released = (extra: Record<string, unknown> = {}) => ({ hostId: "opencode", releasedAt: 0, groupId: 5, ...extra });
    const closingRecords = {
      "1": released(), "2": released(), "3": released(), "4": released({ releasedAt: undefined }),
      "5": released(), "6": released(), "7": released(), "8": released()
    };
    const open = [
      { id: 1, groupId: 5 },
      { id: 2, groupId: 5, active: true },
      { id: 3, groupId: 5 },
      { id: 4, groupId: 5 },
      { id: 5, groupId: 6 },
      { id: 6, groupId: 5, pinned: true },
      { id: 7, groupId: 5, audible: true },
      { id: 8, groupId: 5, incognito: true },
      { id: 9, groupId: 5 }
    ];
    expect(releasedTabsToClose(closingRecords, later, new Set(), open)).toEqual([1, 3]);
    expect(releasedTabsToClose(closingRecords, later - 1, new Set(), open)).toEqual([]);
    expect(releasedTabsToClose(closingRecords, later, new Set([1]), open)).toEqual([3]);
  });
});
