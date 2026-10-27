import { TabMarkers } from "./tab-marker";
import {
  boundedText,
  clampLimit,
  exactOrigin,
  isRestrictedUrl,
  redactUrl,
  sameNavigationTarget
} from "./policy";
import type { GroupColor } from "./naming";

interface ConsoleRecord {
  timestamp: number;
  level: string;
  text: string;
  url?: string;
}

interface NetworkRecord {
  timestamp: number;
  requestId: string;
  method: string;
  url: string;
  status?: number;
  resourceType?: string;
  mimeType?: string;
}

export interface PageRefContext {
  description: string;
  destinationOrigin?: string;
}

export interface GroupDescriptor {
  key: string;
  label: string;
  color?: GroupColor;
}

export interface Region {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type CursorMode = "hover" | "move" | "click" | "drag" | "type" | "key" | "scroll";

const CURSOR_LABELS: Record<CursorMode, string> = {
  hover: "Hover",
  move: "Move",
  click: "Click",
  drag: "Drag",
  type: "Type",
  key: "Key",
  scroll: "Scroll"
};

const DEFAULT_GROUP: GroupDescriptor = { key: "", label: "🔌 Browser Connector" };

const MAX_LOG_RECORDS = 2_000;
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const MAX_DOWNLOAD_BYTES = 10 * 1024 * 1024;
const MAX_RESPONSE_BODY_BYTES = 256 * 1024;
/* Distance the pointer glides before the button goes down, so a person watching
   can follow the mark instead of seeing it appear already clicked. */
const CLICK_DWELL_MS = 200;
/* Intermediate mouseMoved events: HTML5 drag-and-drop and sortable lists ignore a
   press and release with nothing in between. */
const DRAG_STEPS = 8;

/* The mark drawn where the agent is about to act. One string so the injected
   script stays a single Runtime.evaluate call.
   The arrow glides to its target with a CSS transition and three lagging ghost
   dots trail behind it; the label names the action, and the ring pings on click.
   Reduced motion turns the transitions and animations off and leaves a static
   mark, which is what someone who asked their OS for less motion still needs. */
const CURSOR_MARKUP = [
  "<style>",
  ".arrow{position:absolute;left:0;top:0;transform-origin:0 0;filter:drop-shadow(0 1px 2px rgba(0,0,0,.45));transition:transform .22s cubic-bezier(.22,.7,.3,1)}",
  ".ghost{position:absolute;left:0;top:0;width:9px;height:9px;margin:-4.5px 0 0 -4.5px;border-radius:50%;background:#3b82f6;opacity:.4;transition:transform .3s cubic-bezier(.22,.7,.3,1)}",
  ".ghost.g2{transition-delay:.05s;opacity:.26}",
  ".ghost.g3{transition-delay:.1s;opacity:.14}",
  ".ring{position:absolute;left:0;top:0}",
  ".ping{width:34px;height:34px;margin:-17px 0 0 -17px;border-radius:50%;border:2px solid #3b82f6;opacity:0}",
  ".ping.on{animation:bc-ping .6s cubic-bezier(.2,.7,.3,1)}",
  ".label{position:absolute;left:16px;top:-30px;font:600 11px/1.7 -apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;letter-spacing:.02em;color:#fff;background:#111827;border:1px solid rgba(255,255,255,.22);border-radius:999px;padding:1px 9px;white-space:nowrap;opacity:0}",
  ".label.on{animation:bc-label 1.5s ease-out}",
  "@keyframes bc-ping{from{opacity:.9;transform:scale(.3)}to{opacity:0;transform:scale(1.7)}}",
  /* The chip is offset with left/top, never with transform: the script positions
     every part of the mark by writing transform, and a transform inside this
     animation would override it and park the chip at the viewport origin. */
  "@keyframes bc-label{0%{opacity:0}12%{opacity:1}70%{opacity:1}100%{opacity:0}}",
  "@media (prefers-reduced-motion:reduce){.arrow,.ghost{transition:none}.ping.on{animation:none}.label{opacity:1}.label.on{animation:none}}",
  "</style>",
  '<div class="ghost g1"></div><div class="ghost g2"></div><div class="ghost g3"></div>',
  '<div class="ring"><div class="ping"></div></div>',
  '<div class="label"></div>',
  '<svg class="arrow" width="22" height="22" viewBox="0 0 22 22" aria-hidden="true"><path d="M1 1 L1 17.4 L5.5 13.4 L8.8 20.2 L11.5 18.9 L8.2 12.1 L14.4 12.1 Z" fill="#111827" stroke="#ffffff" stroke-width="1.3" stroke-linejoin="round"/></svg>'
].join("");

export class BrowserController {
  private attachedTabs = new Set<number>();
  /* A requested viewport survives a debugger re-attach; it ends with the tab or its lease. */
  private viewports = new Map<number, { width: number; height: number; mobile: boolean }>();
  private documentGenerations = new Map<number, number>();
  private consoleRecords = new Map<number, ConsoleRecord[]>();
  private networkRecords = new Map<number, NetworkRecord[]>();
  /* Keyed by the session, not by the title: an agent may rename its session at any time, and
     a title-keyed map would lose the group and start a second one on every rename. */
  private groupIds = new Map<string, number>();
  /* Where the mark last acted, so a keystroke or a scroll can label itself at the
     place the person is already looking, without needing coordinates of its own. */
  private lastPoints = new Map<number, { x: number; y: number }>();
  private markers = new TabMarkers();

  constructor() {
    chrome.webNavigation.onCommitted.addListener(({ tabId, frameId }) => {
      if (frameId === 0) this.documentGenerations.set(tabId, (this.documentGenerations.get(tabId) ?? 0) + 1);
    });
    chrome.tabs.onRemoved.addListener((tabId) => {
      this.attachedTabs.delete(tabId);
      this.documentGenerations.delete(tabId);
      this.consoleRecords.delete(tabId);
      this.networkRecords.delete(tabId);
      this.lastPoints.delete(tabId);
      this.viewports.delete(tabId);
    });
    chrome.debugger.onEvent.addListener((source, method, params) => this.onDebuggerEvent(source.tabId, method, params));
    chrome.debugger.onDetach.addListener((source) => {
      if (source.tabId !== undefined) this.attachedTabs.delete(source.tabId);
    });
  }

  /* Every call re-syncs the favicon marks, so a tab is marked however it became controlled. */
  async dispatch(method: string, params: Record<string, unknown>, controlledTabIds: Set<number>, group: GroupDescriptor = DEFAULT_GROUP): Promise<unknown> {
    const result = await this.dispatchMethod(method, params, controlledTabIds, group);
    await this.markers.sync(controlledTabIds).catch(() => undefined);
    return result;
  }

  private async dispatchMethod(method: string, params: Record<string, unknown>, controlledTabIds: Set<number>, group: GroupDescriptor): Promise<unknown> {
    switch (method) {
      case "tabs_context": return this.tabsContext(controlledTabIds, params.createIfEmpty === true, group);
      case "tabs_create": return this.tabsCreate(controlledTabIds, asOptionalString(params.url), group);
      case "tabs_activate": return this.tabsActivate(asTabId(params.tabId), controlledTabIds);
      case "tabs_close": return this.tabsClose(controlledTabIds, asTabId(params.tabId));
      case "navigate": return this.navigate(asTabId(params.tabId), asString(params.action), asOptionalString(params.url));
      case "computer": return this.computer(params);
      case "read_page": return this.readPage(asTabId(params.tabId), params.maxBytes, params.cursor, asOptionalString(params.scopeRef));
      case "get_page_text": return this.getPageText(asTabId(params.tabId), params.maxBytes, params.cursor, asOptionalString(params.scopeRef));
      case "find": return this.find(asTabId(params.tabId), asString(params.query), params.limit, params.cursor);
      case "form_input": return this.formInput(asTabId(params.tabId), asString(params.pageRef), params.value);
      case "javascript_tool": return this.javascriptTool(asTabId(params.tabId), asString(params.source));
      case "read_console_messages": return this.readConsole(asTabId(params.tabId), params);
      case "read_network_requests": return this.readNetwork(asTabId(params.tabId), params);
      case "resize_window": return this.emulateViewport(asNumber(params.windowId), asNumber(params.width), asNumber(params.height), controlledTabIds);
      case "upload_file": return this.uploadFile(params);
      case "download_file": return this.downloadFile(asTabId(params.tabId), asString(params.url));
      case "browser_batch": return this.browserBatch(params, controlledTabIds);
      default: throw connectorError("unknown_tool", `Unknown browser tool: ${method}`);
    }
  }

