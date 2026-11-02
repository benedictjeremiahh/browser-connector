import { describe, expect, it } from "vitest";
import { RELEASED_TAB_TTL_MS, adoptableTabs, releasedTabsToClose, reusableReleasedTab } from "../src/adoption";

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
  });

  it("closes released agent tabs after ten minutes, never one in view, moved out of the group, still held, or never released", () => {
    const later = RELEASED_TAB_TTL_MS;
    const open = [
      { id: 1, grouped: true, inView: false },
      { id: 2, grouped: true, inView: true },
      { id: 3, grouped: false, inView: false },
      { id: 4, grouped: true, inView: false },
      { id: 9, grouped: true, inView: false }
    ];
    expect(releasedTabsToClose(records, later, new Set(), open)).toEqual([1]);
    expect(releasedTabsToClose(records, later - 1, new Set(), open)).toEqual([]);
    expect(releasedTabsToClose(records, later, new Set([1]), open)).toEqual([]);
  });
});
