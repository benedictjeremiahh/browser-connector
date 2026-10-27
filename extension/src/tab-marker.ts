/* A Controlled Tab carries a visible mark on its own favicon, so a person can tell which
   tabs an agent holds even while the work happens in the background (ADR-0024). The
   mark is drawn by the extension, never by the page, and the page's own icons come back
   when the lease ends. */

const SIZE = 32;
const MARK_COLOR = "#1a73e8";

export class TabMarkers {
  private marked = new Set<number>();
  private readonly buildIcon: (favIconUrl: string | undefined) => Promise<string>;

  constructor(buildIcon: (favIconUrl: string | undefined) => Promise<string> = markedIcon) {
    this.buildIcon = buildIcon;
    chrome.webNavigation?.onCompleted?.addListener(({ tabId, frameId }) => {
      if (frameId === 0 && this.marked.has(tabId)) void this.apply(tabId);
    });
    chrome.tabs?.onRemoved?.addListener((tabId) => this.marked.delete(tabId));
  }

  /* Marks every newly controlled tab once; navigation re-applies the mark. */
  async sync(tabIds: Iterable<number>): Promise<void> {
    for (const tabId of tabIds) {
      if (this.marked.has(tabId)) continue;
      this.marked.add(tabId);
      await this.apply(tabId);
    }
  }

  async clear(tabIds: Iterable<number>): Promise<void> {
    for (const tabId of tabIds) {
      if (!this.marked.delete(tabId)) continue;
      try { await chrome.scripting.executeScript({ target: { tabId }, func: injectedRestoreIcons }); } catch { /* tab gone or restricted */ }
    }
  }

  private async apply(tabId: number): Promise<void> {
    try {
      const tab = await chrome.tabs.get(tabId);
      const icon = await this.buildIcon(tab.favIconUrl);
      await chrome.scripting.executeScript({ target: { tabId }, func: injectedMarkIcon, args: [icon] });
    } catch { /* restricted pages (chrome://, the Web Store) keep their icon; the tab group still shows control */ }
  }
}

/* The service worker may fetch any favicon under its host permissions, so the original
   icon is composed here rather than in the page, where a cross-origin icon would taint
   the canvas. Anything that cannot be drawn falls back to a neutral tile. */
export async function markedIcon(favIconUrl: string | undefined): Promise<string> {
  const canvas = new OffscreenCanvas(SIZE, SIZE);
  const context = canvas.getContext("2d");
  if (!context) throw new Error("No 2D context");
  let drawn = false;
  if (favIconUrl && /^(?:https?|data):/i.test(favIconUrl)) {
    try {
      const bitmap = await createImageBitmap(await (await fetch(favIconUrl)).blob());
      context.drawImage(bitmap, 0, 0, SIZE, SIZE);
      drawn = true;
    } catch { /* unsupported format or unreachable */ }
  }
  if (!drawn) {
    context.fillStyle = "#9aa0a6";
    context.beginPath();
    context.roundRect(4, 4, SIZE - 8, SIZE - 8, 6);
    context.fill();
  }
  context.beginPath();
  context.arc(SIZE - 8, SIZE - 8, 7.5, 0, Math.PI * 2);
  context.fillStyle = "#ffffff";
  context.fill();
  context.beginPath();
  context.arc(SIZE - 8, SIZE - 8, 5.5, 0, Math.PI * 2);
  context.fillStyle = MARK_COLOR;
  context.fill();
  const bytes = new Uint8Array(await (await canvas.convertToBlob({ type: "image/png" })).arrayBuffer());
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `data:image/png;base64,${btoa(binary)}`;
}

/* Runs in the page's isolated world. Page icons are disabled, not deleted, so they can be restored exactly. */
export function injectedMarkIcon(dataUrl: string): void {
  for (const link of Array.from(document.querySelectorAll<HTMLLinkElement>("link[rel~='icon']"))) {
    if (link.hasAttribute("data-browser-connector-mark")) continue;
    link.setAttribute("data-browser-connector-rel", link.getAttribute("rel") ?? "icon");
    link.setAttribute("rel", "browser-connector-original-icon");
  }
  let mark = document.querySelector<HTMLLinkElement>("link[data-browser-connector-mark]");
  if (!mark) {
    mark = document.createElement("link");
    mark.setAttribute("data-browser-connector-mark", "");
    mark.rel = "icon";
    (document.head ?? document.documentElement).append(mark);
  }
  mark.href = dataUrl;
}

export function injectedRestoreIcons(): void {
  document.querySelector("link[data-browser-connector-mark]")?.remove();
  for (const link of Array.from(document.querySelectorAll<HTMLLinkElement>("link[data-browser-connector-rel]"))) {
    link.setAttribute("rel", link.getAttribute("data-browser-connector-rel") ?? "icon");
    link.removeAttribute("data-browser-connector-rel");
  }
}