  async describePageRef(tabId: number, pageRef: string): Promise<PageRefContext> {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      func: injectedDescribeRef,
      args: [pageRef, this.documentGenerations.get(tabId) ?? 1]
    });
    if (!isPageRefContext(result?.result)) return { description: "" };
    return result.result;
  }

  /* Releasing one session detaches that session's tabs and leaves every other session's
     attached. detachAll stays for the callers that really do mean everything. */
  async detachTabs(tabIds: Iterable<number>): Promise<void> {
    const ids = [...tabIds];
    await this.markers.clear(ids).catch(() => undefined);
    await Promise.all(ids.map(async (tabId) => {
      try { await chrome.debugger.detach({ tabId }); } catch { /* already detached */ }
      this.attachedTabs.delete(tabId);
      this.viewports.delete(tabId);
    }));
  }

  async detachAll(): Promise<void> {
    await Promise.all([...this.attachedTabs].map(async (tabId) => {
      try { await chrome.debugger.detach({ tabId }); } catch { /* already detached */ }
    }));
    this.attachedTabs.clear();
  }

  private async tabsContext(controlledTabIds: Set<number>, createIfEmpty: boolean, group: GroupDescriptor): Promise<unknown> {
    if (controlledTabIds.size === 0 && createIfEmpty) await this.tabsCreate(controlledTabIds, undefined, group);
    const tabs = await Promise.all([...controlledTabIds].map((tabId) => chrome.tabs.get(tabId).catch(() => undefined)));
    return {
      tabs: tabs.filter(Boolean).map((tab) => ({
        id: tab!.id,
        windowId: tab!.windowId,
        title: tab!.title,
        url: tab!.url ? redactUrl(tab!.url) : undefined,
        active: tab!.active
      }))
    };
  }

  /* Reuse before create. An agent that asks for the page it is already working on
     should land on that page, not on a second copy of it: two controlled copies of
     one document make every Page Reference, console record and network record
     ambiguous. Only this session's own Controlled Tabs are searched, so nothing
     the user did not hand over becomes reachable (ADR-0017, ADR-0023). */
  private async tabsCreate(controlledTabIds: Set<number>, url?: string, group: GroupDescriptor = DEFAULT_GROUP): Promise<unknown> {
    if (url && isRestrictedUrl(url)) throw connectorError("restricted_url", `Cannot open privileged or unsupported URL: ${url}`);
    if (url) {
      const existing = await this.reuseControlledTab(controlledTabIds, url);
      if (existing !== undefined) {
        const tab = await chrome.tabs.get(existing);
        return { tabId: existing, windowId: tab.windowId, url: tab.url ? redactUrl(tab.url) : redactUrl(url), reused: true };
      }
    }
    /* Work tabs open in the background: the person keeps the tab they are using (ADR-0024). */
    const tab = await chrome.tabs.create({ url: url ?? "about:blank", active: false });
    if (tab.id === undefined) throw connectorError("tab_create_failed", "Chrome did not return a tab ID");
    controlledTabIds.add(tab.id);
    await this.ensureTabGroup(group, tab.id);
    return {
      tabId: tab.id,
      windowId: tab.windowId,
      url: tab.url ? redactUrl(tab.url) : redactUrl(url ?? "about:blank"),
      reused: false,
      openElsewhere: url ? await this.countTabsOutsideBoundary(controlledTabIds, url) : 0
    };
  }

  private async reuseControlledTab(controlledTabIds: Set<number>, url: string): Promise<number | undefined> {
    for (const tabId of controlledTabIds) {
      const tab = await chrome.tabs.get(tabId).catch(() => undefined);
      if (tab?.url && sameNavigationTarget(tab.url, url)) return tabId;
    }
    return undefined;
  }

  /* The Controlled Tab boundary is what keeps tabs the user did not hand over
     invisible. A count is not a tab: it answers "is this already open somewhere I
     may not touch?" without naming anything outside the boundary, so tabs_context
     can stay silent about their ids, titles and URLs. */
  private async countTabsOutsideBoundary(controlledTabIds: Set<number>, url: string): Promise<number> {
    const tabs = await chrome.tabs.query({});
    return tabs.filter((tab) =>
      tab.id !== undefined && !controlledTabIds.has(tab.id) && tab.url !== undefined && sameNavigationTarget(tab.url, url)
    ).length;
  }

  private async ensureTabGroup(group: GroupDescriptor, tabId: number): Promise<void> {
    try {
      const existing = this.groupIds.get(group.key);
      if (existing !== undefined) {
        await chrome.tabs.group({ groupId: existing, tabIds: [tabId] });
        if (group.label) await chrome.tabGroups.update(existing, { title: group.label, ...colorProperty(group) }).catch(() => {});
        return;
      }
      const groupId = await chrome.tabs.group({ tabIds: [tabId] });
      await chrome.tabGroups.update(groupId, { title: group.label, collapsed: false, ...colorProperty(group) });
      this.groupIds.set(group.key, groupId);
    } catch {
      this.groupIds.delete(group.key);
    }
  }

  /* Adopted tabs bring their group with them: the session continues in the group the work
     already lives in rather than pulling the tabs into a new one (ADR-0025). */
  async adoptGroup(group: GroupDescriptor, tabIds: number[]): Promise<void> {
    if (this.groupIds.has(group.key)) {
      for (const tabId of tabIds) await this.ensureTabGroup(group, tabId);
      return;
    }
    const tabs = await Promise.all(tabIds.map((tabId) => chrome.tabs.get(tabId).catch(() => undefined)));
    const groupId = tabs.find((tab) => tab && tab.groupId !== undefined && tab.groupId >= 0)?.groupId;
    if (groupId !== undefined) this.groupIds.set(group.key, groupId);
    for (const tabId of tabIds) await this.ensureTabGroup(group, tabId);
  }

  /* A rename before any tab exists has no group to update yet; the label is already stored on
     the session, so the group picks it up when it is created. */
  async renameGroup(group: GroupDescriptor): Promise<void> {
    const groupId = this.groupIds.get(group.key);
    if (groupId === undefined) return;
    try { await chrome.tabGroups.update(groupId, { title: group.label, ...colorProperty(group) }); } catch { /* group closed */ }
  }

  /* Bringing a controlled tab forward reads nothing on any origin, so it asks for no
     site grant; it only decides which of the tabs this session already holds is the
     one a person is looking at. */
  /* The agent never takes the person's screen (ADR-0026). A tab is brought forward only inside a
     window that holds nothing but this session's tabs, and the window itself is never focused or
     raised. Anywhere else the request is declined: background tabs already render as focused, so
     no tool needs the tab in front. */
  private async tabsActivate(tabId: number, controlledTabIds: Set<number>): Promise<unknown> {
    const tab = await chrome.tabs.get(tabId);
    const windowTabs = await chrome.tabs.query({ windowId: tab.windowId });
    if (windowTabs.some((other) => other.id === undefined || !controlledTabIds.has(other.id))) {
      return { tabId, windowId: tab.windowId, active: tab.active, deferred: true, reason: "The person is using this window, so the tab stays in the background. Every tool works on background tabs; do not retry." };
    }
    await chrome.tabs.update(tabId, { active: true });
    return { tabId, windowId: tab.windowId, active: true };
  }

  /* Closing a tab is not merely releasing the lease: the tab is gone from the
     browser, and its id leaves the controlled set in the same step so the next
     tabs_context does not report a tab that no longer exists. A tab the user
     already closed is not an error. */
  private async tabsClose(controlledTabIds: Set<number>, tabId: number): Promise<unknown> {
    controlledTabIds.delete(tabId);
    await chrome.tabs.remove(tabId).catch(() => undefined);
    return { closed: tabId };
  }

  private async navigate(tabId: number, action: string, url?: string): Promise<unknown> {
    if (action === "go_to") {
      if (!url || isRestrictedUrl(url)) throw connectorError("restricted_url", `Cannot navigate to ${url ?? "an empty URL"}`);
      await waitForNavigationComplete(tabId, () => chrome.tabs.update(tabId, { url }));
    } else if (action === "reload") await waitForNavigationComplete(tabId, () => chrome.tabs.reload(tabId));
    else if (action === "back" || action === "forward") {
      try {
        await waitForNavigationComplete(tabId, () => action === "back" ? chrome.tabs.goBack(tabId) : chrome.tabs.goForward(tabId));
      } catch (error) {
        // A browser API history-boundary error can disagree with its renderer's
        // history. Never use this fallback for permission or debugger failures.
        if (!(error instanceof Error) || !/Cannot find (?:a )?(?:next|previous) page in history\.?$/i.test(error.message)) throw error;
        await this.ensureDebugger(tabId);
        const history = await this.cdp(tabId, "Page.getNavigationHistory") as { currentIndex?: unknown; entries?: unknown[] };
        if (!Number.isSafeInteger(history.currentIndex) || !Array.isArray(history.entries)
          || Number(history.currentIndex) < 0 || Number(history.currentIndex) >= history.entries.length) throw error;
        const targetIndex = Number(history.currentIndex) + (action === "back" ? -1 : 1);
        const target = history.entries[targetIndex];
        if (!isRecord(target) || !Number.isSafeInteger(target.id) || typeof target.url !== "string" || isRestrictedUrl(target.url)) throw error;
        await waitForNavigationComplete(tabId, () => this.cdp(tabId, "Page.navigateToHistoryEntry", { entryId: target.id }));
      }
    }
    else throw connectorError("invalid_arguments", `Unknown navigation action: ${action}`);
    const tab = await chrome.tabs.get(tabId);
    return { tabId, url: tab.url ? redactUrl(tab.url) : undefined, title: tab.title };
  }

  private async readPage(tabId: number, requestedMax: unknown, cursor: unknown, scopeRef?: string): Promise<unknown> {
    const maxBytes = clampLimit(requestedMax, 65_536, 65_536);
    const offset = cursorOffset(cursor);
    const generation = this.documentGenerations.get(tabId) ?? 1;
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      func: injectedReadPage,
      args: [generation, maxBytes, offset, scopeRef ?? null]
    });
    return result?.result ?? { nodes: [], truncated: false, originalBytes: 0 };
  }

  private async getPageText(tabId: number, requestedMax: unknown, cursor: unknown, scopeRef?: string): Promise<unknown> {
    const maxBytes = clampLimit(requestedMax, 65_536, 65_536);
    const generation = this.documentGenerations.get(tabId) ?? 1;
    const [result] = await chrome.scripting.executeScript({ target: { tabId }, func: injectedGetPageText, args: [scopeRef ?? null, generation] });
    const payload = result?.result;
    const scoped = scopeRef !== undefined;
    const scopedPayload = isRecord(payload) ? payload : undefined;
    const staleScopeRef = scoped && (!scopedPayload || scopedPayload.staleScopeRef === true || typeof scopedPayload.text !== "string");
    const text = scoped
      ? staleScopeRef ? "" : scopedPayload!.text as string
      : typeof payload === "string" ? payload : isRecord(payload) && typeof payload.text === "string" ? payload.text : "";
    return {
      ...pageText(text, cursorOffset(cursor), maxBytes),
      untrusted: true,
      ...(scoped ? { scopeRef, staleScopeRef } : {})
    };
  }

  private async find(tabId: number, query: string, requestedLimit: unknown, cursor: unknown): Promise<unknown> {
    const limit = clampLimit(requestedLimit, 20, 50);
    const offset = cursorOffset(cursor);
    const generation = this.documentGenerations.get(tabId) ?? 1;
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      func: injectedFind,
      args: [generation, query, limit, offset]
    });
    return { ...(result?.result as object ?? { matches: [], nextCursor: null }), untrusted: true };
  }

  private async formInput(tabId: number, pageRef: string, value: unknown): Promise<unknown> {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      func: injectedFormInput,
      args: [pageRef, value, this.documentGenerations.get(tabId) ?? 1]
    });
    if (!result?.result) throw connectorError("stale_page_ref", `Page Reference is stale: ${pageRef}`);
    return { changed: true, pageRef };
  }

  /* A raw CDP mouse event is invisible, so anyone watching the tab sees nothing
     happen. The mark lives in a shadow root so no page style can reach it, carries
     aria-hidden so it never enters the accessibility snapshot the agent reads, and
     ignores pointer events so it cannot swallow the click it is marking. It glides
     to where the agent is about to act and stays there, which is what makes it
     visible in a screenshot taken afterwards. Failures are swallowed: the mark is
     decoration and must never fail an action. */
  private async showCursor(tabId: number, point: { x: number; y: number } | undefined, mode: CursorMode): Promise<void> {
    /* A keystroke or a bare scroll has no point of its own; it labels itself where
       the eye already is. Nothing to aim at means no mark at all. */
    const target = point ?? this.lastPoints.get(tabId);
    if (!target) return;
    this.lastPoints.set(tabId, target);
    try {
      await this.cdp(tabId, "Runtime.evaluate", { expression: cursorExpression(target.x, target.y, CURSOR_LABELS[mode]) });
    } catch { /* the mark is decoration */ }
  }

  /* The ripple is the click's receipt, so it plays after the button goes down
     rather than while the pointer is still gliding in. */
  private async ping(tabId: number): Promise<void> {
    try {
      await this.cdp(tabId, "Runtime.evaluate", { expression: pingExpression() });
    } catch { /* the mark is decoration */ }
  }

  private async computer(params: Record<string, unknown>): Promise<unknown> {
    const tabId = asTabId(params.tabId);
    const action = asString(params.action);
    if (action === "wait") {
      const waitMs = clampLimit(params.waitMs, 500, 10_000);
      await sleep(waitMs);
      return { waitedMs: waitMs };
    }
    await this.ensureDebugger(tabId);
    if (action === "screenshot") {
      const result = await this.cdp(tabId, "Page.captureScreenshot", {
        format: "png",
        captureBeyondViewport: params.fullPage === true
      }) as { data?: string };
      return { mimeType: "image/png", dataBase64: result.data ?? "", artifact: true };
    }
    if (action === "zoom") {
      const region = asRegion(params.region);
      if (!region) throw connectorError("invalid_arguments", "zoom requires a region");
      /* No mark is drawn here. A crop is an observation, and an arrow in it would
         claim the agent acted at the middle of the region when it did not. */
      const result = await this.cdp(tabId, "Page.captureScreenshot", {
        format: "png",
        clip: { ...region, scale: 1 }
      }) as { data?: string };
      return { mimeType: "image/png", dataBase64: result.data ?? "", artifact: true, region };
    }
    if (action === "scroll") {
      const x = asOptionalNumber(params.deltaX) ?? 0;
      const y = asOptionalNumber(params.deltaY) ?? 600;
      const to = typeof params.x === "number" && typeof params.y === "number"
        ? { x: asNumber(params.x), y: asNumber(params.y) }
        : undefined;
      await this.showCursor(tabId, to, "scroll");
      await this.cdp(tabId, "Runtime.evaluate", { expression: `window.scrollBy(${JSON.stringify(x)}, ${JSON.stringify(y)})` });
      return { scrolled: { x, y } };
    }
    if (action === "type") {
      if (typeof params.pageRef === "string") {
        await this.focusRef(tabId, params.pageRef);
        await this.showCursor(tabId, await this.pointForRef(tabId, params.pageRef), "type");
      } else {
        await this.showCursor(tabId, undefined, "type");
      }
      await this.cdp(tabId, "Input.insertText", { text: asString(params.text) });
      return { typed: true };
    }
    if (action === "key") {
      const key = asString(params.key);
      const modifiers = parseModifiers(params.modifiers);
      const repeat = clampLimit(params.repeat, 1, 100);
      await this.showCursor(tabId, undefined, "key");
      for (let index = 0; index < repeat; index += 1) {
        await this.dispatchKey(tabId, key, modifiers, index > 0);
      }
      return { key, modifiers: modifierNames(modifiers), repeat };
    }
    if (action === "drag") {
      const from = await this.pointFrom(params, "pageRef", "x", "y", tabId);
      await this.showCursor(tabId, from, "drag");
      await this.cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", button: "none", buttons: 0, ...from });
      let release = from;
      try {
        await this.cdp(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", button: "left", buttons: 1, clickCount: 1, ...from });
        // Resolving a reference may scroll. Press at the source before making
        // the destination visible, so the source coordinate cannot go stale.
        const to = await this.pointFrom(params, "toPageRef", "toX", "toY", tabId);
        release = to;
        for (let step = 1; step <= DRAG_STEPS; step += 1) {
          await this.cdp(tabId, "Input.dispatchMouseEvent", {
            type: "mouseMoved",
            button: "left",
            buttons: 1,
            x: from.x + ((to.x - from.x) * step) / DRAG_STEPS,
            y: from.y + ((to.y - from.y) * step) / DRAG_STEPS
          });
        }
        await this.showCursor(tabId, to, "drag");
        return { dragged: { from, to } };
      } catch (error) {
        const failure = normalizeError(error);
        throw connectorError(failure.code, failure.message, true);
      } finally {
        try {
          await this.cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", buttons: 0, clickCount: 1, ...release });
        } catch { throw connectorError("drag_interrupted", "The pointer release could not be confirmed; inspect the tab before retrying.", true); }
      }
    }

    const point = await this.pointFrom(params, "pageRef", "x", "y", tabId);
    if (action === "move" || action === "hover") {
      await this.showCursor(tabId, point, "hover");
      await this.cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", ...point });
      return { moved: point };
    }
    if (action === "click" || action === "double_click" || action === "right_click" || action === "middle_click") {
      const clickCount = action === "double_click" ? 2 : 1;
      const button = action === "right_click"
        ? "right"
        : action === "middle_click"
          ? "middle"
          : asOptionalString(params.button) ?? "left";
      if (!["left", "right", "middle"].includes(button)) throw connectorError("invalid_arguments", `Unknown mouse button: ${button}`);
      const held = button === "left" ? 1 : button === "right" ? 2 : 4;
      const modifiers = parseModifiers(params.modifiers);
      await this.showCursor(tabId, point, "click");
      await sleep(CLICK_DWELL_MS);
      await this.cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", ...point, modifiers });
      await this.cdp(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", button, buttons: held, clickCount, ...point, modifiers });
      await this.cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", button, buttons: 0, clickCount, ...point, modifiers });
      await this.ping(tabId);
      return { clicked: point, clickCount, button };
    }
    throw connectorError("invalid_arguments", `Unknown computer action: ${action}`);
  }

  /* One keystroke, with modifiers applied to both edges. A printable character is
     typed (keyDown carries text); a combination or a named key is dispatched raw,
     because Cmd+A is not the character "a" and must not insert one. */
  private async dispatchKey(tabId: number, key: string, modifiers: number, autoRepeat = false): Promise<void> {
    const descriptor = keyDescriptor(key);
    const printable = key.length === 1 && modifiers === 0;
    const base = {
      key: descriptor.key,
      code: descriptor.code,
      windowsVirtualKeyCode: descriptor.virtualKeyCode,
      /* macOS takes the native code when it resolves an editing command; falling
         back keeps a key this table does not know from losing its code. */
      nativeVirtualKeyCode: descriptor.macVirtualKeyCode ?? descriptor.virtualKeyCode,
      modifiers
    };
    await this.cdp(tabId, "Input.dispatchKeyEvent", {
      ...base,
      type: printable ? "keyDown" : "rawKeyDown",
      autoRepeat,
      text: printable ? key : undefined,
      unmodifiedText: printable ? key : undefined,
      commands: printable ? undefined : commandList(key, modifiers)    });
    await this.cdp(tabId, "Input.dispatchKeyEvent", { ...base, type: "keyUp" });
  }

  /* A point is either an element reference or a pair of coordinates, and which one
     a caller meant is the same question for a click, a drag and a move. */
  private async pointFrom(
    params: Record<string, unknown>,
    refKey: string,
    xKey: string,
    yKey: string,
    tabId: number
  ): Promise<{ x: number; y: number }> {
    if (typeof params[refKey] === "string") return this.pointForRef(tabId, params[refKey] as string);
    if (typeof params[xKey] === "number" && typeof params[yKey] === "number") {
      return { x: asNumber(params[xKey]), y: asNumber(params[yKey]) };
    }
    if (refKey === "pageRef") throw connectorError("invalid_arguments", "A Page Reference or both coordinates are required");
    throw connectorError("invalid_arguments", `A ${refKey} or both ${xKey}/${yKey} are required`);
  }

  private async javascriptTool(tabId: number, source: string): Promise<unknown> {
    await this.ensureDebugger(tabId);
    const result = await this.cdp(tabId, "Runtime.evaluate", {
      expression: `(async () => { ${source}\n })()`,
      awaitPromise: true,
      returnByValue: true,
      userGesture: false
    }) as { result?: { value?: unknown; description?: string }; exceptionDetails?: unknown };
    if (result.exceptionDetails) throw connectorError("javascript_error", JSON.stringify(result.exceptionDetails));
    const bounded = boundedText(JSON.stringify(result.result?.value ?? result.result?.description ?? null), 65_536);
    return { value: bounded.text, truncated: bounded.truncated, originalBytes: bounded.originalBytes, untrusted: true };
  }

  private async readConsole(tabId: number, params: Record<string, unknown>): Promise<unknown> {
    await this.ensureDebugger(tabId);
    const limit = clampLimit(params.limit, 100, 100);
    const offset = cursorOffset(params.cursor);
    const pattern = asOptionalString(params.pattern)?.toLowerCase();
    const levels = Array.isArray(params.levels) ? new Set(params.levels.map(String)) : undefined;
    const filtered = (this.consoleRecords.get(tabId) ?? [])
      .filter((record) => (!pattern || record.text.toLowerCase().includes(pattern)) && (!levels || levels.has(record.level)))
      .reverse();
    const records = filtered.slice(offset, offset + limit);
    const nextCursor = offset + records.length < filtered.length ? String(offset + records.length) : null;
    return { records, truncated: nextCursor !== null, nextCursor, untrusted: true };
  }

  private async readNetwork(tabId: number, params: Record<string, unknown>): Promise<unknown> {
    await this.ensureDebugger(tabId);
    if (params.includeResponseBody === true) {
      const requestId = asString(params.requestId);
      const record = (this.networkRecords.get(tabId) ?? []).find((entry) => entry.requestId === requestId);
      if (!record) throw connectorError("request_not_found", `Unknown request ID: ${requestId}`);
      const tab = await chrome.tabs.get(tabId);
      if (!tab.url || exactOrigin(tab.url) !== exactOrigin(record.url)) throw connectorError("cross_origin_body", "Only same-origin response bodies are available");
      const response = await this.cdp(tabId, "Network.getResponseBody", { requestId }) as { body?: string; base64Encoded?: boolean };
      if (response.base64Encoded) throw connectorError("binary_body", "Binary response bodies are unavailable");
      const body = boundedText(response.body ?? "", MAX_RESPONSE_BODY_BYTES);
      return { requestId, body: body.text, truncated: body.truncated, originalBytes: body.originalBytes, untrusted: true };
    }
    const limit = clampLimit(params.limit, 100, 100);
    const offset = cursorOffset(params.cursor);
    const pattern = asOptionalString(params.pattern)?.toLowerCase();
    const resourceTypes = Array.isArray(params.resourceTypes) ? new Set(params.resourceTypes.map(String)) : undefined;
    const filtered = (this.networkRecords.get(tabId) ?? [])
      .filter((record) => (!pattern || record.url.toLowerCase().includes(pattern))
        && (!resourceTypes || (record.resourceType !== undefined && resourceTypes.has(record.resourceType))))
      .reverse();
    const records = filtered.slice(offset, offset + limit);
    const nextCursor = offset + records.length < filtered.length ? String(offset + records.length) : null;
    return { records, truncated: nextCursor !== null, nextCursor, untrusted: true };
  }

  /* Resizing the person's real window would rearrange their screen, so a size request emulates
     that viewport inside this session's tabs in the window instead (ADR-0026). Screenshots, clicks
     and layout all follow the emulated size; the window is untouched. Narrow widths also emulate a
     touch device, which is what a phone-width check means. */
  private async emulateViewport(windowId: number, width: number, height: number, controlledTabIds: Set<number>): Promise<unknown> {
    if (width < 320 || height < 240 || width > 7680 || height > 4320) throw connectorError("invalid_dimensions", "Viewport dimensions are outside supported bounds");
    const tabs = (await chrome.tabs.query({ windowId })).flatMap((tab) => tab.id !== undefined && controlledTabIds.has(tab.id) ? [tab.id] : []);
    if (!tabs.length) throw connectorError("tab_not_controlled", "This window holds no Controlled Tab to size");
    const viewport = { width, height, mobile: width <= 480 };
    for (const tabId of tabs) {
      this.viewports.set(tabId, viewport);
      await this.ensureDebugger(tabId);
      await this.applyViewport(tabId);
    }
    return { windowId, width, height, emulated: true, tabIds: tabs };
  }

  private async applyViewport(tabId: number): Promise<void> {
    const viewport = this.viewports.get(tabId);
    if (!viewport) return;
    await this.cdp(tabId, "Emulation.setDeviceMetricsOverride", { width: viewport.width, height: viewport.height, deviceScaleFactor: 0, mobile: viewport.mobile });
    await this.cdp(tabId, "Emulation.setTouchEmulationEnabled", { enabled: viewport.mobile }).catch(() => undefined);
  }

  private async uploadFile(params: Record<string, unknown>): Promise<unknown> {
    const tabId = asTabId(params.tabId);
    const pageRef = asString(params.pageRef);
    const dataBase64 = asString(params.dataBase64);
    if (Math.floor(dataBase64.length * 0.75) > MAX_UPLOAD_BYTES) throw connectorError("file_too_large", "Upload exceeds 10 MiB");
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      func: injectedUpload,
      args: [pageRef, asString(params.name), asString(params.mimeType), dataBase64, this.documentGenerations.get(tabId) ?? 1]
    });
    if (!result?.result) throw connectorError("upload_failed", "Target is stale or is not a file input");
    return { uploaded: true, name: params.name };
  }

  private async downloadFile(tabId: number, url: string): Promise<unknown> {
    if (isRestrictedUrl(url)) throw connectorError("restricted_url", `Cannot download ${url}`);
    await this.ensureDebugger(tabId);
    const expression = `(async () => {
      const response = await fetch(${JSON.stringify(url)}, { credentials: "include" });
      if (!response.ok) throw new Error("HTTP " + response.status);
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > ${MAX_DOWNLOAD_BYTES}) throw new Error("Download exceeds 10 MiB");
      let binary = "";
      for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return { dataBase64: btoa(binary), mimeType: response.headers.get("content-type") || "application/octet-stream", size: bytes.byteLength };
    })()`;
    const result = await this.cdp(tabId, "Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }) as { result?: { value?: unknown }; exceptionDetails?: unknown };
    if (result.exceptionDetails) throw connectorError("download_failed", JSON.stringify(result.exceptionDetails));
    return { ...(result.result?.value as object ?? {}), artifact: true };
  }

  private async browserBatch(params: Record<string, unknown>, controlledTabIds: Set<number>): Promise<unknown> {
    const actions = Array.isArray(params.actions) ? params.actions : [];
    const results: unknown[] = [];
    for (let index = 0; index < actions.length; index += 1) {
      const action = actions[index] as { tool?: unknown; arguments?: unknown };
      if (action.tool === "javascript_tool") throw connectorError("invalid_batch", "javascript_tool cannot be batched");
      if (typeof action.tool !== "string" || typeof action.arguments !== "object" || action.arguments === null) {
        throw connectorError("invalid_batch", `Invalid action at index ${index}`);
      }
      try {
        results.push(await this.dispatch(action.tool, action.arguments as Record<string, unknown>, controlledTabIds));
      } catch (error) {
        return { completed: index, results, failedAt: index, error: normalizeError(error), atomic: false };
      }
    }
    return { completed: actions.length, results, atomic: false };
  }

  private async ensureDebugger(tabId: number): Promise<void> {
    if (this.attachedTabs.has(tabId)) return;
    try {
      await chrome.debugger.attach({ tabId }, "1.3");
      await chrome.debugger.sendCommand({ tabId }, "Runtime.enable");
      await chrome.debugger.sendCommand({ tabId }, "Network.enable");
      await chrome.debugger.sendCommand({ tabId }, "Page.enable");
      /* A background tab must keep rendering and behave as focused, or screenshots stall and
         focus-dependent pages misbehave while the person works in another tab (ADR-0024). */
      await chrome.debugger.sendCommand({ tabId }, "Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => undefined);
      await chrome.debugger.sendCommand({ tabId }, "Page.setWebLifecycleState", { state: "active" }).catch(() => undefined);
      this.attachedTabs.add(tabId);
      await this.applyViewport(tabId).catch(() => undefined);
    } catch (error) {
      throw connectorError("debugger_conflict", `Cannot attach Chrome debugger. Close DevTools or another debugger first. ${String(error)}`);
    }
  }

  private async cdp(tabId: number, method: string, params?: Record<string, unknown>): Promise<object> {
    return (await chrome.debugger.sendCommand({ tabId }, method, params)) ?? {};
  }

  private async pointForRef(tabId: number, pageRef: string): Promise<{ x: number; y: number }> {
    const [result] = await chrome.scripting.executeScript({ target: { tabId }, func: injectedRefPoint, args: [pageRef, this.documentGenerations.get(tabId) ?? 1] });
    if (!result?.result) throw connectorError("stale_page_ref", `Page Reference is stale: ${pageRef}`);
    return result.result as { x: number; y: number };
  }

  private async focusRef(tabId: number, pageRef: string): Promise<void> {
    const [result] = await chrome.scripting.executeScript({ target: { tabId }, func: injectedFocusRef, args: [pageRef, this.documentGenerations.get(tabId) ?? 1] });
    if (!result?.result) throw connectorError("stale_page_ref", `Page Reference is stale: ${pageRef}`);
  }

  private onDebuggerEvent(tabId: number | undefined, method: string, params?: object): void {
    if (tabId === undefined || !params) return;
    if (method === "Runtime.consoleAPICalled") {
      const event = params as { timestamp?: number; type?: string; args?: Array<{ value?: unknown; description?: string }> };
      const text = (event.args ?? []).map((arg) => String(arg.value ?? arg.description ?? "")).join(" ");
      this.pushRecord(this.consoleRecords, tabId, { timestamp: event.timestamp ?? Date.now(), level: event.type ?? "log", text });
    } else if (method === "Runtime.exceptionThrown") {
      const event = params as { timestamp?: number; exceptionDetails?: { text?: string; url?: string; exception?: { description?: string } } };
      this.pushRecord(this.consoleRecords, tabId, {
        timestamp: event.timestamp ?? Date.now(),
        level: "error",
        text: event.exceptionDetails?.exception?.description ?? event.exceptionDetails?.text ?? "Uncaught exception",
        url: event.exceptionDetails?.url ? redactUrl(event.exceptionDetails.url) : undefined
      });
    } else if (method === "Network.requestWillBeSent") {
      const event = params as { timestamp?: number; requestId?: string; type?: string; request?: { method?: string; url?: string } };
      if (!event.requestId || !event.request?.url) return;
      this.pushRecord(this.networkRecords, tabId, {
        timestamp: event.timestamp ?? Date.now(),
        requestId: event.requestId,
        method: event.request.method ?? "GET",
        url: redactUrl(event.request.url),
        resourceType: event.type
      });
    } else if (method === "Network.responseReceived") {
      const event = params as { requestId?: string; type?: string; response?: { status?: number; mimeType?: string } };
      const record = [...(this.networkRecords.get(tabId) ?? [])].reverse().find((entry) => entry.requestId === event.requestId);
      if (record) {
        record.status = event.response?.status;
        record.mimeType = event.response?.mimeType;
        record.resourceType = event.type ?? record.resourceType;
      }
    }
  }

  private pushRecord<T>(map: Map<number, T[]>, tabId: number, record: T): void {
    const records = map.get(tabId) ?? [];
    records.push(record);
    if (records.length > MAX_LOG_RECORDS) records.splice(0, records.length - MAX_LOG_RECORDS);
    map.set(tabId, records);
  }
}

function injectedReadPage(generation: number, maxBytes: number, offset: number, scopeRef: string | null): unknown {
  const global = globalThis as typeof globalThis & {
    __browserConnectorPageRefState?: { document: Document; generation: number; refs: WeakMap<Element, string>; next: number };
  };
  let state = global.__browserConnectorPageRefState;
  if (!state || state.document !== document || state.generation !== generation) {
    state = { document, generation, refs: new WeakMap<Element, string>(), next: state?.next ?? 0 };
    global.__browserConnectorPageRefState = state;
  }
  const refFor = (element: HTMLElement): string => {
    const existing = state!.refs.get(element);
    if (existing) { element.dataset.browserConnectorRef = existing; return existing; }
    const ref = `p${generation}-${state!.next++}`;
    state!.refs.set(element, ref);
    element.dataset.browserConnectorRef = ref;
    return ref;
  };
  const selector = "a,button,input,select,textarea,[role],[contenteditable=true],summary,[tabindex],h1,h2,h3,h4,h5,h6,p,li";
  const elements = [...document.querySelectorAll<HTMLElement>(selector)];
  /* Cursor positions still use the global traversal, even for scoped reads. Stable
     references come from the shared WeakMap so a find ref resolves in this traversal. */
  let scope: HTMLElement | null = null;
  if (scopeRef !== null) {
    const scopeCandidates = [...elements, ...document.querySelectorAll<HTMLElement>("*")];
    scope = scopeCandidates.find(element => state!.refs.get(element) === scopeRef) ?? null;
    if (!scope?.isConnected) {
      return {
        title: document.title,
        url: location.origin + location.pathname,
        documentGeneration: generation,
        scopeRef,
        staleScopeRef: true,
        nodes: [],
        truncated: false,
        nextCursor: null,
        returnedBytes: 0,
        untrusted: true
      };
    }
  }
  const nodes: Array<Record<string, unknown>> = [];
  let bytes = 0;
  let truncated = false;
  let nextIndex = offset;
  for (let index = offset; index < elements.length && nodes.length < 500; index += 1) {
    nextIndex = index + 1;
    const element = elements[index]!;
    if (scope && element !== scope && !scope.contains(element)) continue;
    const rect = element.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) continue;
    const ref = refFor(element);
    const input = element instanceof HTMLInputElement ? element : undefined;
    const name = (element.getAttribute("aria-label") || element.getAttribute("title") || input?.placeholder || element.innerText || "").trim().replace(/\s+/g, " ").slice(0, 500);
    const node: Record<string, unknown> = {
      ref,
      role: element.getAttribute("role") || element.tagName.toLowerCase(),
      name,
      disabled: "disabled" in element ? Boolean((element as HTMLButtonElement).disabled) : undefined,
      checked: "checked" in element ? Boolean((element as HTMLInputElement).checked) : undefined
    };
    if (input && input.type !== "password") node.value = input.value.slice(0, 500);
    if (input?.type === "password") node.value = "[redacted]";
    const size = new TextEncoder().encode(JSON.stringify(node)).length;
    if (bytes + size > maxBytes) { truncated = true; nextIndex = index; break; }
    nodes.push(node);
    bytes += size;
  }
  if (nextIndex < elements.length) truncated = true;
  return {
    title: document.title,
    url: location.origin + location.pathname,
    documentGeneration: generation,
    ...(scopeRef ? { scopeRef } : {}),
    nodes,
    truncated,
    nextCursor: truncated ? String(nextIndex) : null,
    returnedBytes: bytes,
    untrusted: true
  };
}

