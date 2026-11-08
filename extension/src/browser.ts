import { TabMarkers } from "./tab-marker";
import {
  boundedText,
  clampLimit,
  exactOrigin,
  isBlankTabUrl,
  isRestrictedUrl,
  redactUrl,
  sameNavigationTarget,
  sameTargetDifferentHash
} from "./policy";
import { isConnectorGroupTitle, type GroupColor } from "./naming";
import {
  RUNTIME_MISSING,
  injectedAssert,
  injectedInstallRuntime,
  type PageExpectation,
  type PageExpectationResult,
  type RuntimeGlobal
} from "./page-runtime";
import { SnapshotStore, diffNodes, type PageNode } from "./snapshots";

interface ConsoleRecord {
  timestamp: number;
  /** When the extension received it, in Date.now() time; CDP timestamps use other clocks. */
  seenAt?: number;
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
  /** Set when the response body finished or the request failed, so a request with neither is in flight. */
  done?: boolean;
  /** When the extension received it, in Date.now() time; CDP timestamps are monotonic seconds. */
  seenAt?: number;
  failed?: string;
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
/* After an action the page is "settled" once nothing in the DOM has changed and no request has been
   in flight for this long, or the cap is reached. The result then says what happened, so an agent does
   not need a screenshot or a read just to learn whether its click did anything. */
const SETTLE_QUIET_MS = 300;
const SETTLE_MAX_MS = 2_000;
const WAIT_DEFAULT_MS = 10_000;
const WAIT_MAX_MS = 30_000;
const ASSERT_MAX_MS = 10_000;
const ASSERT_MAX_EXPECTATIONS = 50;
const ASSERT_POLL_MS = 200;
const SCREENSHOT_LONG_EDGE = 1_600;
const VIEWPORT_PRESETS: Record<string, { width: number; height: number }> = {
  mobile: { width: 390, height: 844 },
  tablet: { width: 820, height: 1180 },
  desktop: { width: 1440, height: 900 }
};
/* Intermediate mouseMoved events: HTML5 drag-and-drop and sortable lists ignore a
   press and release with nothing in between. */
const DRAG_STEPS = 8;
const SETTLING_ACTIONS = new Set(["click", "double_click", "right_click", "middle_click", "type", "key", "drag"]);

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
  /* A blocking JavaScript dialog, reported by Page.javascriptDialogOpening. */
  private dialogs = new Map<number, { type: string; message: string }>();
  /* DragData handed over by Input.dragIntercepted during an HTML5 drag. */
  private dragData = new Map<number, unknown>();
  /* Settle loops waiting for a dialog event that would block their scripting call. */
  private readonly dialogWaiters = new Map<number, Set<() => void>>();
  private consoleRecords = new Map<number, ConsoleRecord[]>();
  private networkRecords = new Map<number, NetworkRecord[]>();
  /* Keyed by the session, not by the title: an agent may rename its session at any time, and
     a title-keyed map would lose the group and start a second one on every rename. */
  private groupIds = new Map<string, number>();
  /* Where the mark last acted, so a keystroke or a scroll can label itself at the
     place the person is already looking, without needing coordinates of its own. */
  private lastPoints = new Map<number, { x: number; y: number }>();
  private markers = new TabMarkers();
  private snapshots = new SnapshotStore();
  /* The document generation the in-page runtime was last installed for, per tab. */
  private runtimeInstalled = new Map<number, number>();

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
      this.dialogs.delete(tabId);
      this.snapshots.clear(tabId);
      this.runtimeInstalled.delete(tabId);
    });
    chrome.debugger.onEvent.addListener((source, method, params) => this.onDebuggerEvent(source.tabId, method, params));
    chrome.debugger.onDetach.addListener((source) => {
      if (source.tabId !== undefined) {
        this.attachedTabs.delete(source.tabId);
        this.dialogs.delete(source.tabId);
      }
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
      case "tabs_context": return this.tabsContext(controlledTabIds);
      case "tabs_create": return this.tabsCreateSettled(controlledTabIds, params, group);
      case "tabs_activate": return this.tabsActivate(asTabId(params.tabId), controlledTabIds);
      case "tabs_close": return this.tabsClose(controlledTabIds, asTabId(params.tabId));
      case "navigate": return this.settled(asTabId(params.tabId), params, () => this.navigate(asTabId(params.tabId), asString(params.action), asOptionalString(params.url)), controlledTabIds);
      case "computer": return SETTLING_ACTIONS.has(String(params.action)) ? this.settled(asTabId(params.tabId), params, () => this.computer(params), controlledTabIds) : this.computer(params);
      case "read_page": return this.readPage(asTabId(params.tabId), params.maxBytes, params.cursor, asOptionalString(params.scopeRef), params.filter === "all" ? "all" : "interactive", params.viewportOnly === true, asOptionalString(params.diffFrom));
      case "get_page_text": return this.getPageText(asTabId(params.tabId), params.maxBytes, params.cursor, asOptionalString(params.scopeRef));
      case "find": return this.find(asTabId(params.tabId), asString(params.query), params.limit, params.cursor);
      case "form_input": return this.settled(asTabId(params.tabId), params, () => this.formInput(asTabId(params.tabId), asString(params.pageRef), params.value), controlledTabIds);
      case "fill_form": return this.settled(asTabId(params.tabId), params, () => this.fillForm(asTabId(params.tabId), params.fields), controlledTabIds);
      case "wait_for": return this.waitFor(asTabId(params.tabId), params);
      case "assert": return this.assertExpectations(asTabId(params.tabId), params);
      case "javascript_tool": return this.javascriptTool(asTabId(params.tabId), asString(params.source));
      case "read_console_messages": return this.readConsole(asTabId(params.tabId), params);
      case "read_network_requests": return this.readNetwork(asTabId(params.tabId), params);
      case "resize_window": return this.emulateViewport(params, controlledTabIds);
      case "upload_file": return this.uploadFile(params);
      case "download_file": return this.downloadFile(asTabId(params.tabId), asString(params.url));
      case "browser_batch": return this.browserBatch(params, controlledTabIds, group);
      default: throw connectorError("unknown_tool", `Unknown browser tool: ${method}`);
    }
  }

  /* Runs an action and reports what it did once the page settles: where the tab is, whether the URL
     changed, notices the page announced (alerts, toasts, dialogs), new console errors and failed
     requests. Pass settle: false to skip the wait. */
  private async settled(tabId: number, params: Record<string, unknown>, act: () => Promise<unknown>, controlledTabIds?: Set<number>): Promise<unknown> {
    // Results quote the page, so they carry the same untrusted mark as a page read.
    if (params.settle === false) return act();
    /* Network and console records exist only once the debugger is attached; settling never attaches
       it by itself, so an action that did not need the debugger still does not touch it. */
    this.throwIfDialogOpen(tabId);
    const currentTab = async () => { try { return await chrome.tabs.get(tabId); } catch { return undefined; } };
    /* By arrival time, not list position: the record lists are capped and drop their oldest entries. */
    const before = { url: (await currentTab())?.url, at: Date.now() };
    const since = <T extends { seenAt?: number }>(records: T[] | undefined) => (records ?? []).filter((record) => (record.seenAt ?? 0) >= before.at);
    /* New means announced after the action and not already on screen before it: a banner the app
       re-renders on every click is not news, while a toast shown again after the first one left is. */
    const initial = await this.mutationState(tabId);
    const noticesBefore = initial.sequence;
    const shownBefore = new Set(initial.present);
    /* A target=_blank leaves this tab unchanged, so without this the agent sees
       urlChanged:false and retries. Only tabs this session's page opened are named. */
    const opened: Array<Record<string, unknown>> = [];
    const onCreated = (tab: chrome.tabs.Tab) => {
      if (tab.id === undefined || tab.openerTabId === undefined || !controlledTabIds?.has(tab.openerTabId)) return;
      opened.push({ tabId: tab.id, ...(tab.url ? { url: redactUrl(tab.url) } : {}), ...(tab.title ? { title: tab.title } : {}) });
    };
    chrome.tabs.onCreated?.addListener?.(onCreated);
    let result: unknown;
    try { result = await act(); }
    catch (error) { chrome.tabs.onCreated?.removeListener?.(onCreated); throw error; }
    const started = Date.now();
    let lastCount = -1;
    let lastReliable = initial.reliable;
    let lastChange = Date.now();
    let settled = false;
    let notices: string[] = [];
    /* A dialog blocks the renderer, so executeScript never settles. Race each poll
       against the dialog event instead of waiting for the MCP call to time out. */
    let signalDialog: (() => void) | undefined;
    const dialogOpened = new Promise<null>(resolve => {
      signalDialog = () => resolve(null);
      const waiters = this.dialogWaiters.get(tabId) ?? new Set();
      waiters.add(signalDialog);
      this.dialogWaiters.set(tabId, waiters);
    });
    while (Date.now() - started < SETTLE_MAX_MS) {
      if (this.dialogs.has(tabId)) break;
      const state = await Promise.race([this.mutationState(tabId), dialogOpened]);
      if (state === null) break;
      lastReliable = state.reliable;
      if (state.count !== lastCount) { lastCount = state.count; lastChange = Date.now(); }
      notices = [...new Set(state.notices.filter(notice => notice.sequence > noticesBefore && !shownBefore.has(notice.text)).map(notice => notice.text))];
      const pending = since(this.networkRecords.get(tabId)).filter((record) => !record.done && record.status === undefined).length;
      if (pending === 0 && Date.now() - lastChange >= SETTLE_QUIET_MS) { settled = true; break; }
      await sleep(100);
    }
    const tab = await currentTab();
    /* React and component libraries log deprecation warnings through console.error; they are not failures. */
    const errors = since(this.consoleRecords.get(tabId)).filter((record) => record.level === "error" && !/^Warning: /.test(record.text)).slice(-3).map((record) => record.text.slice(0, 300));
    const failed = since(this.networkRecords.get(tabId)).filter((record) => record.failed || (record.status ?? 0) >= 400).slice(-5)
      .map((record) => ({ method: record.method, url: record.url, ...(record.status ? { status: record.status } : {}), ...(record.failed ? { error: record.failed } : {}) }));
    /* An empty consoleErrors list means "none seen" only when the debugger is monitoring this tab;
       without that, the absence says nothing. */
    const monitored = this.attachedTabs.has(tabId);
    /* Nothing may script the page while a dialog blocks the renderer, including the
       focus probe: executeScript would never settle and the call would time out. */
    const blocked = this.dialogs.has(tabId);
    const generation = blocked ? undefined : await this.generation(tabId);
    const focus = blocked || generation === undefined ? null : await this.runInPage(tabId, injectedFocusInfo, [generation]).catch(() => null);
    const changeCount = lastCount < 0 || !initial.reliable || !lastReliable ? undefined : Math.max(0, lastCount - initial.count);
    chrome.tabs.onCreated?.removeListener?.(onCreated);
    if (signalDialog) {
      const waiters = this.dialogWaiters.get(tabId);
      waiters?.delete(signalDialog);
      if (waiters && waiters.size === 0) this.dialogWaiters.delete(tabId);
    }
    return {
      ...(isRecord(result) ? result : { result }),
      after: {
        url: tab?.url ? redactUrl(tab.url) : undefined,
        title: tab?.title,
        urlChanged: tab?.url !== before.url,
        settled,
        waitedMs: Date.now() - started,
        monitoring: { console: monitored, network: monitored },
        ...(this.dialogs.has(tabId) ? { dialog: this.dialogs.get(tabId), hint: "A JavaScript dialog is blocking the page. The person must dismiss it; the connector does not click dialogs." } : {}),
        ...(changeCount !== undefined ? { changeCount } : {}),
        ...(isRecord(focus) ? { focus } : {}),
        ...(opened.length ? { openedTabs: opened.slice(0, 5), hint: "The page opened a new tab. Call tabs_create with its URL to control it; it stays outside this session until you do." } : {}),
        ...(notices.length ? { notices } : {}),
        ...(errors.length ? { consoleErrors: errors } : {}),
        ...(failed.length ? { failedRequests: failed } : {}),
        untrusted: true
      }
    };
  }

  /* The page's own change counter, installed on first use; a new document starts a new counter. */
  private async mutationState(tabId: number): Promise<{ count: number; sequence: number; notices: Array<{ sequence: number; text: string }>; present: string[]; reliable: boolean }> {
    try {
      const [result] = await chrome.scripting.executeScript({ target: { tabId }, func: injectedMutationState });
      const value = result?.result as unknown;
      if (!isRecord(value) || typeof value.count !== "number" || !Array.isArray(value.notices)) return { count: 0, sequence: 0, notices: [], present: [], reliable: false };
      const notices = value.notices.filter(isRecord).map(notice => ({ sequence: Number(notice.sequence), text: String(notice.text) }));
      return { count: value.count, sequence: Number(value.sequence ?? 0), notices, present: Array.isArray(value.present) ? value.present.map(String) : [], reliable: true };
    } catch {
      /* Mid-navigation: count as a change, so the page is not called quiet while it loads.
         The timestamp is a liveness sentinel, not a mutation count. */
      return { count: Date.now(), sequence: 0, notices: [], present: [], reliable: false };
    }
  }

  /* Waits until every given condition holds: text shown, text gone, a selector visible, the URL
     containing a string, or the network idle. On timeout the error says what still did not hold. */
  private async waitFor(tabId: number, params: Record<string, unknown>): Promise<unknown> {
    this.throwIfDialogOpen(tabId);
    const text = asOptionalString(params.text);
    const textGone = asOptionalString(params.textGone);
    const selector = asOptionalString(params.selector);
    const urlContains = asOptionalString(params.urlContains);
    const networkIdle = params.networkIdle === true;
    if (!text && !textGone && !selector && !urlContains && !networkIdle) throw connectorError("invalid_arguments", "wait_for needs at least one of text, textGone, selector, urlContains or networkIdle");
    const mode = params.mode === undefined ? "all" : asString(params.mode);
    if (mode !== "all" && mode !== "any") throw connectorError("invalid_arguments", "mode must be \"all\" or \"any\"");
    const timeout = clampLimit(params.timeoutMs, WAIT_DEFAULT_MS, WAIT_MAX_MS);
    if (networkIdle) await this.ensureDebugger(tabId);
    const started = Date.now();
    let idleSince = Date.now();
    while (true) {
      const checks: Array<{ label: string; ok: boolean }> = [];
      const tab = await chrome.tabs.get(tabId);
      if (urlContains) checks.push({ label: `urlContains ${JSON.stringify(urlContains)}`, ok: (tab.url ?? "").includes(urlContains) });
      if (text || textGone || selector) {
        /* Same runtime as read_page, find and assert: open shadow roots, same-origin
           frames and visible text, not inline script and hidden DOM. */
        const check = await this.runInPage(tabId, injectedWaitCheck, [text ?? null, textGone ?? null, selector ?? null]).catch(() => undefined);
        if (isRecord(check) && check.invalidSelector === true) throw connectorError("invalid_arguments", `selector is not valid CSS: ${selector}`);
        const result = isRecord(check) ? check as { text?: boolean; textGone?: boolean; selector?: boolean } : {};
        if (text) checks.push({ label: `text ${JSON.stringify(text)}`, ok: result.text === true });
        if (textGone) checks.push({ label: `textGone ${JSON.stringify(textGone)}`, ok: result.textGone === true });
        if (selector) checks.push({ label: `selector ${JSON.stringify(selector)}`, ok: result.selector === true });
      }
      if (networkIdle) {
        const pending = (this.networkRecords.get(tabId) ?? []).filter((record) => !record.done && record.status === undefined && Date.now() - (record.seenAt ?? 0) < WAIT_MAX_MS).length;
        if (pending > 0) idleSince = Date.now();
        checks.push({ label: "networkIdle", ok: Date.now() - idleSince >= 500 });
      }
      const met = mode === "any" ? checks.some(check => check.ok) : checks.every(check => check.ok);
      if (met) return { met: true, waitedMs: Date.now() - started, url: tab.url ? redactUrl(tab.url) : undefined, title: tab.title, untrusted: true };
      if (Date.now() - started >= timeout) {
        const missing = mode === "any" ? checks.map(check => check.label).join(" or ") : checks.filter(check => !check.ok).map(check => check.label).join(", ");
        throw connectorError("wait_timeout", `After ${timeout} ms still waiting for: ${missing}. The tab is at ${tab.url ? redactUrl(tab.url) : "an unknown URL"} (${tab.title ?? "untitled"}).`);
      }
      await sleep(200);
    }
  }

  /* One call, several expectations, a pass or fail for each. Text, element and count checks run in
     the page; the URL and the title are checked here against the redacted values the agent already
     sees, so an expectation cannot be used to guess a part of a URL that was redacted. */
  private async assertExpectations(tabId: number, params: Record<string, unknown>): Promise<unknown> {
    this.throwIfDialogOpen(tabId);
    const expectations = parseExpectations(params.expect);
    const timeout = params.timeoutMs === undefined || params.timeoutMs === null ? 0 : Math.min(Math.max(0, Math.floor(asNumber(params.timeoutMs))), ASSERT_MAX_MS);
    const started = Date.now();
    while (true) {
      const results = await this.assertOnce(tabId, expectations);
      const passed = results.every(result => result.passed);
      if (passed || Date.now() - started >= timeout) {
        return { passed, failed: results.filter(result => !result.passed).length, results, ...(timeout > 0 ? { waitedMs: Date.now() - started } : {}), untrusted: true };
      }
      await sleep(ASSERT_POLL_MS);
    }
  }

  private async assertOnce(tabId: number, expectations: ParsedExpectation[]): Promise<Array<PageExpectationResult & { kind: string }>> {
    const outcomes = new Map<number, PageExpectationResult>();
    const tab = await chrome.tabs.get(tabId);
    const subjects = { url_matches: tab.url ? redactUrl(tab.url) : "", title_matches: tab.title ?? "" };
    for (const expectation of expectations) {
      if (expectation.kind !== "url_matches" && expectation.kind !== "title_matches") continue;
      const subject = subjects[expectation.kind];
      outcomes.set(expectation.index, { index: expectation.index, passed: matchesPattern(subject, expectation.pattern), observed: clipObserved(subject) });
    }
    const inPage = expectations.filter((expectation): expectation is PageExpectation & { kind: PageExpectation["kind"] } => expectation.kind !== "url_matches" && expectation.kind !== "title_matches");
    if (inPage.length) {
      let found: PageExpectationResult[] | undefined;
      try {
        const raw = await this.runInPage(tabId, injectedAssert, [inPage, await this.generation(tabId)]);
        if (Array.isArray(raw)) found = raw as PageExpectationResult[];
      } catch { /* mid-navigation or a page the extension cannot script */ }
      for (const expectation of inPage) {
        outcomes.set(expectation.index, found?.find(result => result.index === expectation.index) ?? { index: expectation.index, passed: false, observed: "the page could not be read" });
      }
    }
    return expectations.map(expectation => ({ ...outcomes.get(expectation.index)!, kind: expectation.kind }));
  }

  /* A new tab is a navigation too: a single-page app renders after load, so the tab is reported once it settles. */
  private async tabsCreateSettled(controlledTabIds: Set<number>, params: Record<string, unknown>, group: GroupDescriptor): Promise<unknown> {
    const created = await this.tabsCreate(controlledTabIds, asOptionalString(params.url), group);
    if (params.settle === false || !isRecord(created) || typeof created.tabId !== "number" || !asOptionalString(params.url)) return created;
    return this.settled(created.tabId, params, async () => created, controlledTabIds);
  }

  async describePageRef(tabId: number, pageRef: string): Promise<PageRefContext> {
    const result = await this.runInPage(tabId, injectedDescribeRef, [pageRef, await this.generation(tabId)]);
    if (!isPageRefContext(result)) return { description: "" };
    return result;
  }

  /* Runs a function in the page with the shared runtime (shadow roots, iframes, Page References)
     installed. The runtime is installed once per document; if a page lost it anyway, the function
     says so and it is installed again. */
  /* The page is the source of truth for its ref generation. Adopt it on the first
     touch after an MV3 worker restart, before any caller captures a generation. */
  private async generation(tabId: number): Promise<number> {
    const known = this.documentGenerations.get(tabId);
    if (known !== undefined) return known;
    const [probe] = await chrome.scripting.executeScript({ target: { tabId }, func: injectedDocumentGeneration }).catch(() => []);
    const value = probe?.result;
    if (typeof value === "number" && value > 0) { this.documentGenerations.set(tabId, value); return value; }
    return 1;
  }

  private async runInPage<Args extends unknown[], Result>(tabId: number, func: (...args: Args) => Result, args: Args): Promise<unknown> {
    for (let attempt = 0; ; attempt += 1) {
      const generation = await this.generation(tabId);
      if (this.runtimeInstalled.get(tabId) !== generation) {
        await chrome.scripting.executeScript({ target: { tabId }, func: injectedInstallRuntime, args: [] });
        this.runtimeInstalled.set(tabId, generation);
      }
      try {
        const [result] = await chrome.scripting.executeScript({ target: { tabId }, func, args });
        return result?.result as unknown;
      } catch (error) {
        if (attempt === 0 && String((error as Error)?.message ?? error).includes(RUNTIME_MISSING)) {
          this.runtimeInstalled.delete(tabId);
          continue;
        }
        throw error;
      }
    }
  }

  /* Releasing one session detaches that session's tabs and leaves every other session's
     attached. detachAll stays for the callers that really do mean everything. */
  async detachTabs(tabIds: Iterable<number>): Promise<void> {
    const ids = [...tabIds];
    await this.markers.clear(ids).catch(() => undefined);
    for (const tabId of ids) this.snapshots.clear(tabId);
    await Promise.all(ids.map(async (tabId) => {
      try { await chrome.debugger.detach({ tabId }); } catch { /* already detached */ }
      this.attachedTabs.delete(tabId);
      this.viewports.delete(tabId);
      this.dialogs.delete(tabId);
    }));
  }

  async detachAll(): Promise<void> {
    await Promise.all([...this.attachedTabs].map(async (tabId) => {
      try { await chrome.debugger.detach({ tabId }); } catch { /* already detached */ }
      this.dialogs.delete(tabId);
    }));
    this.attachedTabs.clear();
  }

  /* Adoption paths return before dispatch, so they ask for the mark themselves; the marker sync
     is idempotent and skips tabs it already marked. */
  async syncMarkers(tabIds: Iterable<number>): Promise<void> {
    await this.markers.sync(tabIds).catch(() => undefined);
  }

  /* A read never changes the browser: the old createIfEmpty path opened about:blank, and a blank
     tab the connector could not record was left behind when the agent asked for its real URL
     next (ADR-0032). An empty result names the next step instead. */
  private async tabsContext(controlledTabIds: Set<number>): Promise<unknown> {
    const tabs = (await Promise.all([...controlledTabIds].map((tabId) => chrome.tabs.get(tabId).catch(() => undefined))))
      .filter(Boolean);
    return {
      tabs: tabs.map((tab) => ({
        id: tab!.id,
        windowId: tab!.windowId,
        title: tab!.title,
        url: tab!.url ? redactUrl(tab!.url) : undefined,
        active: tab!.active,
        ...(tab!.id !== undefined && this.documentGenerations.has(tab!.id) ? { documentGeneration: this.documentGenerations.get(tab!.id) } : {})
      })),
      ...(tabs.length === 0
        ? { hint: "No controlled tabs. Call tabs_create with the URL you need; it reuses or adopts an open tab at that URL instead of opening a duplicate." }
        : {})
    };
  }

  /* Reuse before create. An agent that asks for the page it is already working on
     should land on that page, not on a second copy of it: two controlled copies of
     one document make every Page Reference, console record and network record
     ambiguous. A Controlled Tab at the URL wins first, then a Controlled background
     blank; only afterward may an open tab be adopted outside this method
     (ADR-0023, ADR-0031, ADR-0032). */
  private async tabsCreate(controlledTabIds: Set<number>, url?: string, group: GroupDescriptor = DEFAULT_GROUP): Promise<unknown> {
    if (url && isRestrictedUrl(url)) throw connectorError("restricted_url", `Cannot open privileged or unsupported URL: ${url}`);
    if (url) {
      const existing = await this.reuseControlledTab(controlledTabIds, url);
      if (existing !== undefined) {
        let tab = await chrome.tabs.get(existing);
        /* sameNavigationTarget ignores the fragment, and a hash route is a different
           screen. Navigate when the full URL differs before reporting a reuse. */
        const navigated = !!tab.url && sameTargetDifferentHash(tab.url, url);
        if (navigated) {
          await chrome.tabs.update(existing, { url });
          tab = await chrome.tabs.get(existing);
        }
        return { tabId: existing, windowId: tab.windowId, url: tab.url ? redactUrl(tab.url) : redactUrl(url), reused: true, ...(navigated ? { navigated: true } : {}) };
      }
    }
    /* A blank tab this session already holds is a placeholder, not a destination: navigating it
       is what the agent meant, and creating a second tab would leave the blank behind (ADR-0032).
       Only a background blank is reused; an active one may be the person's. */
    const blank = await this.reuseControlledBlank(controlledTabIds);
    if (blank !== undefined) {
      try {
        if (url) await chrome.tabs.update(blank, { url, active: false });
        const tab = await chrome.tabs.get(blank);
        return {
          tabId: blank,
          windowId: tab.windowId,
          /* The update has not committed yet, so tab.url can still be about:blank; the requested
             URL is the one this call navigated the tab to. */
          url: url ? redactUrl(url) : tab.url ? redactUrl(tab.url) : redactUrl("about:blank"),
          reused: true,
          reusedBlank: true
        };
      } catch {
        /* The blank disappeared or Chrome refused the navigation; fall through and open one. */
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

  private async reuseControlledBlank(controlledTabIds: Set<number>): Promise<number | undefined> {
    for (const tabId of controlledTabIds) {
      const tab = await chrome.tabs.get(tabId).catch(() => undefined);
      if (tab && !tab.active && isBlankTabUrl(tab.url, tab.pendingUrl)) return tabId;
    }
    return undefined;
  }

  /* Whether tabs_create can satisfy this request from a tab the session already holds, before an
     adoption helper looks outside the boundary. A Controlled Tab at the URL wins over a Controlled
     blank, and both win over a released or already-open tab (ADR-0023, ADR-0031). */
  async canReuseControlled(controlledTabIds: Set<number>, url?: string): Promise<boolean> {
    if (url && await this.reuseControlledTab(controlledTabIds, url) !== undefined) return true;
    return await this.reuseControlledBlank(controlledTabIds) !== undefined;
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

  /* Moves a tab into this session's group. It is deliberately different from adoptGroup: this
     one does not take over the group the tab already lives in, which is what an adopted tab
     needs because that group belongs to the person, not to the agent. */
  async ensureTabGroup(group: GroupDescriptor, tabId: number): Promise<void> {
    try {
      const existing = this.groupIds.get(group.key);
      if (existing !== undefined) {
        await chrome.tabs.group({ groupId: existing, tabIds: [tabId] });
        if (group.label) await chrome.tabGroups.update(existing, { title: group.label, ...colorProperty(group) }).catch(() => {});
        return;
      }
      const recovered = await this.recoverGroup(group);
      if (recovered !== undefined) {
        this.groupIds.set(group.key, recovered);
        await chrome.tabs.group({ groupId: recovered, tabIds: [tabId] });
        if (group.label) await chrome.tabGroups.update(recovered, { title: group.label, ...colorProperty(group) }).catch(() => {});
        return;
      }
      const groupId = await chrome.tabs.group({ tabIds: [tabId] });
      await chrome.tabGroups.update(groupId, { title: group.label, collapsed: false, ...colorProperty(group) });
      this.groupIds.set(group.key, groupId);
    } catch {
      this.groupIds.delete(group.key);
    }
  }

  /* Adopted tabs bring their group with them only when that group is a connector group: the
     session continues where the work already lives (ADR-0025). A person's group is not taken
     over; the tab moves into a new connector group instead. */
  async adoptGroup(group: GroupDescriptor, tabIds: number[]): Promise<void> {
    if (this.groupIds.has(group.key)) {
      for (const tabId of tabIds) await this.ensureTabGroup(group, tabId);
      return;
    }
    const tabs = await Promise.all(tabIds.map((tabId) => chrome.tabs.get(tabId).catch(() => undefined)));
    const candidate = tabs.find((tab) => tab && tab.groupId !== undefined && tab.groupId >= 0);
    if (candidate?.groupId !== undefined) {
      const current = await Promise.resolve(chrome.tabGroups?.get?.(candidate.groupId)).catch(() => undefined);
      if (isConnectorGroupTitle(current?.title)) this.groupIds.set(group.key, candidate.groupId);
    }
    for (const tabId of tabIds) await this.ensureTabGroup(group, tabId);
  }

  /* The worker's map of session to group does not survive a worker restart, so a group already in
     the tab strip is found again by the title and color it was given, rather than starting a
     second group for the same session. */
  private async recoverGroup(group: GroupDescriptor): Promise<number | undefined> {
    const groups = (await Promise.resolve(chrome.tabGroups?.query?.({})).catch(() => [])) ?? [];
    return groups.find((candidate) => candidate.title === group.label && (!group.color || candidate.color === group.color))?.id;
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
    this.throwIfDialogOpen(tabId);
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

  private async readPage(tabId: number, requestedMax: unknown, cursor: unknown, scopeRef: string | undefined, filter: "interactive" | "all", viewportOnly: boolean, diffFrom?: string): Promise<unknown> {
    this.throwIfDialogOpen(tabId);
    const maxBytes = clampLimit(requestedMax, 65_536, 65_536);
    const offset = cursorOffset(cursor);
    const generation = await this.generation(tabId);
    const page = await this.runInPage(tabId, injectedReadPage, [generation, maxBytes, offset, scopeRef ?? null, filter, viewportOnly]);
    if (!isRecord(page)) return { nodes: [], truncated: false, originalBytes: 0 };
    /* Links can carry tokens in their path (/reset/<token>); they go through the same redaction as every URL. */
    const origin = typeof page.url === "string" ? safeOrigin(page.url) : undefined;
    if (typeof page.url === "string") page.url = redactUrl(page.url);
    if (Array.isArray(page.nodes)) for (const node of page.nodes) {
      if (!isRecord(node) || typeof node.href !== "string") continue;
      const absolute = node.href.startsWith("/") && origin ? origin + node.href : node.href;
      const redacted = redactUrl(absolute);
      node.href = origin && redacted.startsWith(origin + "/") ? redacted.slice(origin.length) : redacted;
    }
    if (!Array.isArray(page.nodes) || page.staleScopeRef === true) return page;
    /* A snapshot is the node list of one read; it can only be diffed against a read shaped the same way. */
    const nodes = page.nodes as PageNode[];
    const key = JSON.stringify([filter, viewportOnly, scopeRef ?? null, offset]);
    const complete = page.truncated !== true;
    const previous = diffFrom ? this.snapshots.find(tabId, diffFrom) : undefined;
    page.snapshotId = this.snapshots.record(tabId, { generation, key, complete, nodes });
    if (!diffFrom) return page;
    const unavailable = !previous ? "the snapshot is unknown or expired"
      : previous.generation !== generation ? "the page navigated since that snapshot"
      : previous.key !== key ? "that snapshot was read with a different filter, scope, viewportOnly or cursor"
      : !previous.complete || !complete ? "a read was truncated, so missing nodes cannot be told from nodes beyond the cut; narrow it with scopeRef or viewportOnly"
      : undefined;
    if (unavailable) return { ...page, diffUnavailable: `${unavailable}; returning the full tree` };
    const { nodes: _full, returnedBytes: _bytes, ...rest } = page;
    const { summary, ...changes } = diffNodes(previous!.nodes, nodes);
    return { ...rest, diffFrom, diff: changes, summary };
  }

  private async getPageText(tabId: number, requestedMax: unknown, cursor: unknown, scopeRef?: string): Promise<unknown> {
    this.throwIfDialogOpen(tabId);
    const maxBytes = clampLimit(requestedMax, 65_536, 65_536);
    const generation = await this.generation(tabId);
    const payload = await this.runInPage(tabId, injectedGetPageText, [scopeRef ?? null, generation]);
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
    this.throwIfDialogOpen(tabId);
    const limit = clampLimit(requestedLimit, 20, 50);
    const offset = cursorOffset(cursor);
    const generation = await this.generation(tabId);
    const result = await this.runInPage(tabId, injectedFind, [generation, query, limit, offset]);
    const found = (result as { matches?: unknown[] } | undefined) ?? { matches: [], nextCursor: null };
    /* An empty result on a page that is still rendering looks the same as a real miss. */
    const empty = !found.matches?.length;
    return { ...found, untrusted: true, ...(empty ? { hint: "No match. If the page may still be rendering, wait_for a text you expect on it and search again; otherwise try another word from the label." } : {}) };
  }

  /* Writes through the element's native value setter, so frameworks that track the value (React)
     see the change, then reads it back: a value the page rejected is reported, not assumed. */
  private async formInput(tabId: number, pageRef: string, value: unknown): Promise<{ pageRef: string; changed: boolean; matched: boolean; actual?: unknown; before?: unknown; untrusted?: boolean }> {
    this.throwIfDialogOpen(tabId);
    const outcome = await this.runInPage(tabId, injectedFormInput, [pageRef, value, await this.generation(tabId)]);
    if (outcome === false || outcome === null || outcome === undefined) throw await this.staleRefError(tabId, pageRef);
    if (isRecord(outcome) && outcome.unsupported === true) throw connectorError("invalid_arguments", `${pageRef} is not a text input, textarea, select or editable element. A custom select (role combobox) is used by clicking it, then clicking the option found with find; a file input uses upload_file.`);
    if (isRecord(outcome) && typeof outcome.refused === "string") throw connectorError("element_disabled", `${pageRef} is ${outcome.refused}`);
    if (isRecord(outcome) && outcome.missingOption === true) throw connectorError("invalid_arguments", `No option of ${pageRef} matches ${JSON.stringify(value)} by value or label. Options: ${String(outcome.options ?? "")}`);
    if (isRecord(outcome) && outcome.invalidType === "boolean") throw connectorError("invalid_arguments", `${pageRef} is a checkbox or radio; value must be the boolean true or false, not ${typeof value}.`);
    if (isRecord(outcome) && outcome.radioCannotUncheck === true) throw connectorError("radio_cannot_uncheck", `${pageRef} is a radio button; a checked radio cannot be unchecked by clicking it. Click the radio that should be selected instead.`);
    const matched = isRecord(outcome) ? outcome.matched !== false : true;
    return { pageRef, changed: matched, matched, ...(isRecord(outcome) && "before" in outcome ? { before: outcome.before } : {}), ...(isRecord(outcome) && "actual" in outcome ? { actual: outcome.actual } : {}), ...(isRecord(outcome) && typeof outcome.unverified === "string" ? { unverified: outcome.unverified } : {}), ...(matched ? {} : { hint: ERROR_HINTS.value_not_applied }), untrusted: true };
  }

  private async fillForm(tabId: number, fields: unknown): Promise<unknown> {
    if (!Array.isArray(fields) || !fields.length || fields.length > 50) throw connectorError("invalid_arguments", "fill_form needs 1 to 50 fields of { pageRef, value }");
    const results: Array<Record<string, unknown>> = [];
    let failedAt: number | undefined;
    let failure: ReturnType<typeof normalizeError> | undefined;
    for (const [index, field] of fields.entries()) {
      if (!isRecord(field) || typeof field.pageRef !== "string") throw connectorError("invalid_arguments", "Every field needs a pageRef");
      try {
        results.push({ ...(await this.formInput(tabId, field.pageRef, field.value)), ok: true });
      } catch (cause) {
        failedAt = index;
        failure = normalizeError(cause);
        results.push({ pageRef: field.pageRef, ok: false, error: failure });
        break;
      }
    }
    return { fields: results, allMatched: failedAt === undefined && results.every((result) => result.ok === true && result.matched === true), ...(failedAt !== undefined ? { failedAt, error: failure } : {}), untrusted: true };
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
    this.throwIfDialogOpen(tabId);
    const action = asString(params.action);
    if (action === "wait") {
      const waitMs = clampLimit(params.waitMs, 500, 10_000);
      await sleep(waitMs);
      return { waitedMs: waitMs };
    }
    await this.ensureDebugger(tabId);
    if (action === "screenshot") {
      /* JPEG and a bounded long edge by default: a full-resolution PNG was the most expensive thing
         an agent read. Coordinates stay CSS pixels; imageScale says how the image relates to them. */
      const format = params.format === "png" ? "png" : "jpeg";
      const quality = format === "jpeg" ? clampLimit(params.quality, 70, 100) : undefined;
      const longEdge = clampLimit(params.maxLongEdge, SCREENSHOT_LONG_EDGE, 4_096);
      const metrics = await this.cdp(tabId, "Page.getLayoutMetrics").catch(() => ({})) as { cssVisualViewport?: { pageX?: number; pageY?: number; clientWidth?: number; clientHeight?: number } };
      const view = metrics.cssVisualViewport;
      const width = view?.clientWidth; const height = view?.clientHeight;
      const imageScale = params.fullPage !== true && width && height ? Math.min(1, longEdge / Math.max(width, height)) : 1;
      const result = await this.cdp(tabId, "Page.captureScreenshot", {
        format,
        ...(quality !== undefined ? { quality } : {}),
        captureBeyondViewport: params.fullPage === true,
        ...(imageScale < 1 ? { clip: { x: view!.pageX ?? 0, y: view!.pageY ?? 0, width, height, scale: imageScale } } : {})
      }) as { data?: string };
      return { mimeType: `image/${format}`, dataBase64: result.data ?? "", artifact: true, imageScale, ...(width && height ? { cssViewport: { width, height } } : {}) };
    }
    if (action === "zoom") {
      const region = asRegion(params.region);
      if (!region) throw connectorError("invalid_arguments", "zoom requires a region");
      /* No mark is drawn here. A crop is an observation, and an arrow in it would
         claim the agent acted at the middle of the region when it did not. */
      const format = params.format === "png" ? "png" : "jpeg";
      const result = await this.cdp(tabId, "Page.captureScreenshot", {
        format,
        ...(format === "jpeg" ? { quality: clampLimit(params.quality, 80, 100) } : {}),
        clip: { ...region, scale: 1 }
      }) as { data?: string };
      return { mimeType: `image/${format}`, dataBase64: result.data ?? "", artifact: true, region };
    }
    if (action === "scroll") {
      /* A pageRef is scrolled into view; supplied deltas then wheel at its centre. Otherwise a
         real wheel event at the point (or the middle of the viewport) scrolls whatever is under
         it, including inner panels that window.scrollBy misses. */
      const ref = typeof params.pageRef === "string" ? params.pageRef : null;
      const hasDelta = typeof params.deltaX === "number" || typeof params.deltaY === "number";
      const x = asOptionalNumber(params.deltaX) ?? 0;
      const y = asOptionalNumber(params.deltaY) ?? (hasDelta ? 0 : 600);
      const generation = await this.generation(tabId);
      let at: { x: number; y: number };
      let before: unknown;
      if (ref) {
        /* Capture the position before pointForRef scrolls the element into view, or
           the scroll the tool performs is the one it fails to report. */
        before = await this.runInPage(tabId, injectedScrollState, [ref, generation]);
        at = await this.pointForRef(tabId, ref);
      } else {
        if (typeof params.x === "number" && typeof params.y === "number") {
          at = { x: asNumber(params.x), y: asNumber(params.y) };
        } else {
          const metrics = await this.cdp(tabId, "Page.getLayoutMetrics").catch(() => ({})) as { cssVisualViewport?: { clientWidth?: number; clientHeight?: number } };
          at = { x: (metrics.cssVisualViewport?.clientWidth ?? 800) / 2, y: (metrics.cssVisualViewport?.clientHeight ?? 600) / 2 };
        }
        before = await this.runInPage(tabId, injectedScrollState, [null, generation, at.x, at.y]);
      }
      await this.showCursor(tabId, at, "scroll");
      if (!ref || hasDelta) {
        await this.cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseWheel", x: at.x, y: at.y, deltaX: x, deltaY: y });
      }
      const after = await this.runInPage(tabId, injectedScrollState, [ref, generation, at.x, at.y]);
      const moved = isRecord(before) && isRecord(after) ? JSON.stringify(before) !== JSON.stringify(after) : undefined;
      return { ...(ref ? { scrolledTo: ref, point: at } : { at }), ...(!ref || hasDelta ? { scrolled: { x, y } } : {}), before, after, ...(moved !== undefined ? { moved } : {}) };
    }
    if (action === "type") {
      if (typeof params.pageRef === "string") {
        await this.focusRef(tabId, params.pageRef);
        await this.showCursor(tabId, await this.pointForRef(tabId, params.pageRef), "type");
      } else {
        await this.showCursor(tabId, undefined, "type");
      }
      const text = asString(params.text);
      /* A field that listens to keydown ignores insertText; replace selects the current
         value the way a person would, so the next insert overwrites it. */
      if (params.replace === true) await this.dispatchKey(tabId, "a", 4);
      if (params.keyEvents === true) {
        for (const character of [...text]) {
          /* dispatchKey carries text only for a single UTF-16 unit; an astral character
             (emoji) would be sent as rawKeyDown with text undefined and vanish. */
          if (character.length === 1) await this.dispatchKey(tabId, character, 0);
          else await this.cdp(tabId, "Input.insertText", { text: character });
        }
      } else {
        await this.cdp(tabId, "Input.insertText", { text });
      }
      const focused = await this.runInPage(tabId, injectedActiveElement, []);
      const actual = isRecord(focused) && typeof focused.value === "string"
        ? focused.value
        : isRecord(focused) && typeof focused.text === "string" ? focused.text : undefined;
      return { typed: true, inserted: text, ...(focused ? { focused } : {}), ...(actual !== undefined ? { actual } : {}) };
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
      const modifiers = parseModifiers(params.modifiers);
      /* Both ends are hit-tested, so a covered source or a missed drop target is named
         before the pointer moves. */
      const from = await this.pointFrom(params, "pageRef", "x", "y", tabId, true);
      await this.dragProbe(tabId, true);
      /* When the page starts an HTML5 drag, Chrome hands its DragData over instead of
         leaving the renderer to guess from synthetic mouse moves. */
      await this.cdp(tabId, "Input.setInterceptDrags", { enabled: true }).catch(() => undefined);
      await this.showCursor(tabId, from, "drag");
      await this.cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", button: "none", buttons: 0, ...from, modifiers });
      let release = from;
      let pressed = false;
      let released = false;
      try {
        await this.cdp(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", button: "left", buttons: 1, clickCount: 1, ...from, modifiers });
        pressed = true;
        // Resolving a reference may scroll. Press at the source before making
        // the destination visible, so the source coordinate cannot go stale.
        const to = await this.pointFrom(params, "toPageRef", "toX", "toY", tabId, true);
        release = to;
        for (let step = 1; step <= DRAG_STEPS; step += 1) {
          await this.cdp(tabId, "Input.dispatchMouseEvent", {
            type: "mouseMoved",
            button: "left",
            buttons: 1,
            x: from.x + ((to.x - from.x) * step) / DRAG_STEPS,
            y: from.y + ((to.y - from.y) * step) / DRAG_STEPS,
            modifiers
          });
        }
        await this.showCursor(tabId, to, "drag");
        const data = this.dragData.get(tabId);
        let html5 = false;
        if (data !== undefined) {
          for (const type of ["dragEnter", "dragOver", "drop"] as const) {
            await this.cdp(tabId, "Input.dispatchDragEvent", { type, x: to.x, y: to.y, data });
          }
          html5 = true;
        }
        await this.cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", buttons: 0, clickCount: 1, ...release, modifiers });
        released = true;
        /* Whether the page received dragstart/dragover/drop distinguishes an ignored
           gesture from a drop that landed somewhere unexpected. */
        const events = await this.dragProbe(tabId, false);
        return { dragged: { from, to }, ...(isRecord(events) ? { events } : {}), ...(html5 ? { html5: true } : {}) };
      } catch (error) {
        const failure = normalizeError(error);
        throw connectorError(failure.code, failure.message, true);
      } finally {
        await this.cdp(tabId, "Input.setInterceptDrags", { enabled: false }).catch(() => undefined);
        this.dragData.delete(tabId);
        if (pressed && !released) {
          try { await this.cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", buttons: 0, clickCount: 1, ...release, modifiers }); } catch { /* the catch above already says outcomeUnknown */ }
        }
      }
    }

    const point = await this.pointFrom(params, "pageRef", "x", "y", tabId, action !== "move" && action !== "hover");
    if (action === "move" || action === "hover") {
      await this.showCursor(tabId, point, "hover");
      await this.cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", ...point });
      return { moved: point };
    }
    if (action === "mouse_down" || action === "mouse_up") {
      const point = await this.pointFrom(params, "pageRef", "x", "y", tabId, action === "mouse_down");
      const button = asOptionalString(params.button) ?? "left";
      if (!["left", "right", "middle"].includes(button)) throw connectorError("invalid_arguments", `Unknown mouse button: ${button}`);
      const held = button === "left" ? 1 : button === "right" ? 2 : 4;
      const modifiers = parseModifiers(params.modifiers);
      await this.showCursor(tabId, point, action === "mouse_down" ? "click" : "hover");
      if (action === "mouse_down") {
        await this.cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", ...point, modifiers });
        await this.cdp(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", button, buttons: held, clickCount: 1, ...point, modifiers });
        return { pressed: point, button };
      }
      await this.cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", button, buttons: 0, clickCount: 1, ...point, modifiers });
      return { released: point, button };
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
      /* A layout shift during the dwell can move a different element under the point.
         Re-check the target's own identity before pressing, and press where it is now. */
      const ref = typeof params.pageRef === "string" ? params.pageRef : undefined;
      const generation = await this.generation(tabId);
      let pressAt = point;
      let target: Record<string, unknown> | undefined;
      if (ref) {
        const guard = await this.runInPage(tabId, injectedClickGuard, [ref, generation, point.x, point.y]);
        if (guard === null || guard === undefined) throw await this.staleRefError(tabId, ref);
        if (isRecord(guard) && typeof guard.blockedBy === "string") throw connectorError("click_intercepted", `${ref} is now covered by ${guard.blockedBy} (quoted page content, untrusted)`);
        if (isRecord(guard) && isRecord(guard.point)) pressAt = guard.point as { x: number; y: number };
        target = { ref, ...(isRecord(guard) && typeof guard.role === "string" ? { role: guard.role } : {}), ...(isRecord(guard) && typeof guard.name === "string" ? { name: guard.name } : {}) };
        if (pressAt.x !== point.x || pressAt.y !== point.y) await this.showCursor(tabId, pressAt, "click");
      }
      await this.cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", ...pressAt, modifiers });
      await this.cdp(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", button, buttons: held, clickCount, ...pressAt, modifiers });
      try {
        await this.cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", button, buttons: 0, clickCount, ...pressAt, modifiers });
      } catch {
        throw connectorError("browser_error", "The click was pressed but its release could not be confirmed; inspect the tab before retrying so a second click does not apply twice.", true);
      }
      await this.ping(tabId);
      return { clicked: pressAt, clickCount, button, ...(target ? { target } : {}) };
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
    tabId: number,
    hitTest = false
  ): Promise<{ x: number; y: number }> {
    if (typeof params[refKey] === "string") return this.pointForRef(tabId, params[refKey] as string, hitTest);
    if (typeof params[xKey] === "number" && typeof params[yKey] === "number") {
      return { x: asNumber(params[xKey]), y: asNumber(params[yKey]) };
    }
    if (refKey === "pageRef") throw connectorError("invalid_arguments", "A Page Reference or both coordinates are required");
    throw connectorError("invalid_arguments", `A ${refKey} or both ${xKey}/${yKey} are required`);
  }

  private async javascriptTool(tabId: number, source: string): Promise<unknown> {
    this.throwIfDialogOpen(tabId);
    await this.ensureDebugger(tabId);
    const result = await this.cdp(tabId, "Runtime.evaluate", {
      expression: `(async () => { ${source}\n })()`,
      awaitPromise: true,
      returnByValue: true,
      userGesture: false
    }) as { result?: { value?: unknown; description?: string }; exceptionDetails?: unknown };
    if (result.exceptionDetails) {
      const details = result.exceptionDetails as { text?: string; exception?: { description?: string } };
      throw connectorError("javascript_error", (details.exception?.description ?? details.text ?? "The script threw").slice(0, 1_000));
    }
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
  private async emulateViewport(params: Record<string, unknown>, controlledTabIds: Set<number>): Promise<unknown> {
    const preset = asOptionalString(params.preset);
    if (preset !== undefined && !VIEWPORT_PRESETS[preset]) throw connectorError("invalid_dimensions", `Unknown preset ${preset}; use mobile, tablet or desktop`);
    const requested = preset ? VIEWPORT_PRESETS[preset]! : { width: asOptionalNumber(params.width), height: asOptionalNumber(params.height) };
    if (requested.width === undefined || requested.height === undefined) throw connectorError("invalid_dimensions", "Give width and height, or a preset");
    /* Out-of-range sizes are clamped and said so, rather than refused: the agent wanted a narrow or a large view. */
    const width = Math.round(Math.min(7_680, Math.max(320, requested.width)));
    const height = Math.round(Math.min(4_320, Math.max(240, requested.height)));
    const clamped = width !== requested.width || height !== requested.height;
    const windowId = asOptionalNumber(params.windowId);
    const tabId = asOptionalNumber(params.tabId);
    const scope = windowId !== undefined ? { windowId } : tabId !== undefined ? { windowId: (await chrome.tabs.get(tabId)).windowId } : undefined;
    const tabs = scope
      ? (await chrome.tabs.query(scope)).flatMap((tab) => tab.id !== undefined && controlledTabIds.has(tab.id) ? [tab.id] : [])
      : [...controlledTabIds];
    if (!tabs.length) throw connectorError("tab_not_controlled", windowId !== undefined ? `Window ${windowId} holds no tab this session controls` : "This session controls no tab to size");
    const viewport = { width, height, mobile: width <= 480 };
    const applied: Array<{ tabId: number; previous?: { width: number; height: number; mobile: boolean } }> = [];
    try {
      for (const id of tabs) {
        applied.push({ tabId: id, previous: this.viewports.get(id) });
        this.viewports.set(id, viewport);
        await this.ensureDebugger(id);
        await this.applyViewport(id);
      }
    } catch (error) {
      /* All or nothing: tabs sized before the failure go back to what they were. */
      for (const entry of applied) {
        if (entry.previous) this.viewports.set(entry.tabId, entry.previous); else this.viewports.delete(entry.tabId);
        await this.cdp(entry.tabId, entry.previous ? "Emulation.setDeviceMetricsOverride" : "Emulation.clearDeviceMetricsOverride",
          entry.previous ? { width: entry.previous.width, height: entry.previous.height, deviceScaleFactor: 0, mobile: entry.previous.mobile } : undefined).catch(() => undefined);
        await this.cdp(entry.tabId, "Emulation.setTouchEmulationEnabled", { enabled: entry.previous?.mobile ?? false }).catch(() => undefined);
      }
      throw error;
    }
    return { ...(windowId !== undefined ? { windowId } : {}), width, height, emulated: true, tabIds: tabs, ...(clamped ? { clamped: true, requested } : {}) };
  }

  private async applyViewport(tabId: number): Promise<void> {
    const viewport = this.viewports.get(tabId);
    if (!viewport) return;
    await this.cdp(tabId, "Emulation.setDeviceMetricsOverride", { width: viewport.width, height: viewport.height, deviceScaleFactor: 0, mobile: viewport.mobile });
    await this.cdp(tabId, "Emulation.setTouchEmulationEnabled", { enabled: viewport.mobile }).catch(() => undefined);
  }

  private async uploadFile(params: Record<string, unknown>): Promise<unknown> {
    const tabId = asTabId(params.tabId);
    this.throwIfDialogOpen(tabId);
    const pageRef = asString(params.pageRef);
    const dataBase64 = asString(params.dataBase64);
    if (Math.floor(dataBase64.length * 0.75) > MAX_UPLOAD_BYTES) throw connectorError("file_too_large", "Upload exceeds 10 MiB");
    const uploaded = await this.runInPage(tabId, injectedUpload, [pageRef, asString(params.name), asString(params.mimeType), dataBase64, await this.generation(tabId)]);
    if (!uploaded) throw connectorError("upload_failed", "Target is stale or is not a file input");
    return { uploaded: true, name: params.name };
  }

  private async downloadFile(tabId: number, url: string): Promise<unknown> {
    this.throwIfDialogOpen(tabId);
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

  private async browserBatch(params: Record<string, unknown>, controlledTabIds: Set<number>, group: GroupDescriptor = DEFAULT_GROUP): Promise<unknown> {
    const actions = Array.isArray(params.actions) ? params.actions : [];
    const results: unknown[] = [];
    for (let index = 0; index < actions.length; index += 1) {
      const action = actions[index] as { tool?: unknown; arguments?: unknown };
      if (action.tool === "javascript_tool") throw connectorError("invalid_batch", "javascript_tool cannot be batched");
      if (typeof action.tool !== "string" || typeof action.arguments !== "object" || action.arguments === null) {
        throw connectorError("invalid_batch", `Invalid action at index ${index}`);
      }
      try {
        results.push(await this.dispatch(action.tool, action.arguments as Record<string, unknown>, controlledTabIds, group));
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

  /* The page's drag events can be inside an iframe, so probe every frame and sum. */
  private async dragProbe(tabId: number, reset: boolean): Promise<{ dragstart: number; dragover: number; drop: number } | undefined> {
    const results = await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func: injectedDragProbe, args: [reset] }).catch(() => undefined);
    if (!Array.isArray(results)) return undefined;
    return results.reduce((sum, frame) => {
      const value = frame?.result;
      if (!isRecord(value)) return sum;
      return {
        dragstart: sum.dragstart + Number(value.dragstart ?? 0),
        dragover: sum.dragover + Number(value.dragover ?? 0),
        drop: sum.drop + Number(value.drop ?? 0)
      };
    }, { dragstart: 0, dragover: 0, drop: 0 });
  }

  private async cdp(tabId: number, method: string, params?: Record<string, unknown>): Promise<object> {
    return (await chrome.debugger.sendCommand({ tabId }, method, params)) ?? {};
  }

  /* A JavaScript dialog blocks the renderer; every later scripting call would hang or
     fail with no diagnosis. ADR-0009 makes dismissing it a human step, so fail fast. */
  private throwIfDialogOpen(tabId: number): void {
    const dialog = this.dialogs.get(tabId);
    if (!dialog) return;
    const error = connectorError("javascript_dialog_open", `A ${dialog.type} dialog is blocking the page: ${JSON.stringify(dialog.message)}. The person must dismiss it; the connector does not accept or dismiss dialogs automatically.`) as Error & { code: string; outcomeUnknown: boolean; after?: unknown };
    error.after = { dialog, untrusted: true };
    throw error;
  }

  /* A stale ref usually means the element was re-created; name it and, when exactly
     one current element has the same identity, give the caller its new ref. */
  private async staleRefError(tabId: number, pageRef: string): Promise<Error & { code: string; outcomeUnknown: boolean }> {
    const previous = this.snapshots.forRef(tabId, pageRef);
    if (!previous) return connectorError("stale_page_ref", `Page Reference is stale: ${pageRef}`);
    const generation = await this.generation(tabId);
    const replacement = await this.runInPage(tabId, injectedReplacementRef, [previous.role, previous.name, previous.href, previous.level, generation]).catch(() => null);
    const label = [previous.role, previous.name].filter(part => typeof part === "string" && part).map(String).join(" ");
    const suffix = typeof replacement === "string"
      ? ` The element was re-created; use ${replacement} instead.`
      : " The element is gone; call read_page again.";
    return connectorError("stale_page_ref", `Page Reference is stale: ${pageRef}${label ? ` (${label.slice(0, 120)})` : ""}.${suffix}`);
  }

  /* With hitTest, the point is one where the element itself would receive the click: a point covered
     by an overlay, a hidden element or a disabled control is an error that names the cause. */
  private async pointForRef(tabId: number, pageRef: string, hitTest = false): Promise<{ x: number; y: number }> {
    const point = await this.runInPage(tabId, injectedRefPoint, [pageRef, await this.generation(tabId), hitTest]);
    if (!point) throw await this.staleRefError(tabId, pageRef);
    if (isRecord(point) && point.blocked === "hidden") throw connectorError("element_not_visible", `${pageRef} has no visible box`);
    if (isRecord(point) && point.blocked === "offscreen") throw connectorError("element_not_visible", `${pageRef} sits outside the visible viewport even after scrolling its frame into view. Scroll the page or enlarge the window, then retry.`);
    if (isRecord(point) && point.blocked === "disabled") throw connectorError("element_disabled", `${pageRef} is disabled`);
    if (isRecord(point) && typeof point.blockedBy === "string") throw connectorError("click_intercepted", `${pageRef} is covered by ${point.blockedBy} (quoted page content, untrusted)`);
    return point as { x: number; y: number };
  }

  private async focusRef(tabId: number, pageRef: string): Promise<void> {
    if (!await this.runInPage(tabId, injectedFocusRef, [pageRef, await this.generation(tabId)])) throw await this.staleRefError(tabId, pageRef);
  }

  private onDebuggerEvent(tabId: number | undefined, method: string, params?: object): void {
    if (tabId === undefined || !params) return;
    if (method === "Page.javascriptDialogOpening") {
      const event = params as { type?: string; message?: string };
      this.dialogs.set(tabId, { type: event.type ?? "alert", message: (event.message ?? "").slice(0, 300) });
      for (const resolve of this.dialogWaiters.get(tabId) ?? []) resolve();
      this.dialogWaiters.delete(tabId);
      return;
    }
    if (method === "Page.javascriptDialogClosed") { this.dialogs.delete(tabId); return; }
    if (method === "Input.dragIntercepted") {
      const event = params as { data?: unknown };
      if (event.data !== undefined) this.dragData.set(tabId, event.data);
      return;
    }
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
    } else if (method === "Network.loadingFinished" || method === "Network.loadingFailed") {
      const event = params as { requestId?: string; errorText?: string; canceled?: boolean };
      const record = [...(this.networkRecords.get(tabId) ?? [])].reverse().find((entry) => entry.requestId === event.requestId);
      if (record) {
        record.done = true;
        if (method === "Network.loadingFailed" && !event.canceled) record.failed = event.errorText ?? "failed";
      }
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

  private pushRecord<T extends { seenAt?: number }>(map: Map<number, T[]>, tabId: number, record: T): void {
    const records = map.get(tabId) ?? [];
    records.push({ ...record, seenAt: Date.now() });
    if (records.length > MAX_LOG_RECORDS) records.splice(0, records.length - MAX_LOG_RECORDS);
    map.set(tabId, records);
  }
}

function injectedReadPage(generation: number, maxBytes: number, offset: number, scopeRef: string | null, filter: "interactive" | "all" = "all", viewportOnly = false): unknown {
  const rt = (globalThis as RuntimeGlobal).__browserConnectorRuntime;
  if (!rt) throw new Error("browser-connector-runtime-missing");
  const state = rt.ensureState(generation);
  const scan = rt.scan();
  /* "interactive" (the default) keeps controls, headings and widget roles and drops prose, so a read
     costs a fraction of the tokens; get_page_text reads the prose. Wrapper roles carry nothing to act on. */
  const selector = filter === "interactive"
    ? "a,button,input,select,textarea,[role],[contenteditable=true],summary,[tabindex],h1,h2,h3,h4,h5,h6,label"
    : "a,button,input,select,textarea,[role],[contenteditable=true],summary,[tabindex],h1,h2,h3,h4,h5,h6,p,li";
  const wrapperRoles = new Set(["presentation", "none", "generic"]);
  const controlTags = new Set(["a", "button", "input", "select", "textarea", "summary"]);
  /* A <label for=email> and its input both match the same text, and the label is not
     the thing an agent can fill. Resolve the label to its control and dedupe. */
  const hasBox = (element: Element) => {
    const box = element.getBoundingClientRect();
    if (!(box.width > 0 && box.height > 0)) return false;
    const view = element.ownerDocument?.defaultView;
    const style = view?.getComputedStyle?.(element);
    return style?.visibility !== "hidden" && (style?.clip ?? "auto") === "auto" && (style?.clipPath ?? "none") === "none";
  };
  /* A visually hidden checkbox is clicked through its visible label, so the label
     stays the target when the control has no box. */
  const resolveLabel = (element: Element): Element => {
    if (element.tagName.toLowerCase() !== "label") return element;
    const control = (element as HTMLLabelElement).control;
    return control && hasBox(control) ? control : element;
  };
  const matched = [...new Set(scan.query(selector).map(resolveLabel))]
    .filter(element => filter !== "interactive" || !wrapperRoles.has(element.getAttribute("role") ?? ""));
  /* Frames and shadow hosts whose inside cannot be read still appear, as a node that says so. */
  const listed = new Set<Element>(matched);
  const elements = [...matched, ...[...scan.opaque.keys()].filter(element => !listed.has(element))] as HTMLElement[];
  /* Cursor positions still use the global traversal, even for scoped reads. Stable
     references come from the shared WeakMap so a find ref resolves in this traversal. */
  let scope: HTMLElement | null = null;
  if (scopeRef !== null) {
    scope = scan.all().find(element => state.refs.get(element) === scopeRef) ?? null;
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
    if (scope && element !== scope && !rt.within(scope, element)) continue;
    const rect = element.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) continue;
    if (viewportOnly) {
      /* An element in an iframe is measured in the frame's own viewport; the top one is what is on screen. */
      const origin = rt.frameOffset(element);
      if (rect.bottom + origin.y < 0 || rect.right + origin.x < 0 || rect.top + origin.y > innerHeight || rect.left + origin.x > innerWidth) continue;
    }
    const ref = rt.refFor(state, element);
    const input = rt.is(element, "HTMLInputElement") ? element as HTMLInputElement : undefined;
    const tag = element.tagName.toLowerCase();
    /* A control is named by its label; a container is named briefly, or its text repeats every child's. */
    const control = controlTags.has(tag) || /^(button|link|tab|menuitem|option|checkbox|radio|switch|combobox|textbox|searchbox|slider|treeitem)$/.test(element.getAttribute("role") ?? "");
    const name = rt.nameOf(element, control ? 200 : 120);
    /* The implicit role is what an agent needs to choose a primitive: a checkbox,
       combobox and textbox all arrive as <input>/<select>, not as their role. */
    const implicitRole = element.getAttribute("role")
      || (tag === "a" ? (element.getAttribute("href") !== null ? "link" : tag)
        : tag === "button" || tag === "summary" ? "button"
          : tag === "select" ? "combobox"
            : tag === "textarea" ? "textbox"
              : /^h[1-6]$/.test(tag) ? "heading"
                : tag === "img" ? "img"
                  : tag === "input" ? (input!.type === "checkbox" ? "checkbox" : input!.type === "radio" ? "radio" : /^(button|submit|reset|image)$/.test(input!.type) ? "button" : input!.type === "range" ? "slider" : input!.type === "search" ? "searchbox" : "textbox")
                    : tag);
    const node: Record<string, unknown> = {
      ref,
      role: implicitRole,
      ...(input ? { type: input.type } : {}),
      name,
      disabled: "disabled" in element ? Boolean((element as HTMLButtonElement).disabled) : undefined,
      checked: "checked" in element ? Boolean((element as HTMLInputElement).checked) : undefined
    };
    /* State an agent needs to tell whether its last action worked: which tab is selected, what is open. */
    for (const [attribute, key] of [["aria-selected", "selected"], ["aria-expanded", "expanded"], ["aria-pressed", "pressed"], ["aria-checked", "checked"]] as const) {
      const attributeState = element.getAttribute(attribute);
      if (attributeState === "true" || attributeState === "false") node[key] = attributeState === "true";
    }
    const current = element.getAttribute("aria-current");
    if (current && current !== "false") node.current = current;
    /* validity, not checkValidity(): the latter fires "invalid" events. An empty required field is not yet an error. */
    if (element.getAttribute("aria-invalid") === "true" || (input && input.validity && !input.validity.valid && input.value !== "")) node.invalid = true;
    if (rt.activeIn(element) === element) node.focused = true;
    if (/^h[1-6]$/.test(tag)) node.level = Number(tag[1]);
    const href = tag === "a" ? (element as HTMLAnchorElement).href : undefined;
    if (href) {
      try { const url = new URL(href); node.href = url.origin === location.origin ? url.pathname : url.origin + url.pathname; } catch { /* not a URL */ }
    }
    for (const key of Object.keys(node)) if (node[key] === undefined) delete node[key];
    if (rt.is(element, "HTMLSelectElement")) {
      const select = element as HTMLSelectElement;
      const selected = [...select.selectedOptions].map(option => option.text.trim());
      node.options = [...select.options].slice(0, 30).map(option => ({ value: option.value, label: option.text.trim(), selected: option.selected }));
      if (select.multiple) node.multiple = true;
      node.value = select.multiple ? selected : selected[0] ?? "";
    } else if (rt.is(element, "HTMLTextAreaElement")) {
      node.value = (element as HTMLTextAreaElement).value.slice(0, 500);
    } else if (input) {
      node.value = rt.sensitive(input) ? "[redacted]" : input.value.slice(0, 500);
    }
    const opaqueReason = scan.opaque.get(element);
    if (opaqueReason) {
      const title = element.getAttribute("title") || element.getAttribute("aria-label");
      node.opaque = true;
      node.name = `${tag}${title ? ` "${title.slice(0, 60)}"` : ""} (${opaqueReason})`;
    }
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
  const rt = (globalThis as RuntimeGlobal).__browserConnectorRuntime;
  /* innerText stops at a shadow boundary, so each open shadow root inside the chosen
     container contributes its own text. */
  const shadowText = (container: Element | Document): string[] => {
    if (!rt) return [];
    return rt.scan().roots
      .filter(entry => entry.root.nodeType === 11 && entry.host
        && (container === document || container === entry.host || (container as Element).contains?.(entry.host) || entry.host.contains(container as Element)))
      .map(entry => ((entry.root as ShadowRoot).textContent ?? "").trim())
      .filter(Boolean);
  };
  if (scopeRef !== null) {
    if (!rt) throw new Error("browser-connector-runtime-missing");
    const state = rt.currentState(generation);
    const root = state ? rt.scan().resolve(scopeRef, state) : null;
    if (!root?.isConnected) return { text: "", scopeRef, staleScopeRef: true };
    return { text: [root.innerText ?? root.textContent ?? "", ...shadowText(root)].join("\n").trim(), scopeRef };
  }
  /* main first: a dashboard of several article cards has no single article that is the page. */
  const root = document.querySelector("main,[role=main]") ?? document.body;
  return { text: [(root as HTMLElement).innerText ?? root.textContent ?? "", ...shadowText(root)].join("\n").trim() };
}

function injectedFind(generation: number, query: string, limit: number, offset: number): unknown {
  const rt = (globalThis as RuntimeGlobal).__browserConnectorRuntime;
  if (!rt) throw new Error("browser-connector-runtime-missing");
  const state = rt.ensureState(generation);
  const needle = query.toLowerCase();
  /* "body *" in the document and in each iframe, "*" inside shadow roots, which have no body. */
  const elements = rt.scan().query("body *", "*");
  /* Label, title, name, placeholder and text often repeat each other; each distinct one counts once. */
  const ownText = (element: HTMLElement) => [...new Set([element.getAttribute("aria-label"), (element as HTMLInputElement).labels?.[0]?.innerText, element.getAttribute("title"), element.getAttribute("name"), element.getAttribute("placeholder"), element.innerText]
    .map(part => part?.trim()).filter((part): part is string => !!part))].join(" ");
  const hits: HTMLElement[] = [];
  for (const element of elements) {
    if (!ownText(element).toLowerCase().includes(needle)) continue;
    const rect = element.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) continue;
    hits.push(element);
    if (hits.length >= 2_000) break;
  }
  /* Every ancestor of a match also contains its text; only the innermost matches name the thing
     asked for. Controls come first, since they are what an agent acts on. A host contains what is
     in its shadow root or its iframe even though contains() does not say so. */
  const hosts = new Map<HTMLElement, Element[]>();
  for (const element of hits) { const chain = rt.hostChain(element); if (chain.length) hosts.set(element, chain); }
  const encloses = (outer: HTMLElement, inner: HTMLElement) => outer.contains(inner) || !!hosts.get(inner)?.some(host => host === outer || outer.contains(host));
  const interactive = (element: HTMLElement) => /^(a|button|input|select|textarea|summary|label)$/i.test(element.tagName) || !!element.getAttribute("role") || element.hasAttribute?.("tabindex");
  /* A button's text sits in a span inside it; the control is what an agent acts on, so a match is
     lifted to its nearest interactive ancestor, and duplicates collapse. */
  const lift = (element: HTMLElement) => {
    const lifted = (element.closest?.("a,button,input,select,textarea,summary,label,[role],[tabindex]") as HTMLElement | null) ?? element;
    if (lifted.tagName.toLowerCase() !== "label") return lifted;
    const control = (lifted as HTMLLabelElement).control as HTMLElement | null;
    if (!control) return lifted;
    const box = control.getBoundingClientRect();
    const view = control.ownerDocument?.defaultView;
    const style = view?.getComputedStyle?.(control);
    const shown = box.width > 0 && box.height > 0 && style?.visibility !== "hidden"
      && (style?.clip ?? "auto") === "auto" && (style?.clipPath ?? "none") === "none";
    return shown ? control : lifted;
  };
  const innermost = [...new Set(hits.filter(element => !hits.some(other => other !== element && encloses(element, other))).map(lift))];
  /* Exact names first, then names that start with the query, then any that contain it; within each,
     controls before other elements. "Keluar" should find the menu item, not "Laporan barang keluar". */
  const closeness = (element: HTMLElement) => {
    const name = ownText(element).trim().replace(/\s+/g, " ").toLowerCase();
    const label = (element.getAttribute("aria-label") ?? element.innerText ?? "").trim().toLowerCase();
    return name === needle || label === needle ? 0 : name.startsWith(needle) || label.startsWith(needle) ? 1 : 2;
  };
  const ranked = innermost.map((element, index) => ({ element, index, rank: closeness(element) * 2 + (interactive(element) ? 0 : 1) }))
    .sort((left, right) => left.rank - right.rank || left.index - right.index).map(entry => entry.element);
  const page = ranked.slice(offset, offset + limit);
  const matches = page.map(element => ({
    ref: rt.refFor(state, element),
    role: element.getAttribute("role") || element.tagName.toLowerCase(),
    name: ownText(element).trim().replace(/\s+/g, " ").slice(0, 200)
  }));
  const hasMore = offset + page.length < ranked.length;
  return { matches, nextCursor: hasMore ? String(offset + matches.length) : null, truncated: hasMore };
}

function injectedDescribeRef(pageRef: string, generation: number): { description: string; destinationOrigin?: string } {
  const rt = (globalThis as RuntimeGlobal).__browserConnectorRuntime;
  if (!rt) throw new Error("browser-connector-runtime-missing");
  const state = rt.currentState(generation);
  if (!state) return { description: "" };
  const element = rt.scan().resolve(pageRef, state);
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

/* The point is in top-level viewport coordinates, which is what the debugger's mouse events take,
   even when the element sits inside an iframe. */
async function injectedRefPoint(pageRef: string, generation: number, hitTest = false): Promise<{ x: number; y: number } | { blocked: "hidden" | "disabled" | "offscreen" } | { blockedBy: string } | null> {
  const rt = (globalThis as RuntimeGlobal).__browserConnectorRuntime;
  if (!rt) throw new Error("browser-connector-runtime-missing");
  const state = rt.currentState(generation);
  if (!state) return null;
  const element = rt.scan().resolve(pageRef, state);
  if (!element) return null;
  const hosts = rt.hostChain(element);
  /* A frame below the fold has no top-viewport point. Scroll each host into view,
     outermost first, before measuring the element inside it. */
  for (const host of [...hosts].reverse()) {
    const frame = host as HTMLElement;
    if (typeof frame.scrollIntoView === "function") frame.scrollIntoView({ block: "center", inline: "center", behavior: "instant" as ScrollBehavior });
  }
  /* Instant, then two frames: a smooth scroll or a layout shift would otherwise move the target
     after its centre was measured, and the click would land on whatever slid into that spot. */
  element.scrollIntoView({ block: "center", inline: "center", behavior: "instant" as ScrollBehavior });
  if (typeof requestAnimationFrame === "function") await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  const rect = element.getBoundingClientRect();
  const origin = rt.frameOffset(element);
  const toTop = (point: { x: number; y: number }) => ({ x: point.x + origin.x, y: point.y + origin.y });
  const centre = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  if (!hitTest) return toTop(centre);
  const view = element.ownerDocument?.defaultView ?? globalThis;
  if ((rect.width === 0 || rect.height === 0 || view.getComputedStyle(element).visibility === "hidden") && !(element as HTMLInputElement).labels?.length) return { blocked: "hidden" };
  if ((element as HTMLButtonElement).disabled === true || element.matches?.(":disabled") || element.getAttribute("aria-disabled") === "true") return { blocked: "disabled" };
  /* A visually hidden checkbox or switch is clicked through its label. */
  const labels = [...((element as HTMLInputElement).labels ?? [])];
  const ownerDocument = element.ownerDocument ?? document;
  if (typeof ownerDocument.elementFromPoint !== "function") return toTop(centre);
  /* Inside a shadow root the document reports the host, so the element is asked of its own root
     as well; inside an iframe, something in the top page can still cover the whole frame. */
  const rootNode = element.getRootNode?.() as (Partial<Document> & { nodeType?: number }) | undefined;
  const ownRoot = rootNode?.nodeType === 11 && typeof rootNode.elementFromPoint === "function" ? rootNode : undefined;
  const frames = hosts.filter(host => /^i?frame$/i.test(String(host.tagName)));
  /* The centre first; a wide wrapper's centre can be a gap, so a few inner points next. */
  const insetX = Math.min(12, rect.width / 4); const insetY = Math.min(8, rect.height / 4);
  const points = [centre, { x: rect.left + insetX, y: centre.y }, { x: rect.right - insetX, y: centre.y }, { x: centre.x, y: rect.top + insetY }, { x: centre.x, y: rect.bottom - insetY }];
  let blocker: Element | null = null;
  let offscreen = false;
  for (const point of points) {
    let hit = ownRoot ? ownRoot.elementFromPoint!(point.x, point.y) : ownerDocument.elementFromPoint(point.x, point.y);
    if (ownRoot && !hit) {
      /* The shadow root only reports its own tree; whatever else is on top is a cover unless it is the host. */
      const onTop = ownerDocument.elementFromPoint(point.x, point.y);
      if (onTop && !hosts.includes(onTop)) hit = onTop;
    }
    const reachesElement = hit && (hit === element || element.contains(hit) || labels.some(label => label === hit || label.contains(hit)));
    if (reachesElement) {
      const top = toTop(point);
      /* The renderer ignores a press outside the viewport; report that instead of a click. */
      if (top.x < 0 || top.y < 0 || top.x > innerWidth || top.y > innerHeight) { offscreen = true; continue; }
      const outer = frames.length ? document.elementFromPoint(top.x, top.y) : null;
      if (!frames.length || !outer || hosts.includes(outer) || frames[frames.length - 1]!.contains(outer)) return top;
      blocker ??= outer;
      continue;
    }
    blocker ??= hit;
  }
  if (offscreen) return { blocked: "offscreen" };
  if (!blocker) return toTop(centre);
  const describe = (node: Element) => `${node.getAttribute("role") || node.tagName.toLowerCase()} "${((node as HTMLElement).innerText || node.getAttribute("aria-label") || "").trim().replace(/\s+/g, " ").slice(0, 60)}"`;
  const covering = blocker.closest("[role=dialog],[role=alertdialog],[role=alert],[role=status],dialog,header,nav") ?? blocker;
  return { blockedBy: describe(covering) };
}

/* Counts the page's own drag events, so a gesture the page ignored is visible in the
   result instead of looking the same as a drop that landed elsewhere. */
function injectedDragProbe(reset: boolean): { dragstart: number; dragover: number; drop: number } {
  const global = globalThis as typeof globalThis & { __browserConnectorDrag?: { dragstart: number; dragover: number; drop: number; installed?: boolean } };
  if (!global.__browserConnectorDrag) global.__browserConnectorDrag = { dragstart: 0, dragover: 0, drop: 0 };
  const state = global.__browserConnectorDrag;
  if (reset) {
    state.dragstart = 0; state.dragover = 0; state.drop = 0;
    if (!state.installed) {
      state.installed = true;
      for (const type of ["dragstart", "dragover", "drop"] as const) {
        document.addEventListener(type, () => { state[type] += 1; }, true);
      }
    }
  }
  return { dragstart: state.dragstart, dragover: state.dragover, drop: state.drop };
}

/* After the dwell, before the press: is the element still the one at its own centre,
   and where is that centre now? Returns the element's identity so the result names it. */
export function injectedClickGuard(pageRef: string, generation: number, x: number, y: number): { point: { x: number; y: number }; role?: string; name?: string } | { blockedBy: string } | null {
  const rt = (globalThis as RuntimeGlobal).__browserConnectorRuntime;
  if (!rt) throw new Error("browser-connector-runtime-missing");
  const state = rt.currentState(generation);
  const element = state ? rt.scan().resolve(pageRef, state) : null;
  if (!element) return null;
  const rect = element.getBoundingClientRect();
  const view = element.ownerDocument?.defaultView ?? globalThis;
  if (rect.width === 0 || rect.height === 0 || view.getComputedStyle(element).visibility === "hidden") return { blockedBy: "a hidden element" };
  /* Verify the point pointForRef already validated, in the element's own root: the
     top document reports a shadow host, not the element inside it. */
  const origin = rt.frameOffset(element);
  const local = { x: x - origin.x, y: y - origin.y };
  const ownerDocument = element.ownerDocument ?? document;
  const rootNode = element.getRootNode?.() as (Partial<Document> & { nodeType?: number }) | undefined;
  const ownRoot = rootNode?.nodeType === 11 && typeof rootNode.elementFromPoint === "function" ? rootNode : undefined;
  const hit = ownRoot ? ownRoot.elementFromPoint!(local.x, local.y) : ownerDocument.elementFromPoint?.(local.x, local.y);
  const labels = [...((element as HTMLInputElement).labels ?? [])];
  const reaches = hit && (hit === element || element.contains(hit) || labels.some(label => label === hit || label.contains(hit)));
  if (!reaches) {
    const onTop = ownRoot ? ownerDocument.elementFromPoint?.(local.x, local.y) : null;
    const blocker = onTop && !rt.hostChain(element).includes(onTop) ? onTop : hit;
    if (blocker) {
      const described = `${blocker.getAttribute("role") || blocker.tagName.toLowerCase()} "${((blocker as HTMLElement).innerText || blocker.getAttribute("aria-label") || "").trim().replace(/\s+/g, " ").slice(0, 60)}"`;
      return { blockedBy: described };
    }
  }
  return { point: { x, y }, role: element.getAttribute("role") || element.tagName.toLowerCase(), name: rt.nameOf(element as HTMLElement, 120) };
}

function injectedFocusRef(pageRef: string, generation: number): boolean {
  const rt = (globalThis as RuntimeGlobal).__browserConnectorRuntime;
  if (!rt) throw new Error("browser-connector-runtime-missing");
  const state = rt.currentState(generation);
  const element = state ? rt.scan().resolve(pageRef, state) : null;
  if (!element) return false;
  element.focus();
  return rt.activeIn(element) === element;
}

/* The element that will receive the next keystroke, across open shadow roots and
   same-origin frames, so `type` reports the field the page actually kept. */
export function injectedActiveElement(): { tag: string; type?: string; role?: string; editable: boolean; value?: string; text?: string } | null {
  let root: Document | ShadowRoot = document;
  let element: Element | null = null;
  for (let depth = 0; depth < 8; depth += 1) {
    const active: Element | null = root.activeElement;
    if (!active) break;
    element = active;
    const shadow: ShadowRoot | null = (active as HTMLElement).shadowRoot;
    if (shadow) { root = shadow; continue; }
    if (active.tagName === "IFRAME") {
      try {
        const frame: Document | null = (active as HTMLIFrameElement).contentDocument;
        if (frame) { root = frame; continue; }
      } catch { /* cross-origin frame: report the iframe itself */ }
    }
    break;
  }
  if (!element) return null;
  const tag = element.tagName.toLowerCase();
  const role = element.getAttribute("role") ?? undefined;
  const field = element as unknown as { type?: string; value?: string; readOnly?: boolean; disabled?: boolean; isContentEditable?: boolean };
  if (tag === "input") {
    const type = field.type ?? "text";
    const runtime = (globalThis as RuntimeGlobal).__browserConnectorRuntime;
    /* read_page and form_input already redact OTP, card and password fields by name,
       autocomplete and type; a typed read-back must not become the leak. */
    const sensitive = runtime ? runtime.sensitive(element as HTMLInputElement) : type === "password";
    return { tag, type, ...(role ? { role } : {}), editable: !field.readOnly && !field.disabled, value: sensitive ? "[redacted]" : String(field.value ?? "").slice(0, 500) };
  }
  if (tag === "textarea") return { tag, ...(role ? { role } : {}), editable: !field.readOnly && !field.disabled, value: String(field.value ?? "").slice(0, 500) };
  if (field.isContentEditable) return { tag, ...(role ? { role } : {}), editable: true, text: (element.textContent ?? "").slice(0, 500) };
  if (tag === "select") return { tag, ...(role ? { role } : {}), editable: !field.disabled, value: String(field.value ?? "") };
  return { tag, ...(role ? { role } : {}), editable: false, text: (element.textContent ?? "").slice(0, 200) };
}

/* Where the page and the element's nearest scrollable ancestor stand, so a scroll
   reports what moved instead of only what was requested. */
function injectedScrollState(pageRef: string | null, generation: number, x?: number, y?: number): { x: number; y: number; container?: { top: number; left: number }; frames: Array<{ x: number; y: number }> } {
  const rt = (globalThis as RuntimeGlobal).__browserConnectorRuntime;
  /* A scroll container may live inside a shadow root, whose parentElement is null. */
  const parentOf = (node: HTMLElement): HTMLElement | null =>
    node.parentElement ?? (((node.getRootNode?.() as ShadowRoot | undefined)?.host as HTMLElement | undefined) ?? null);
  const nearestScrollable = (start: HTMLElement | null): HTMLElement | null => {
    let node = start;
    while (node && node !== document.body && node !== document.documentElement) {
      const style = getComputedStyle(node);
      const scrollable = /(auto|scroll|overlay)/.test(`${style.overflowY} ${style.overflowX}`)
        && (node.scrollHeight > node.clientHeight || node.scrollWidth > node.clientWidth);
      if (scrollable) return node;
      node = parentOf(node);
    }
    return null;
  };
  /* For a coordinate, descend into an iframe or an open shadow root before choosing. */
  const deepElement = (doc: Document, px: number, py: number, depth: number): Element | null => {
    const hit = doc.elementFromPoint?.(px, py) ?? null;
    if (!hit || depth > 6) return hit;
    if (String(hit.tagName).toUpperCase() === "IFRAME") {
      try {
        const frame = (hit as HTMLIFrameElement).contentDocument;
        if (frame) {
          const rect = hit.getBoundingClientRect();
          return deepElement(frame, px - rect.left - ((hit as HTMLElement).clientLeft || 0), py - rect.top - ((hit as HTMLElement).clientTop || 0), depth + 1);
        }
      } catch { /* cross-origin */ }
      return hit;
    }
    const shadow = (hit as HTMLElement).shadowRoot;
    if (shadow) return shadow.elementFromPoint?.(px, py) ?? hit;
    return hit;
  };
  let element: HTMLElement | null = null;
  if (pageRef && rt) {
    const state = rt.currentState(generation);
    element = (state ? rt.scan().resolve(pageRef, state) : null) as HTMLElement | null;
  } else if (typeof x === "number" && typeof y === "number") {
    element = deepElement(document, x, y, 0) as HTMLElement | null;
  }
  const container = nearestScrollable(element);
  /* The element's own document and every frame between it and the top viewport. */
  const frames: Array<{ x: number; y: number }> = [];
  if (element) {
    const own = element.ownerDocument?.defaultView;
    if (own) frames.push({ x: own.scrollX, y: own.scrollY });
    for (const host of rt?.hostChain(element) ?? []) {
      if (!/^i?frame$/i.test(String(host.tagName))) continue;
      try {
        const view = (host as HTMLIFrameElement).contentWindow;
        if (view) frames.push({ x: view.scrollX, y: view.scrollY });
      } catch { /* cross-origin */ }
    }
  }
  if (!frames.length) frames.push({ x: window.scrollX, y: window.scrollY });
  return { x: window.scrollX, y: window.scrollY, ...(container ? { container: { top: container.scrollTop, left: container.scrollLeft } } : {}), frames };
}

/* The page's own ref generation, if it still belongs to the current document. */
function injectedDocumentGeneration(): number | null {
  const state = (globalThis as RuntimeGlobal).__browserConnectorPageRefState;
  return state && state.document === document ? state.generation : null;
}

/* The focused element as a Page Reference, so a settle result can name where the
   next keystroke would go without a second read_page. */
function injectedFocusInfo(generation: number): { ref?: string; role?: string; name?: string } | null {
  const rt = (globalThis as RuntimeGlobal).__browserConnectorRuntime;
  if (!rt) return null;
  const state = rt.currentState(generation);
  let root: Document | ShadowRoot = document;
  let element: Element | null = null;
  for (let depth = 0; depth < 8; depth += 1) {
    const active: Element | null = root.activeElement;
    if (!active) break;
    element = active;
    const shadow: ShadowRoot | null = (active as HTMLElement).shadowRoot;
    if (shadow) { root = shadow; continue; }
    if (active.tagName === "IFRAME") {
      try {
        const frame: Document | null = (active as HTMLIFrameElement).contentDocument;
        if (frame) { root = frame; continue; }
      } catch { /* cross-origin frame: report the iframe itself */ }
    }
    break;
  }
  if (!element) return null;
  /* body and ordinary containers are not where a keystroke goes; reporting them
     echoes page text into every result without naming a target. */
  const tag = element.tagName.toLowerCase();
  const role = element.getAttribute("role") ?? "";
  const field = tag === "input" || tag === "textarea" || tag === "select"
    || (element as HTMLElement).isContentEditable
    || ["textbox", "searchbox", "combobox"].includes(role);
  if (!field) return null;
  const html = element as HTMLElement;
  return {
    ...(state ? { ref: rt.refFor(state, html) } : {}),
    role: element.getAttribute("role") || tag,
    name: rt.nameOf(html, 120)
  };
}

/* A stale ref is usually a re-render, not a deletion. Look for exactly one element
   with the old role and name and hand back its new ref; never retarget silently. */
function injectedReplacementRef(role: unknown, name: unknown, href: unknown, level: unknown, generation: number): string | null {
  const rt = (globalThis as RuntimeGlobal).__browserConnectorRuntime;
  if (!rt) return null;
  const state = rt.currentState(generation);
  if (!state) return null;
  const wantedRole = String(role ?? "");
  const wantedName = String(name ?? "").slice(0, 200);
  const wantedHref = String(href ?? "");
  const wantedLevel = typeof level === "number" ? level : undefined;
  const roleOf = (element: Element): string => {
    const tag = element.tagName.toLowerCase();
    const type = String((element as HTMLInputElement).type ?? "").toLowerCase();
    return element.getAttribute("role")
      || (tag === "a" ? (element.getAttribute("href") !== null ? "link" : tag)
        : tag === "button" || tag === "summary" ? "button"
          : tag === "select" ? "combobox"
            : tag === "textarea" ? "textbox"
              : /^h[1-6]$/.test(tag) ? "heading"
                : tag === "img" ? "img"
                  : tag === "input" ? (type === "checkbox" ? "checkbox" : type === "radio" ? "radio" : /^(button|submit|reset|image)$/.test(type) ? "button" : type === "range" ? "slider" : type === "search" ? "searchbox" : "textbox")
                    : tag);
  };
  const matches = rt.scan().all().filter(element => {
    if (roleOf(element) !== wantedRole) return false;
    const currentName = rt.nameOf(element as HTMLElement, 300);
    const compare = Math.min(currentName.length, wantedName.length);
    if (compare === 0 || currentName.slice(0, compare) !== wantedName.slice(0, compare)) return false;
    if (wantedLevel !== undefined) {
      const tag = element.tagName.toLowerCase();
      if (/^h[1-6]$/.test(tag) && Number(tag[1]) !== wantedLevel) return false;
    }
    if (wantedHref) {
      const anchor = element.tagName.toLowerCase() === "a" ? (element as HTMLAnchorElement).href : "";
      let normalized = "";
      try { const url = new URL(anchor); normalized = url.origin === location.origin ? url.pathname : url.origin + url.pathname; } catch { /* not a URL */ }
      if (normalized !== wantedHref) return false;
    }
    return true;
  });
  return matches.length === 1 ? rt.refFor(state, matches[0] as HTMLElement) : null;
}

export function injectedFormInput(pageRef: string, value: unknown, generation: number): false | { unsupported: true } | { refused: string } | { missingOption: true; options: string } | { invalidType: "boolean" } | { radioCannotUncheck: true } | { matched: boolean; actual: unknown; before?: unknown; unverified?: string } {
  const rt = (globalThis as RuntimeGlobal).__browserConnectorRuntime;
  if (!rt) throw new Error("browser-connector-runtime-missing");
  const state = rt.currentState(generation);
  const resolved = state ? rt.scan().resolve(pageRef, state) : null;
  if (!resolved) return false;
  /* read_page and find return the visible label when its control has no box; the
     form value still belongs to the control. */
  const element = resolved.tagName.toLowerCase() === "label"
    ? ((resolved as HTMLLabelElement).control as HTMLElement | null) ?? resolved
    : resolved;
  /* An element in an iframe is dispatched events built by its own window, and tested against its own classes. */
  const view = (element.ownerDocument?.defaultView ?? globalThis) as typeof globalThis;
  const fire = () => {
    const EventClass = view.Event ?? Event;
    element.dispatchEvent(new EventClass("input", { bubbles: true }));
    element.dispatchEvent(new EventClass("change", { bubbles: true }));
  };
  /* Frameworks such as React keep their own copy of a field's value and ignore an assignment to
     element.value; the prototype's setter is what a person's typing goes through. */
  const setNative = (target: HTMLInputElement | HTMLTextAreaElement, next: string) => {
    let prototype: object | null = Object.getPrototypeOf(target);
    let setter: ((this: unknown, value: string) => void) | undefined;
    while (prototype && !setter) { setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set; prototype = Object.getPrototypeOf(prototype); }
    if (setter) setter.call(target, next); else target.value = next;
  };
  if ((element as HTMLInputElement).disabled || element.matches?.(":disabled")) return { refused: "disabled" };
  if ((element as HTMLInputElement).readOnly) return { refused: "read-only" };
  const isInput = rt.is(element, "HTMLInputElement");
  if (isInput && (element as HTMLInputElement).type === "file") return { unsupported: true };
  /* Focus first and blur after, as typing would: some forms validate on blur. */
  element.focus?.();
  if (isInput && ((element as HTMLInputElement).type === "checkbox" || (element as HTMLInputElement).type === "radio")) {
    const checkbox = element as HTMLInputElement;
    if (value !== true && value !== false) return { invalidType: "boolean" };
    const wanted = value;
    const before = checkbox.checked;
    if (checkbox.type === "radio" && !wanted) return { radioCannotUncheck: true };
    /* A click, not an assignment: it is the event a framework listens to, and it toggles exactly once. */
    if (checkbox.checked !== wanted) checkbox.click();
    return { matched: checkbox.checked === wanted, actual: checkbox.checked, before };
  }
  if (isInput || rt.is(element, "HTMLTextAreaElement")) {
    const field = element as HTMLInputElement | HTMLTextAreaElement;
    const hidden = isInput && rt.sensitive(field as HTMLInputElement);
    const before = hidden ? "[redacted]" : field.value.slice(0, 500);
    const next = String(value ?? "");
    setNative(field, next);
    fire();
    field.blur?.();
    return { matched: field.value === next, actual: hidden ? "[redacted]" : field.value.slice(0, 500), before };
  }
  if (rt.is(element, "HTMLSelectElement")) {
    const select = element as HTMLSelectElement;
    const before = [...select.selectedOptions].map(option => option.text.trim());
    const wanted = (Array.isArray(value) ? value : [value]).map(item => String(item ?? "").trim().toLowerCase());
    const options = [...select.options];
    const picks = wanted.map(item => options.find(option => option.value.toLowerCase() === item) ?? options.find(option => option.text.trim().toLowerCase() === item));
    if (picks.some(pick => !pick)) return { missingOption: true, options: options.slice(0, 30).map(option => option.text.trim()).join(" | ") };
    for (const option of options) option.selected = picks.includes(option);
    if (!select.multiple && picks[0]) select.value = picks[0].value;
    fire();
    const actual = [...select.selectedOptions].map(option => option.text.trim());
    return { matched: picks.every(pick => pick!.selected), actual: select.multiple ? actual : actual[0], before: select.multiple ? before : before[0] };
  }
  if (element.isContentEditable) {
    const before = (element.textContent ?? "").slice(0, 500);
    element.textContent = String(value ?? "");
    element.dispatchEvent(new (view.InputEvent ?? InputEvent)("input", { bubbles: true }));
    /* Rich editors (Slate, Lexical, Draft) keep their own model and may ignore this; say so. */
    return { matched: element.textContent === String(value ?? ""), actual: (element.textContent ?? "").slice(0, 500), before, unverified: "A rich-text editor may ignore a direct write; check the page or use computer type." };
  }
  return { unsupported: true };
}

/* A change counter for the page, installed once per document: settle and wait_for poll it. It also
   keeps the text of notices the page announces (alerts, status toasts, dialogs), which is usually
   how an app says whether an action worked. */
function injectedMutationState(): { count: number; sequence: number; notices: Array<{ sequence: number; text: string }>; present: string[] } {
  type State = { count: number; sequence: number; notices: Array<{ sequence: number; text: string }> };
  const global = globalThis as typeof globalThis & { __browserConnectorMutations?: State };
  if (!global.__browserConnectorMutations) {
    const state: State = { count: 0, sequence: 0, notices: [] };
    global.__browserConnectorMutations = state;
    /* Polite live regions are often whole tables or panels, so a polite notice is
       accepted only when it is short and visible; assertive roles carry a toast. */
    const noticeSelector = "[role=alert],[role=status],[role=dialog],[role=alertdialog],[aria-live=assertive],[aria-live=polite]";
    /* Each announcement gets a sequence number, so the same "Tersimpan" shown twice is reported twice. */
    const note = (element: Element | null) => {
      const target = element as HTMLElement | null;
      const text = target?.innerText?.trim().replace(/\s+/g, " ").slice(0, 200);
      if (!text || text.length >= 200) return;
      const rect = target?.getBoundingClientRect();
      if (rect && rect.width === 0 && rect.height === 0) return;
      state.sequence += 1;
      state.notices = [...state.notices, { sequence: state.sequence, text }].slice(-10);
    };
    new MutationObserver(records => {
      state.count += records.length;
      for (const record of records) {
        if (record.type === "characterData") { note(record.target.parentElement?.closest(noticeSelector) ?? null); continue; }
        for (const node of record.addedNodes) {
          if (node instanceof HTMLElement) note(node.matches(noticeSelector) ? node : node.closest(noticeSelector) ?? node.querySelector(noticeSelector));
          else if (node.nodeType === 3) note(node.parentElement?.closest(noticeSelector) ?? null);
        }
      }
    /* Only attributes that mean a state change: style churn from animations would keep the page "busy". */
    }).observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["class", "hidden", "disabled", "open", "aria-selected", "aria-expanded", "aria-checked", "aria-hidden", "aria-busy"] });
  }
  const state = global.__browserConnectorMutations;
  const present = [...document.querySelectorAll("[role=alert],[role=status],[role=dialog],[role=alertdialog],[aria-live=assertive],[aria-live=polite]")]
    .map(element => (element as HTMLElement).innerText?.trim().replace(/\s+/g, " ").slice(0, 200)).filter((text): text is string => !!text);
  return { count: state.count, sequence: state.sequence, notices: state.notices, present };
}

function injectedWaitCheck(text: string | null, textGone: string | null, selector: string | null): { text?: boolean; textGone?: boolean; selector?: boolean; invalidSelector?: true } {
  const rt = (globalThis as RuntimeGlobal).__browserConnectorRuntime;
  if (!rt) throw new Error("browser-connector-runtime-missing");
  const scan = rt.scan();
  /* visibleText follows open shadow roots and same-origin frames; inline script text and
     hidden DOM are not what a person sees. */
  const body = rt.visibleText(scan).toLowerCase();
  let selectorOk: boolean | undefined;
  let invalidSelector: true | undefined;
  if (selector !== null) {
    try { selectorOk = scan.query(selector).some(element => rt.visible(element)); }
    catch { invalidSelector = true; }
  }
  return {
    ...(text !== null ? { text: body.includes(text.toLowerCase()) } : {}),
    ...(textGone !== null ? { textGone: !body.includes(textGone.toLowerCase()) } : {}),
    ...(selector !== null && selectorOk !== undefined ? { selector: selectorOk } : {}),
    ...(invalidSelector ? { invalidSelector } : {})
  };
}

function injectedUpload(pageRef: string, name: string, mimeType: string, dataBase64: string, generation: number): boolean {
  const rt = (globalThis as RuntimeGlobal).__browserConnectorRuntime;
  if (!rt) throw new Error("browser-connector-runtime-missing");
  const state = rt.currentState(generation);
  const input = (state ? rt.scan().resolve(pageRef, state) : null) as HTMLInputElement | null;
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

export type ParsedExpectation =
  | (PageExpectation & { kind: "text_present" | "text_absent" | "element" | "count" })
  | { index: number; kind: "url_matches" | "title_matches"; pattern: string };

const EXPECTATION_KINDS = new Set(["text_present", "text_absent", "url_matches", "title_matches", "element", "count"]);
const ELEMENT_STATES = new Set(["visible", "hidden", "enabled", "disabled", "checked", "unchecked", "expanded", "collapsed", "selected", "pressed", "focused"]);

/* Validates the whole list up front, so a typo in the tenth expectation does not waste the first nine. */
export function parseExpectations(value: unknown): ParsedExpectation[] {
  if (!Array.isArray(value) || !value.length || value.length > ASSERT_MAX_EXPECTATIONS) {
    throw connectorError("invalid_arguments", `assert needs 1 to ${ASSERT_MAX_EXPECTATIONS} expectations in expect`);
  }
  return value.map((entry, index): ParsedExpectation => {
    const fail = (message: string): never => { throw connectorError("invalid_arguments", `expect[${index}]: ${message}`); };
    if (!isRecord(entry) || typeof entry.kind !== "string" || !EXPECTATION_KINDS.has(entry.kind)) {
      return fail(`kind must be one of ${[...EXPECTATION_KINDS].join(", ")}`);
    }
    const text = (field: string): string | undefined => {
      const item = entry[field];
      if (item === undefined || item === null) return undefined;
      return typeof item === "string" ? item : fail(`${field} must be a string`);
    };
    const count = (field: string): number | undefined => {
      const item = entry[field];
      if (item === undefined || item === null) return undefined;
      return typeof item === "number" && Number.isInteger(item) && item >= 0 ? item : fail(`${field} must be a non-negative integer`);
    };
    const kind = entry.kind as ParsedExpectation["kind"];
    if (kind === "text_present" || kind === "text_absent") {
      const wanted = text("text");
      return wanted ? { index, kind, text: wanted } : fail("text is required");
    }
    if (kind === "url_matches" || kind === "title_matches") {
      const pattern = text("pattern");
      if (!pattern) return fail("pattern is required");
      if (pattern.length > MAX_PATTERN_LENGTH) return fail(`pattern is longer than ${MAX_PATTERN_LENGTH} characters`);
      try { matchesPattern("", pattern); } catch { return fail("pattern is not a valid /regex/"); }
      return { index, kind, pattern };
    }
    const selector = text("selector"); const pageRef = text("pageRef"); const name = text("name"); const role = text("role");
    const state = text("state"); const wantedValue = text("value");
    if (state !== undefined && !ELEMENT_STATES.has(state)) return fail(`state must be one of ${[...ELEMENT_STATES].join(", ")}`);
    const base = { index, ...(selector ? { selector } : {}), ...(pageRef ? { pageRef } : {}), ...(name ? { name } : {}), ...(role ? { role } : {}) };
    if (kind === "count") {
      if (!selector && !pageRef && !name && !role) return fail("count needs a selector, a pageRef, a name or a role");
      const equals = count("equals"); const atLeast = count("atLeast"); const atMost = count("atMost");
      if (equals === undefined && atLeast === undefined && atMost === undefined) return fail("count needs equals, atLeast or atMost");
      return { ...base, kind, ...(equals !== undefined ? { equals } : {}), ...(atLeast !== undefined ? { atLeast } : {}), ...(atMost !== undefined ? { atMost } : {}), ...(entry.visible === true ? { visible: true } : {}) };
    }
    if (!selector && !pageRef && !name && !role) return fail("element needs a selector, a pageRef, or a name or role");
    return { ...base, kind, ...(state ? { state: state as PageExpectation["state"] } : {}), ...(wantedValue !== undefined ? { value: wantedValue } : {}) };
  });
}

const MAX_PATTERN_LENGTH = 200;
const MAX_PATTERN_SUBJECT = 2_048;

/* A plain string is a case-insensitive substring; /body/flags is a regular expression. The subject
   is capped so a hostile pattern has little to chew on. */
export function matchesPattern(subject: string, pattern: string): boolean {
  const text = subject.slice(0, MAX_PATTERN_SUBJECT);
  const regex = /^\/(.+)\/([a-z]*)$/s.exec(pattern);
  if (regex) return new RegExp(regex[1]!, regex[2]).test(text);
  return text.toLowerCase().includes(pattern.toLowerCase());
}

function clipObserved(value: string): string {
  return value.length > 120 ? `${value.slice(0, 120)}...` : value;
}

/* What an agent should do next for each failure, so an error ends a guess instead of starting one. */
export const ERROR_HINTS: Record<string, string> = {
  stale_page_ref: "The page changed since that reference was read (navigation or re-render). Call find or read_page again and use the new reference.",
  tab_not_controlled: "Use a tab id from tabs_context for this session, or open one with tabs_create.",
  debugger_conflict: "DevTools or another debugger is attached to this tab. Ask the person to close DevTools there, or use another tab.",
  navigation_timeout: "The page may still be loading. Call wait_for (text, urlContains or networkIdle) or read_page to see where it is before retrying; do not repeat the navigation blindly.",
  click_intercepted: "Another element covers the target, often a dialog, overlay, toast or sticky header. Close or wait out the covering element (wait_for textGone), then click again.",
  element_not_visible: "The element has no visible box. Open its container (tab, accordion, menu) or scroll to it first, then read the page again.",
  element_disabled: "The control is disabled. Fill the required fields or finish the previous step first; read_page shows invalid fields.",
  wait_timeout: "The condition did not hold in time. read_page or get_page_text shows what the page shows instead; increase timeoutMs only if the app is known to be slow.",
  javascript_error: "Fix the script, or use find, form_input, wait_for or get_page_text when they can do the job.",
  invalid_dimensions: "Use a preset (mobile, tablet, desktop) or a width between 320 and 7680 and a height between 240 and 4320.",
  restricted_url: "Only http and https pages can be opened.",
  invalid_arguments: "Check the tool's argument schema.",
  value_not_applied: "The field did not keep the value, which usually means a script controls it. Try computer type with the same pageRef and replace:true; if typing still does not stick, the editor needs keyEvents:true.",
  radio_cannot_uncheck: "A checked radio cannot be unchecked by clicking it. Click the radio that should be selected instead, or use computer click on that radio.",
  action_denied: "The person or the policy denied this action. Explain what you are trying to do and ask the person to allow it; do not retry the same call unchanged.",
  approval_timeout: "Nobody answered the approval in time. Ask the person to approve the pending request in the Connector Panel, then retry.",
  binary_body: "The response is binary, not text. Use download_file to save it, or read a textual resource instead.",
  chrome_permission_missing: "Chrome has not granted the site permission. Open the Connector Panel and grant that origin, then retry.",
  cross_origin_body: "The response body belongs to another origin. Read it in a controlled tab on that origin, or use download_file.",
  download_failed: "The download did not complete. Check the URL and the tab, then retry; inspect the page for a blocked download.",
  drag_interrupted: "The pointer release could not be confirmed. Inspect the tab before retrying; repeating a drag may apply it twice.",
  file_too_large: "The file exceeds the connector's size limit. Use a smaller file or fetch only the needed bytes.",
  invalid_batch: "The batch is malformed. Send a non-empty list of supported tool calls; javascript_tool is not allowed inside a batch.",
  invalid_cursor: "The cursor is not recognized. Re-read the page and use the cursor it returned.",
  pairing_denied: "This host is not paired with the extension. Open the Connector Panel and approve Host Pairing.",
  request_not_found: "The request expired or was already answered. Re-read the page and send a new request.",
  site_denied: "The site is not allowed for this session. Ask the person to grant the origin in the Connector Panel.",
  tab_create_failed: "Chrome did not create a tab. Check that the URL is allowed and retry once; if it persists, inspect Chrome.",
  unknown_tool: "That tool does not exist. Use one from tools/list.",
  upload_failed: "The upload did not complete. Check the file input and try again.",
  critical_action_not_batchable: "This action must be called on its own, not inside a batch. Send it as a single tool call.",
  javascript_dialog_open: "A JavaScript dialog (alert, confirm or prompt) is blocking the page. Ask the person to dismiss it; the connector does not click dialogs.",
  browser_error: "The browser reported an error without a more specific code. Read the message, inspect the tab, and retry only after the state is clear."
};

export function normalizeError(error: unknown): { code: string; message: string; outcomeUnknown: boolean; hint?: string; after?: unknown } {
  if (error instanceof Error) {
    const typed = error as Error & { code?: string; outcomeUnknown?: boolean; after?: unknown };
    const code = typed.code ?? "browser_error";
    return { code, message: error.message, outcomeUnknown: typed.outcomeUnknown ?? false, ...(ERROR_HINTS[code] ? { hint: ERROR_HINTS[code] } : {}), ...(typed.after !== undefined ? { after: typed.after } : {}) };
  }
  return { code: "browser_error", message: String(error), outcomeUnknown: false };
}

function safeOrigin(url: string): string | undefined {
  try { return new URL(url).origin; } catch { return undefined; }
}
