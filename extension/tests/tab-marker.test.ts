import { afterEach, describe, expect, it, vi } from "vitest";
import { MARK_SENTINEL, TabMarkers, injectedMarkIcon, injectedOriginalIcon, injectedRestoreIcons, markedIcon } from "../src/tab-marker";

function chromeMock() {
  const executeScript = vi.fn(async (call: any) => [{ result: call.func === injectedOriginalIcon ? `https://example.test/${call.target.tabId}.svg` : undefined }]);
  vi.stubGlobal("chrome", {
    tabs: { get: vi.fn(async (tabId: number) => ({ id: tabId, favIconUrl: `https://example.test/${tabId}.ico` })), onRemoved: { addListener: vi.fn() }, onUpdated: { addListener: vi.fn() } },
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
    expect(executeScript.mock.calls.filter(([call]: any) => call.func === injectedMarkIcon).map(([call]: any) => [call.target.tabId, call.args?.[0]])).toEqual([
      [1, "data:image/png;base64,https://example.test/1.svg"],
      [2, "data:image/png;base64,https://example.test/2.svg"],
    ]);
    await markers.clear([1, 3]);
    expect((executeScript.mock.calls.at(-1) as unknown[] | undefined)?.[0]).toMatchObject({ target: { tabId: 1 }, func: injectedRestoreIcons });
    expect(executeScript).toHaveBeenCalledTimes(5);
  });

  it("never fails the tool call when a page cannot be marked", async () => {
    chromeMock().mockRejectedValue(new Error("Cannot access a chrome:// URL"));
    await expect(new TabMarkers(async () => "data:").sync([9])).resolves.toBeUndefined();
  });
});

describe("markedIcon", () => {
  it("embeds the page's own icon under the cursor badge", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new Blob(["<svg/>"], { type: "image/svg+xml" }))));
    const svg = decodeURIComponent((await markedIcon("https://example.test/icon.svg")).split(",")[1]!);
    expect(svg).toContain(`data-${MARK_SENTINEL}`);
    expect(svg).toContain(`<image href="data:image/svg+xml;base64,${btoa("<svg/>")}"`);
    expect(svg).toContain("<path");
  });

  it("never embeds its own mark and falls back to a tile when the icon is unreachable", async () => {
    const fetch = vi.fn(async () => new Response("", { status: 404 }));
    vi.stubGlobal("fetch", fetch);
    expect(decodeURIComponent((await markedIcon("https://example.test/missing.ico")).split(",")[1]!)).toContain("<rect");
    expect(await markedIcon("x")).toContain(MARK_SENTINEL);
    await markedIcon(await markedIcon("x"));
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