function injectedGetPageText(scopeRef: string | null, generation: number): { text: string; scopeRef?: string; staleScopeRef?: true } {
  if (scopeRef !== null) {
    const global = globalThis as typeof globalThis & {
      __browserConnectorPageRefState?: { document: Document; generation: number; refs: WeakMap<Element, string>; next: number };
    };
    const state = global.__browserConnectorPageRefState;
    if (!state || state.document !== document || state.generation !== generation) return { text: "", scopeRef, staleScopeRef: true };
    const root = [...document.querySelectorAll<HTMLElement>("*")].find(element => state.refs.get(element) === scopeRef && element.isConnected);
    if (!root?.isConnected) return { text: "", scopeRef, staleScopeRef: true };
    return { text: root.innerText ?? root.textContent ?? "", scopeRef };
  }
  const root = document.querySelector("main,article,[role=main]") ?? document.body;
  return { text: (root as HTMLElement).innerText ?? root.textContent ?? "" };
}

function injectedFind(generation: number, query: string, limit: number, offset: number): unknown {
  const global = globalThis as typeof globalThis & {
    __browserConnectorPageRefState?: { document: Document; generation: number; refs: WeakMap<Element, string>; next: number };
  };
  let state = global.__browserConnectorPageRefState;
  if (!state || state.document !== document || state.generation !== generation) {
    state = { document, generation, refs: new WeakMap<Element, string>(), next: state?.next ?? 0 };
    global.__browserConnectorPageRefState = state;
  }
  const refFor = (element: HTMLElement): string => {
    const existing = state!.refs.get(element);
    if (existing) { element.dataset.browserConnectorRef = existing; return existing; }
    const ref = `p${generation}-${state!.next++}`;
    state!.refs.set(element, ref);
    element.dataset.browserConnectorRef = ref;
    return ref;
  };
  const needle = query.toLowerCase();
  const elements = [...document.querySelectorAll<HTMLElement>("body *")];
  const matches: unknown[] = [];
  let skipped = 0;
  let hasMore = false;
  for (let index = 0; index < elements.length; index += 1) {
    const element = elements[index]!;
    const haystack = [element.innerText, element.getAttribute("aria-label"), element.getAttribute("title"), element.getAttribute("name"), element.getAttribute("placeholder")].filter(Boolean).join(" ").toLowerCase();
    if (!haystack.includes(needle)) continue;
    const rect = element.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) continue;
    if (skipped < offset) { skipped += 1; continue; }
    if (matches.length >= limit) { hasMore = true; break; }
    const ref = refFor(element);
    matches.push({ ref, role: element.getAttribute("role") || element.tagName.toLowerCase(), name: haystack.slice(0, 500) });
  }
  return { matches, nextCursor: hasMore ? String(offset + matches.length) : null, truncated: hasMore };
}

