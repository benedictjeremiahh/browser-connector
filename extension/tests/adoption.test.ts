import { describe, expect, it } from "vitest";
import { adoptableTabs } from "../src/adoption";

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
