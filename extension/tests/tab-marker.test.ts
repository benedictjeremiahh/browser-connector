import { afterEach, describe, expect, it, vi } from "vitest";
import { TabMarkers, injectedMarkIcon, injectedRestoreIcons } from "../src/tab-marker";

function chromeMock() {
  const executeScript = vi.fn(async (_call: unknown) => [{ result: undefined }]);
  vi.stubGlobal("chrome", {
    tabs: { get: vi.fn(async (tabId: number) => ({ id: tabId, favIconUrl: `https://example.test/${tabId}.ico` })), onRemoved: { addListener: vi.fn() } },
    webNavigation: { onCompleted: { addListener: vi.fn() } },
    scripting: { executeScript },
  });
  return executeScript;
}

afterEach(() => vi.unstubAllGlobals());

describe("TabMarkers", () => {
  it("marks each controlled tab once and restores it when control ends", async () => {
    const executeScript = chromeMock();
    const markers = new TabMarkers(async (url) => `data:image/png;base64,${url}`);
    await markers.sync(new Set([1, 2]));
    await markers.sync(new Set([1, 2]));
    expect(executeScript.mock.calls.map(([call]: any) => [call.target.tabId, call.func, call.args?.[0]])).toEqual([
      [1, injectedMarkIcon, "data:image/png;base64,https://example.test/1.ico"],
      [2, injectedMarkIcon, "data:image/png;base64,https://example.test/2.ico"],
    ]);
    await markers.clear([1, 3]);
    expect((executeScript.mock.calls.at(-1) as unknown[] | undefined)?.[0]).toMatchObject({ target: { tabId: 1 }, func: injectedRestoreIcons });
    expect(executeScript).toHaveBeenCalledTimes(3);
  });

  it("never fails the tool call when a page cannot be marked", async () => {
    chromeMock().mockRejectedValue(new Error("Cannot access a chrome:// URL"));
    await expect(new TabMarkers(async () => "data:").sync([9])).resolves.toBeUndefined();
  });
});