function injectedDescribeRef(pageRef: string, generation: number): { description: string; destinationOrigin?: string } {
  const global = globalThis as typeof globalThis & {
    __browserConnectorPageRefState?: { document: Document; generation: number; refs: WeakMap<Element, string>; next: number };
  };
  const state = global.__browserConnectorPageRefState;
  if (!state || state.document !== document || state.generation !== generation) return { description: "" };
  const element = [...document.querySelectorAll<HTMLElement>("*")].find(candidate => state.refs.get(candidate) === pageRef && candidate.isConnected);
  if (!element) return { description: "" };
  const description = [element.getAttribute("aria-label"), element.getAttribute("title"), element.getAttribute("name"), element.innerText]
    .filter(Boolean)
    .join(" ")
    .trim()
    .slice(0, 1000);
  const form = element instanceof HTMLButtonElement || element instanceof HTMLInputElement ? element.form : element.closest("form");
  const destination = element instanceof HTMLAnchorElement
    ? element.href
    : element instanceof HTMLButtonElement && element.formAction
      ? element.formAction
      : form?.action;
  try {
    const url = destination ? new URL(destination, location.href) : undefined;
    const destinationOrigin = url && ["http:", "https:"].includes(url.protocol) && url.origin !== location.origin
      ? url.origin
      : undefined;
    return { description, destinationOrigin };
  } catch {
    return { description };
  }
}

