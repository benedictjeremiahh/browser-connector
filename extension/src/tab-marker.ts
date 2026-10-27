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
    /* A page may announce its icon after load; re-mark when Chrome reports an icon that is not ours. */
    chrome.tabs?.onUpdated?.addListener((tabId, change) => {
      if (change.favIconUrl && !change.favIconUrl.includes(MARK_SENTINEL) && this.marked.has(tabId)) void this.apply(tabId);
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
      /* The page's declared icon is the original; Chrome's favIconUrl may already be our mark. */
      const [declared] = await chrome.scripting.executeScript({ target: { tabId }, func: injectedOriginalIcon });
      const known = tab.favIconUrl && !tab.favIconUrl.includes(MARK_SENTINEL) ? tab.favIconUrl : undefined;
      const icon = await this.buildIcon(typeof declared?.result === "string" ? declared.result : known);
      await chrome.scripting.executeScript({ target: { tabId }, func: injectedMarkIcon, args: [icon] });
    } catch { /* restricted pages (chrome://, the Web Store) keep their icon; the tab group still shows control */ }
  }
}

/* The badge is a pointer with the connector's blue dot: the pointer reads as "something is
   driving this", the dot ties it to the connector's colour. Both carry a white edge so they
   stay legible over any icon, light or dark. */
const CURSOR_BADGE = `<g transform="translate(17.5 15) scale(0.78)">`
  + `<path d="M0 0v15.5l4-3.9 2.8 6.1 3-1.3-2.8-6h5.8z" fill="#202124" stroke="#ffffff" stroke-width="2" stroke-linejoin="round"/></g>`
  + `<circle cx="27" cy="27" r="4.5" fill="#ffffff"/><circle cx="27" cy="27" r="3.2" fill="${MARK_COLOR}"/>`;

/* Identifies an icon the connector drew, so its own favicon is never mistaken for the page's. */
export const MARK_SENTINEL = "browser-connector-mark";

/* The page's own icon is embedded, not decoded: an SVG wrapper shows any format the browser
   can show (SVG, ICO, PNG) without a worker-side decoder, and the cursor overlays it. The
   service worker fetches it under its host permissions, so no cross-origin page canvas is
   involved. Anything that cannot be fetched falls back to a neutral tile. */
export async function markedIcon(favIconUrl: string | undefined): Promise<string> {
  let original = `<rect x="3" y="3" width="26" height="26" rx="6" fill="#9aa0a6"/>`;
  if (favIconUrl && /^(?:https?|data):/i.test(favIconUrl) && !favIconUrl.includes(MARK_SENTINEL)) {
    try {
      const response = await fetch(favIconUrl);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const blob = await response.blob();
      if (!blob.size || blob.size > 256 * 1024) throw new Error("Unusable icon");
      original = `<image href="${await dataUrl(blob)}" width="${SIZE}" height="${SIZE}" preserveAspectRatio="xMidYMid meet"/>`;
    } catch { /* unreachable or oversized: the neutral tile still carries the mark */ }
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}" data-${MARK_SENTINEL}="">${original}${CURSOR_BADGE}</svg>`;
  /* Percent-encoded rather than base64, so the sentinel stays readable in Chrome's favIconUrl. */
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

async function dataUrl(blob: Blob): Promise<string> {
  return `data:${blob.type || "image/x-icon"};base64,${base64(new Uint8Array(await blob.arrayBuffer()))}`;
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/* Runs in the page's isolated world: the icon the page itself declares, active or disabled by a
   previous mark, else the conventional /favicon.ico. */
export function injectedOriginalIcon(): string | undefined {
  const link = document.querySelector<HTMLLinkElement>("link[rel~='icon']:not([data-browser-connector-mark]), link[data-browser-connector-rel]");
  if (link?.href) return link.href;
  return /^https?:$/.test(location.protocol) ? `${location.origin}/favicon.ico` : undefined;
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
