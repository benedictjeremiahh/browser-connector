import { boundedText, clampLimit, exactOrigin, isRestrictedUrl, redactUrl } from "./policy";

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

const MAX_LOG_RECORDS = 2_000;
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const MAX_DOWNLOAD_BYTES = 10 * 1024 * 1024;
const MAX_RESPONSE_BODY_BYTES = 256 * 1024;

/* The mark Codex draws where it is about to act. One string so the injected
   script stays a single Runtime.evaluate call. */
const CURSOR_MARKUP = [
  "<style>",
  ".arrow{position:fixed;left:0;top:0;transform-origin:0 0;filter:drop-shadow(0 1px 2px rgba(0,0,0,.45))}",
  ".ping{position:fixed;left:0;top:0;width:30px;height:30px;margin:-15px 0 0 -15px;border-radius:50%;border:2px solid #ff4d4f;opacity:0}",
  ".ping.on{animation:bc-ping .55s cubic-bezier(.2,.7,.3,1)}",
  "@keyframes bc-ping{from{opacity:.85;transform:scale(.25)}to{opacity:0;transform:scale(1.6)}}",
  "</style>",
  '<div class="ping"></div>',
  '<svg class="arrow" width="22" height="22" viewBox="0 0 22 22" aria-hidden="true"><path d="M1 1 L1 17.4 L5.5 13.4 L8.8 20.2 L11.5 18.9 L8.2 12.1 L14.4 12.1 Z" fill="#111827" stroke="#ffffff" stroke-width="1.3" stroke-linejoin="round"/></svg>'
].join("");

export class BrowserController {
  private attachedTabs = new Set<number>();
  private documentGenerations = new Map<number, number>();
  private consoleRecords = new Map<number, ConsoleRecord[]>();
  private networkRecords = new Map<number, NetworkRecord[]>();
  private groupId?: number;

  constructor() {
    chrome.webNavigation.onCommitted.addListener(({ tabId, frameId }) => {
      if (frameId === 0) this.documentGenerations.set(tabId, (this.documentGenerations.get(tabId) ?? 0) + 1);
    });
    chrome.tabs.onRemoved.addListener((tabId) => {
      this.attachedTabs.delete(tabId);
      this.documentGenerations.delete(tabId);
      this.consoleRecords.delete(tabId);
      this.networkRecords.delete(tabId);
    });
    chrome.debugger.onEvent.addListener((source, method, params) => this.onDebuggerEvent(source.tabId, method, params));
    chrome.debugger.onDetach.addListener((source) => {
      if (source.tabId !== undefined) this.attachedTabs.delete(source.tabId);
    });
  }