function injectedRefPoint(pageRef: string, generation: number): { x: number; y: number } | null {
  const global = globalThis as typeof globalThis & {
    __browserConnectorPageRefState?: { document: Document; generation: number; refs: WeakMap<Element, string>; next: number };
  };
  const state = global.__browserConnectorPageRefState;
  if (!state || state.document !== document || state.generation !== generation) return null;
  const element = [...document.querySelectorAll<HTMLElement>("*")].find(candidate => state.refs.get(candidate) === pageRef && candidate.isConnected);
  if (!element) return null;
  element.scrollIntoView({ block: "center", inline: "center" });
  const rect = element.getBoundingClientRect();
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

function injectedFocusRef(pageRef: string, generation: number): boolean {
  const global = globalThis as typeof globalThis & {
    __browserConnectorPageRefState?: { document: Document; generation: number; refs: WeakMap<Element, string>; next: number };
  };
  const state = global.__browserConnectorPageRefState;
  if (!state || state.document !== document || state.generation !== generation) return false;
  const element = [...document.querySelectorAll<HTMLElement>("*")].find(candidate => state.refs.get(candidate) === pageRef && candidate.isConnected);
  if (!element) return false;
  element.focus();
  return document.activeElement === element;
}

function injectedFormInput(pageRef: string, value: unknown, generation: number): boolean {
  const global = globalThis as typeof globalThis & {
    __browserConnectorPageRefState?: { document: Document; generation: number; refs: WeakMap<Element, string>; next: number };
  };
  const state = global.__browserConnectorPageRefState;
  if (!state || state.document !== document || state.generation !== generation) return false;
  const element = [...document.querySelectorAll<HTMLElement>("*")].find(candidate => state.refs.get(candidate) === pageRef && candidate.isConnected);
  if (!element) return false;
  if (element instanceof HTMLInputElement) {
    if (element.type === "checkbox" || element.type === "radio") element.checked = Boolean(value);
    else element.value = String(value ?? "");
  } else if (element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) element.value = String(value ?? "");
  else if (element.isContentEditable) element.textContent = String(value ?? "");
  else return false;
  element.dispatchEvent(new Event("input", { bubbles: true }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
  return true;
}

function injectedUpload(pageRef: string, name: string, mimeType: string, dataBase64: string, generation: number): boolean {
  const global = globalThis as typeof globalThis & {
    __browserConnectorPageRefState?: { document: Document; generation: number; refs: WeakMap<Element, string>; next: number };
  };
  const state = global.__browserConnectorPageRefState;
  if (!state || state.document !== document || state.generation !== generation) return false;
  const input = [...document.querySelectorAll<HTMLInputElement>("*")].find(candidate => state.refs.get(candidate) === pageRef && candidate.isConnected);
  if (!input || input.type !== "file") return false;
  const binary = atob(dataBase64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  const transfer = new DataTransfer();
  transfer.items.add(new File([bytes], name, { type: mimeType }));
  input.files = transfer.files;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
  return true;
}

async function waitForNavigationComplete(tabId: number, action: () => Promise<unknown>, timeoutMs = 15_000): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let started = false;
    let loadingObserved = false;
    let completed = false;
    let actionCompleted = false;
    const timer = setTimeout(() => finish(connectorError("navigation_timeout", "The navigation did not complete before its deadline; inspect the tab before retrying.", true)), timeoutMs);
    function finish(error?: unknown): void {
      if (settled) return;
      if (!error && (!completed || !actionCompleted)) return;
      settled = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(updated);
      chrome.webNavigation.onCommitted.removeListener(committed);
      if (error) reject(error); else resolve();
    }
    function updated(changedTabId: number, info: chrome.tabs.OnUpdatedInfo, tab: chrome.tabs.Tab): void {
      if (!started || changedTabId !== tabId) return;
      if (info.status === "loading") loadingObserved = true;
      if (info.status === "complete" && loadingObserved || info.url !== undefined && tab.status === "complete" && !tab.pendingUrl) {
        completed = true;
        finish();
      }
    }
    function committed(details: chrome.webNavigation.WebNavigationTransitionCallbackDetails): void {
      if (!started || details.tabId !== tabId || details.frameId !== 0) return;
      loadingObserved = true;
      void chrome.tabs.get(tabId).then(tab => {
        if (!settled && tab.status === "complete") { completed = true; finish(); }
      }, error => finish(error));
    }
    // Subscribe before invoking the API: a fast navigation can finish before
    // its promise resolves, while the old document can still report complete.
    chrome.tabs.onUpdated.addListener(updated);
    chrome.webNavigation.onCommitted.addListener(committed);
    void Promise.resolve().then(() => { started = true; return action(); }).then(() => {
      actionCompleted = true;
      finish();
    }, error => finish(error));
  });
}

function asString(value: unknown): string {
  if (typeof value !== "string") throw connectorError("invalid_arguments", "Expected a string argument");
  return value;
}

function asOptionalString(value: unknown): string | undefined {
  return value === undefined || value === null ? undefined : asString(value);
}

export function cursorOffset(value: unknown): number {
  if (value === undefined || value === null || value === "") return 0;
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    throw connectorError("invalid_cursor", "Cursor must be a non-negative integer string");
  }
  const offset = Number(value);
  if (!Number.isSafeInteger(offset)) throw connectorError("invalid_cursor", "Cursor is outside the supported range");
  return offset;
}

export function pageText(value: string, offset: number, maxBytes: number): {
  text: string;
  truncated: boolean;
  originalBytes: number;
  nextCursor: string | null;
} {
  const characters = [...value];
  const encoder = new TextEncoder();
  let end = Math.min(offset, characters.length);
  let size = 0;
  while (end < characters.length) {
    const characterSize = encoder.encode(characters[end]).length;
    if (size + characterSize > maxBytes) break;
    size += characterSize;
    end += 1;
  }
  return {
    text: characters.slice(offset, end).join(""),
    truncated: end < characters.length,
    originalBytes: encoder.encode(value).length,
    nextCursor: end < characters.length ? String(end) : null
  };
}

function asNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw connectorError("invalid_arguments", "Expected a finite number argument");
  return value;
}

function asOptionalNumber(value: unknown): number | undefined {
  return value === undefined || value === null ? undefined : asNumber(value);
}

function asTabId(value: unknown): number {
  const id = asNumber(value);
  if (!Number.isInteger(id) || id < 0) throw connectorError("invalid_arguments", "Expected a valid tab ID");
  return id;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const CURSOR_HOST_ID = "__browser_connector_cursor";

/* The overlay is injected as one string, so it is built here and tested for being
   parseable: a syntax error would be swallowed by showCursor's catch, and a mark that
   never appears is not something a user can report back as a broken cursor. */
export function cursorExpression(x: number, y: number, label: string): string {
  return `(() => {
    const HOST_ID = ${JSON.stringify(CURSOR_HOST_ID)};
    let host = document.getElementById(HOST_ID);
    if (!host) {
      host = document.createElement("div");
      host.id = HOST_ID;
      host.setAttribute("aria-hidden", "true");
      host.style.cssText = "position:fixed;left:0;top:0;z-index:2147483647;pointer-events:none;";
      host.attachShadow({ mode: "open" }).innerHTML = ${JSON.stringify(CURSOR_MARKUP)};
      document.documentElement.appendChild(host);
    }
    const root = host.shadowRoot;
    if (!root) return;
    const transform = "translate(" + ${x} + "px, " + ${y} + "px)";
    for (const selector of [".arrow", ".ring", ".label", ".ghost.g1", ".ghost.g2", ".ghost.g3"]) {
      const element = root.querySelector(selector);
      if (element) element.style.transform = transform;
    }
    const chip = root.querySelector(".label");
    if (chip) {
      chip.textContent = ${JSON.stringify(label)};
      chip.classList.remove("on");
      void chip.offsetWidth;
      chip.classList.add("on");
    }
  })()`;
}

export function pingExpression(): string {
  return `(() => {
    const host = document.getElementById(${JSON.stringify(CURSOR_HOST_ID)});
    const ping = host && host.shadowRoot ? host.shadowRoot.querySelector(".ping") : null;
    if (!ping) return;
    ping.classList.remove("on");
    void ping.offsetWidth;
    ping.classList.add("on");
  })()`;
}

/* The tab group's color, when the caller asked for one. Chrome's Color enum is a
   closed set of literal strings, which is what GroupColor already is. */
function colorProperty(group: GroupDescriptor): { color?: `${chrome.tabGroups.Color}` } {
  return group.color ? { color: group.color } : {};
}

function asRegion(value: unknown): Region | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) throw connectorError("invalid_arguments", "region must be an object");
  const region = {
    x: asNumber(value.x),
    y: asNumber(value.y),
    width: asNumber(value.width),
    height: asNumber(value.height)
  };
  if (region.width <= 0 || region.height <= 0) throw connectorError("invalid_arguments", "region width and height must be positive");
  return region;
}