  async dispatch(method: string, params: Record<string, unknown>, controlledTabIds: Set<number>): Promise<unknown> {
    switch (method) {
      case "tabs_context": return this.tabsContext(controlledTabIds, params.createIfEmpty === true);
      case "tabs_create": return this.tabsCreate(controlledTabIds, asOptionalString(params.url));
      case "tabs_close": return this.tabsClose(controlledTabIds, asTabId(params.tabId));
      case "navigate": return this.navigate(asTabId(params.tabId), asString(params.action), asOptionalString(params.url));
      case "computer": return this.computer(params);
      case "read_page": return this.readPage(asTabId(params.tabId), params.maxBytes, params.cursor);
      case "get_page_text": return this.getPageText(asTabId(params.tabId), params.maxBytes, params.cursor);
      case "find": return this.find(asTabId(params.tabId), asString(params.query), params.limit, params.cursor);
      case "form_input": return this.formInput(asTabId(params.tabId), asString(params.pageRef), params.value);
      case "javascript_tool": return this.javascriptTool(asTabId(params.tabId), asString(params.source));
      case "read_console_messages": return this.readConsole(asTabId(params.tabId), params);
      case "read_network_requests": return this.readNetwork(asTabId(params.tabId), params);
      case "resize_window": return this.resizeWindow(asNumber(params.windowId), asNumber(params.width), asNumber(params.height));
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
      args: [pageRef]
    });
    if (!isPageRefContext(result?.result)) return { description: "" };
    return result.result;
  }

  async detachAll(): Promise<void> {
    await Promise.all([...this.attachedTabs].map(async (tabId) => {
      try { await chrome.debugger.detach({ tabId }); } catch { /* already detached */ }
    }));
    this.attachedTabs.clear();
  }

  private async tabsContext(controlledTabIds: Set<number>, createIfEmpty: boolean): Promise<unknown> {
    if (controlledTabIds.size === 0 && createIfEmpty) await this.tabsCreate(controlledTabIds, undefined);
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

  private async tabsCreate(controlledTabIds: Set<number>, url?: string): Promise<unknown> {
    if (url && isRestrictedUrl(url)) throw connectorError("restricted_url", `Cannot open privileged or unsupported URL: ${url}`);
    const tab = await chrome.tabs.create({ url: url ?? "about:blank", active: true });
    if (tab.id === undefined) throw connectorError("tab_create_failed", "Chrome did not return a tab ID");
    controlledTabIds.add(tab.id);
    await this.ensureTabGroup(tab.id);
    return { tabId: tab.id, windowId: tab.windowId, url: tab.url ?? url ?? "about:blank" };
  }

  private async ensureTabGroup(tabId: number): Promise<void> {
    try {
      if (this.groupId === undefined) {
        this.groupId = await chrome.tabs.group({ tabIds: [tabId] });
        await chrome.tabGroups.update(this.groupId, { title: "Browser Connector", color: "green", collapsed: false });
      } else {
        await chrome.tabs.group({ groupId: this.groupId, tabIds: [tabId] });
      }
    } catch {
      this.groupId = undefined;
    }
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
      await chrome.tabs.update(tabId, { url, active: true });
    } else if (action === "reload") await chrome.tabs.reload(tabId);
    else if (action === "back") await chrome.tabs.goBack(tabId);
    else if (action === "forward") await chrome.tabs.goForward(tabId);
    else throw connectorError("invalid_arguments", `Unknown navigation action: ${action}`);
    await waitForTabComplete(tabId, 15_000);
    const tab = await chrome.tabs.get(tabId);
    return { tabId, url: tab.url ? redactUrl(tab.url) : undefined, title: tab.title };
  }

  private async readPage(tabId: number, requestedMax: unknown, cursor: unknown): Promise<unknown> {
    const maxBytes = clampLimit(requestedMax, 65_536, 65_536);
    const offset = cursorOffset(cursor);
    const generation = this.documentGenerations.get(tabId) ?? 1;
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      func: injectedReadPage,
      args: [generation, maxBytes, offset]
    });
    return result?.result ?? { nodes: [], truncated: false, originalBytes: 0 };
  }

  private async getPageText(tabId: number, requestedMax: unknown, cursor: unknown): Promise<unknown> {
    const maxBytes = clampLimit(requestedMax, 65_536, 65_536);
    const [result] = await chrome.scripting.executeScript({ target: { tabId }, func: injectedGetPageText });
    return { ...pageText(String(result?.result ?? ""), cursorOffset(cursor), maxBytes), untrusted: true };
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
      args: [pageRef, value]
    });
    if (!result?.result) throw connectorError("stale_page_ref", `Page Reference is stale: ${pageRef}`);
    return { changed: true, pageRef };
  }

  /* Codex shows the cursor where it is about to act; a raw CDP mouse event is
     invisible, so anyone watching the tab sees nothing happen. The mark lives in
     a shadow root so no page style can reach it, carries aria-hidden so it never
     enters the accessibility snapshot the agent reads, and ignores pointer
     events so it cannot swallow the click it is marking. It stays where it last
     acted, which is what makes it visible in a screenshot taken afterwards.
     Failures are swallowed: the mark is decoration and must never fail an
     action. */
  private async showCursor(tabId: number, point: { x: number; y: number }, click = false): Promise<void> {
    const { x, y } = point;
    const expression = `(() => {
      const HOST_ID = "__browser_connector_cursor";
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
      root.querySelector(".arrow").style.transform = "translate(${x}px, ${y}px)";
      const ping = root.querySelector(".ping");
      ping.style.left = "${x}px";
      ping.style.top = "${y}px";
      ${click ? 'ping.classList.remove("on"); void ping.offsetWidth; ping.classList.add("on");' : ""}
    })()`;
    try {
      await this.cdp(tabId, "Runtime.evaluate", { expression });
    } catch { /* the mark is decoration */ }
  }

  private async computer(params: Record<string, unknown>): Promise<unknown> {
    const tabId = asTabId(params.tabId);
    const action = asString(params.action);
    if (action === "wait") {
      const waitMs = clampLimit(params.waitMs, 500, 10_000);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
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
    if (action === "scroll") {
      const x = asOptionalNumber(params.deltaX) ?? 0;
      const y = asOptionalNumber(params.deltaY) ?? 600;
      if (typeof params.x === "number" && typeof params.y === "number") {
        await this.showCursor(tabId, { x: asNumber(params.x), y: asNumber(params.y) });
      }
      await this.cdp(tabId, "Runtime.evaluate", { expression: `window.scrollBy(${JSON.stringify(x)}, ${JSON.stringify(y)})` });
      return { scrolled: { x, y } };
    }
    if (action === "type") {
      if (typeof params.pageRef === "string") await this.focusRef(tabId, params.pageRef);
      await this.cdp(tabId, "Input.insertText", { text: asString(params.text) });
      return { typed: true };
    }
    if (action === "key") {
      const key = asString(params.key);
      await this.cdp(tabId, "Input.dispatchKeyEvent", { type: "keyDown", key });
      await this.cdp(tabId, "Input.dispatchKeyEvent", { type: "keyUp", key });
      return { key };
    }
    const point = typeof params.pageRef === "string"
      ? await this.pointForRef(tabId, params.pageRef)
      : { x: asNumber(params.x), y: asNumber(params.y) };
    if (action === "move") {
      await this.showCursor(tabId, point);
      await this.cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", ...point });
      return { moved: point };
    }
    if (action === "click" || action === "double_click") {
      const clickCount = action === "double_click" ? 2 : 1;
      await this.showCursor(tabId, point, true);
      await this.cdp(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount, ...point });
      await this.cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount, ...point });
      return { clicked: point, clickCount };
    }
    throw connectorError("invalid_arguments", `Unknown computer action: ${action}`);
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

  private async resizeWindow(windowId: number, width: number, height: number): Promise<unknown> {
    if (width < 320 || height < 240 || width > 7680 || height > 4320) throw connectorError("invalid_dimensions", "Window dimensions are outside supported bounds");
    const window = await chrome.windows.update(windowId, { width, height });
    return { windowId: window.id, width: window.width, height: window.height };
  }

  private async uploadFile(params: Record<string, unknown>): Promise<unknown> {
    const tabId = asTabId(params.tabId);
    const pageRef = asString(params.pageRef);
    const dataBase64 = asString(params.dataBase64);
    if (Math.floor(dataBase64.length * 0.75) > MAX_UPLOAD_BYTES) throw connectorError("file_too_large", "Upload exceeds 10 MiB");
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      func: injectedUpload,
      args: [pageRef, asString(params.name), asString(params.mimeType), dataBase64]
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
      this.attachedTabs.add(tabId);
    } catch (error) {
      throw connectorError("debugger_conflict", `Cannot attach Chrome debugger. Close DevTools or another debugger first. ${String(error)}`);
    }
  }

  private async cdp(tabId: number, method: string, params?: Record<string, unknown>): Promise<object> {
    return (await chrome.debugger.sendCommand({ tabId }, method, params)) ?? {};
  }

  private async pointForRef(tabId: number, pageRef: string): Promise<{ x: number; y: number }> {
    const [result] = await chrome.scripting.executeScript({ target: { tabId }, func: injectedRefPoint, args: [pageRef] });
    if (!result?.result) throw connectorError("stale_page_ref", `Page Reference is stale: ${pageRef}`);
    return result.result as { x: number; y: number };
  }

  private async focusRef(tabId: number, pageRef: string): Promise<void> {
    const [result] = await chrome.scripting.executeScript({ target: { tabId }, func: injectedFocusRef, args: [pageRef] });
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

function injectedReadPage(generation: number, maxBytes: number, offset: number): unknown {
  const selector = "a,button,input,select,textarea,[role],[contenteditable=true],summary,[tabindex],h1,h2,h3,h4,h5,h6,p,li";
  const elements = [...document.querySelectorAll<HTMLElement>(selector)];
  const nodes: Array<Record<string, unknown>> = [];
  let bytes = 0;
  let truncated = false;
  let nextIndex = offset;
  for (let index = offset; index < elements.length && nodes.length < 500; index += 1) {
    nextIndex = index + 1;
    const element = elements[index]!;
    const rect = element.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) continue;
    const ref = `p${generation}-${index}`;
    element.dataset.browserConnectorRef = ref;
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
    if (bytes + size > maxBytes) { truncated = true; break; }
    nodes.push(node);
    bytes += size;
  }
  if (nextIndex < elements.length) truncated = true;
  return {
    title: document.title,
    url: location.origin + location.pathname,
    documentGeneration: generation,
    nodes,
    truncated,
    nextCursor: truncated ? String(nextIndex) : null,
    returnedBytes: bytes,
    untrusted: true
  };
}