/* CDP's modifier bitmask: Alt 1, Ctrl 2, Meta 4, Shift 8. "cmd" and "command" are
   the same key as "meta" — a name from the keyboard, not from the wire. */
const MODIFIER_BITS: Record<string, number> = {
  alt: 1,
  ctrl: 2,
  control: 2,
  meta: 4,
  cmd: 4,
  command: 4,
  shift: 8
};

export function parseModifiers(value: unknown): number {
  if (typeof value !== "string" || !value.trim()) return 0;
  let mask = 0;
  for (const part of value.toLowerCase().split("+")) {
    const name = part.trim();
    const bit = MODIFIER_BITS[name];
    if (bit === undefined) throw connectorError("invalid_arguments", `Unknown key modifier: ${name}`);
    mask |= bit;
  }
  return mask;
}

export function modifierNames(mask: number): string[] {
  return [["alt", 1], ["ctrl", 2], ["meta", 4], ["shift", 8]]
    .filter(([, bit]) => (mask & (bit as number)) !== 0)
    .map(([name]) => name as string);
}

/* macOS virtual key codes (kVK_ANSI_*). Chrome resolves an editing command — Select
   All, Copy, Paste, Undo — from the platform key code, not from the key name, so a
   combination sent with only the Windows code arrives intact and then does nothing.
   The connector is macOS-only, which is the reason this table exists at all. */
const MAC_LETTER_CODES: Record<string, number> = {
  A: 0, B: 11, C: 8, D: 2, E: 14, F: 3, G: 5, H: 4, I: 34, J: 38, K: 40, L: 37,
  M: 46, N: 45, O: 31, P: 35, Q: 12, R: 15, S: 1, T: 17, U: 32, V: 9, W: 13,
  X: 7, Y: 16, Z: 6
};

const MAC_DIGIT_CODES: Record<string, number> = {
  "0": 29, "1": 18, "2": 19, "3": 20, "4": 21, "5": 23, "6": 22, "7": 26, "8": 28, "9": 25
};

export interface KeyDescriptor {
  key: string;
  code?: string;
  virtualKeyCode?: number;
  macVirtualKeyCode?: number;
}

const NAMED_KEYS: Record<string, KeyDescriptor> = {
  enter: { key: "Enter", code: "Enter", virtualKeyCode: 13, macVirtualKeyCode: 36 },
  return: { key: "Enter", code: "Enter", virtualKeyCode: 13, macVirtualKeyCode: 36 },
  tab: { key: "Tab", code: "Tab", virtualKeyCode: 9, macVirtualKeyCode: 48 },
  escape: { key: "Escape", code: "Escape", virtualKeyCode: 27, macVirtualKeyCode: 53 },
  esc: { key: "Escape", code: "Escape", virtualKeyCode: 27, macVirtualKeyCode: 53 },
  backspace: { key: "Backspace", code: "Backspace", virtualKeyCode: 8, macVirtualKeyCode: 51 },
  delete: { key: "Delete", code: "Delete", virtualKeyCode: 46, macVirtualKeyCode: 117 },
  space: { key: " ", code: "Space", virtualKeyCode: 32, macVirtualKeyCode: 49 },
  arrowup: { key: "ArrowUp", code: "ArrowUp", virtualKeyCode: 38, macVirtualKeyCode: 126 },
  arrowdown: { key: "ArrowDown", code: "ArrowDown", virtualKeyCode: 40, macVirtualKeyCode: 125 },
  arrowleft: { key: "ArrowLeft", code: "ArrowLeft", virtualKeyCode: 37, macVirtualKeyCode: 123 },
  arrowright: { key: "ArrowRight", code: "ArrowRight", virtualKeyCode: 39, macVirtualKeyCode: 124 },
  home: { key: "Home", code: "Home", virtualKeyCode: 36, macVirtualKeyCode: 115 },
  end: { key: "End", code: "End", virtualKeyCode: 35, macVirtualKeyCode: 119 },
  pageup: { key: "PageUp", code: "PageUp", virtualKeyCode: 33, macVirtualKeyCode: 116 },
  pagedown: { key: "PageDown", code: "PageDown", virtualKeyCode: 34, macVirtualKeyCode: 121 }
};

/* A key combination needs a physical code, a virtual key code and a native key
   code, not just the character: `{ key: "a" }` on its own inserts an "a" instead of
   selecting all. Letters and digits get theirs derived; a key this table does not
   know is passed through as its name so a named key it has never heard of still
   reaches the page. */
export function keyDescriptor(key: string): KeyDescriptor {
  const named = NAMED_KEYS[key.toLowerCase()];
  if (named) return named;
  if (key.length === 1) {
    const upper = key.toUpperCase();
    if (/^[A-Z]$/.test(upper)) {
      return { key, code: `Key${upper}`, virtualKeyCode: upper.charCodeAt(0), macVirtualKeyCode: MAC_LETTER_CODES[upper] };
    }
    if (/^[0-9]$/.test(key)) {
      return { key, code: `Digit${key}`, virtualKeyCode: key.charCodeAt(0), macVirtualKeyCode: MAC_DIGIT_CODES[key] };
    }
  }
  return { key };
}

/* macOS resolves the standard editing shortcuts — Select All, Copy, Paste, Cut,
   Undo — in the menu bar rather than in the renderer, so a synthetic key event
   never reaches them: the page receives a correct Cmd+A keydown and nothing
   selects. Sending the editor command alongside the key event is what Chrome's own
   DevTools front end does for exactly this reason.
   Only the macOS modifiers are mapped. On macOS Ctrl+A moves to the start of the
   line, so mapping Ctrl to SelectAll would be actively wrong, and the connector is
   macOS-only. */
const EDITING_COMMANDS: Array<{ key: string; modifiers: number; command: string }> = [
  { key: "a", modifiers: 4, command: "SelectAll" },
  { key: "c", modifiers: 4, command: "Copy" },
  { key: "v", modifiers: 4, command: "Paste" },
  { key: "x", modifiers: 4, command: "Cut" },
  { key: "z", modifiers: 4, command: "Undo" },
  { key: "z", modifiers: 12, command: "Redo" }
];

/* A command, not a keystroke: it runs even where a page has bound the shortcut to
   something else. The key event still arrives first, so a page that handles Cmd+A
   itself sees it. */
export function editingCommand(key: string, modifiers: number): string | undefined {
  return EDITING_COMMANDS.find(
    (entry) => entry.key === key.toLowerCase() && entry.modifiers === modifiers
  )?.command;
}

function commandList(key: string, modifiers: number): string[] | undefined {
  const command = editingCommand(key, modifiers);
  return command ? [command] : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPageRefContext(value: unknown): value is PageRefContext {
  return typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && typeof (value as Record<string, unknown>).description === "string"
    && ((value as Record<string, unknown>).destinationOrigin === undefined
      || typeof (value as Record<string, unknown>).destinationOrigin === "string");
}

export function connectorError(code: string, message: string, outcomeUnknown = false): Error & { code: string; outcomeUnknown: boolean } {
  return Object.assign(new Error(message), { code, outcomeUnknown });
}

export function normalizeError(error: unknown): { code: string; message: string; outcomeUnknown: boolean } {
  if (error instanceof Error) {
    const typed = error as Error & { code?: string; outcomeUnknown?: boolean };
    return { code: typed.code ?? "browser_error", message: error.message, outcomeUnknown: typed.outcomeUnknown ?? false };
  }
  return { code: "browser_error", message: String(error), outcomeUnknown: false };
}