function injectedGetPageText(): string {
  const root = document.querySelector("main,article,[role=main]") ?? document.body;
  return (root as HTMLElement).innerText ?? root.textContent ?? "";
}

function injectedFind(generation: number, query: string, limit: number, offset: number): unknown {
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
    const ref = `p${generation}-f${index}`;
    element.dataset.browserConnectorRef = ref;
    matches.push({ ref, role: element.getAttribute("role") || element.tagName.toLowerCase(), name: haystack.slice(0, 500) });
  }
  return { matches, nextCursor: hasMore ? String(offset + matches.length) : null, truncated: hasMore };
}

function injectedDescribeRef(pageRef: string): { description: string; destinationOrigin?: string } {
  const element = document.querySelector<HTMLElement>(`[data-browser-connector-ref="${CSS.escape(pageRef)}"]`);
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

function injectedRefPoint(pageRef: string): { x: number; y: number } | null {
  const element = document.querySelector<HTMLElement>(`[data-browser-connector-ref="${CSS.escape(pageRef)}"]`);
  if (!element?.isConnected) return null;
  element.scrollIntoView({ block: "center", inline: "center" });
  const rect = element.getBoundingClientRect();
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

function injectedFocusRef(pageRef: string): boolean {
  const element = document.querySelector<HTMLElement>(`[data-browser-connector-ref="${CSS.escape(pageRef)}"]`);
  if (!element?.isConnected) return false;
  element.focus();
  return document.activeElement === element;
}

function injectedFormInput(pageRef: string, value: unknown): boolean {
  const element = document.querySelector<HTMLElement>(`[data-browser-connector-ref="${CSS.escape(pageRef)}"]`);
  if (!element?.isConnected) return false;
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

function injectedUpload(pageRef: string, name: string, mimeType: string, dataBase64: string): boolean {
  const input = document.querySelector<HTMLInputElement>(`[data-browser-connector-ref="${CSS.escape(pageRef)}"]`);
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

async function waitForTabComplete(tabId: number, timeoutMs: number): Promise<void> {
  const tab = await chrome.tabs.get(tabId);
  if (tab.status === "complete") return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(done, timeoutMs);
    function listener(changedTabId: number, info: { status?: string }): void {
      if (changedTabId === tabId && info.status === "complete") done();
    }
    function done(): void {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }
    chrome.tabs.onUpdated.addListener(listener);
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
