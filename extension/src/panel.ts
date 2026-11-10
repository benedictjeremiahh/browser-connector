import { exactOrigin, isLocalDevelopmentOrigin } from "./policy";
import type { ApprovalRequest, AuditEvent, GrantDecision, PanelLease, PanelState, PanelTab } from "./types";

const status = byId("status");
const currentTitle = byId("current-title");
const currentAddress = byId("current-address");
const currentOwner = byId("current-owner");
const handoff = byId("handoff");
const select = document.querySelector<HTMLSelectElement>("#session-select")!;
const giveControl = document.querySelector<HTMLButtonElement>("#control-current")!;
const controlHelp = byId("control-help");
const announcement = byId("action-announcement");
const currentFeedback = byId("current-feedback");
const siteFeedback = byId("site-feedback");
const addCurrent = document.querySelector<HTMLButtonElement>("#add-current-site")!;
const addManual = document.querySelector<HTMLButtonElement>("#add-manual-site")!;
const siteInput = document.querySelector<HTMLInputElement>("#site-input")!;
const siteHelp = byId("site-help");
const siteCurrentOrigin = byId("site-current-origin");
const controlledCount = byId("controlled-count");
const feedback = element("p", "feedback");
feedback.id = "control-feedback";
let feedbackSession: string | undefined;
let feedbackTab: number | undefined;
let feedbackIndex = 0;
let feedbackAtSite = false;
const sessionsRoot = byId("sessions");
const sessionsHeading = byId("sessions-heading");
const sessionsEmpty = byId("sessions-empty");
const sessionCount = byId("session-count");
const releaseAll = byId("release-all");
const revokeLease = byId("revoke-lease");
const approvalsSection = byId("approvals-section");
const approvalsRoot = byId("approvals");
const sitesRoot = byId("allowed-sites");
let renderedApprovals = "";
let renderedSites = "";
const auditRoot = byId("audit-log");
const activityDetails = document.querySelector<HTMLDetailsElement>("#activity-details")!;
let activityTotal = 0;
let activityEvents: AuditEvent[] = [];
const approvalRows = new Map<string, HTMLElement>();
const auditRows = new Map<string, HTMLElement>();
const activityCount = byId("activity-count");
const activityEmpty = byId("activity-empty");
const clearLog = byId("clear-log");

let state: PanelState | undefined;
let activeTab: chrome.tabs.Tab | undefined;
let chosenSessionId = "";
let pendingAction = false;
let refreshFailed = false;
type RefreshScope = "state" | "current" | "activity";
const requested = new Set<RefreshScope>();
let refreshing: Promise<void> | undefined;
let refreshTimer: ReturnType<typeof setTimeout> | undefined;
let renderedOptions = "";
let renderedSessions = "";

select.addEventListener("change", () => {
  chosenSessionId = select.value;
  render();
});

giveControl.addEventListener("click", () => {
  const tab = activeTab;
  const session = state?.leases.find((lease) => lease.sessionId === select.value);
  if (giveControl.disabled || tab?.id === undefined || !tab.url || !session) return;
  const title = tab.title || "This tab";
  const label = session.displayName;
  void runAction({
    type: "control_tab", tabId: tab.id, expectedUrl: tab.url, sessionId: session.sessionId
  }, "Giving control…", `${title} is now controlled by ${label}.`);
});

revokeLease.addEventListener("click", () => {
  void runAction({ type: "revoke_lease" }, "Releasing all tabs…", "All tabs released. Your tabs are still open.");
});

clearLog.addEventListener("click", () => {
  void runAction({ type: "clear_log" }, "Clearing activity…", "Activity cleared.");
});

addCurrent.addEventListener("click", () => {
  const origin = activeTab?.url ? exactOrigin(activeTab.url) : undefined;
  if (origin && !addCurrent.disabled) void addSite(origin);
});

siteInput.addEventListener("input", renderSiteControls);
byId("site-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const origin = manualOrigin(siteInput.value);
  if (origin && !addManual.disabled) void addSite(origin, true);
});
activityDetails.addEventListener("toggle", () => {
  if (activityDetails.open) scheduleRefresh("activity");
});

chrome.runtime.onMessage.addListener((message: unknown) => {
  if (!isRecord(message) || message.type !== "state_changed") return;
  if (message.scope === "activity") scheduleRefresh("activity");
  else scheduleRefresh("state", "current", "activity");
});
chrome.tabs.onActivated.addListener(({ windowId }) => {
  if (!activeTab || windowId === activeTab.windowId) scheduleRefresh("current");
});
chrome.tabs.onUpdated.addListener((id, changes) => {
  if (id === activeTab?.id && (changes.url !== undefined || changes.title !== undefined || changes.status !== undefined)) {
    scheduleRefresh("current");
  }
  if (isControlled(id) && (changes.url !== undefined || changes.title !== undefined)) scheduleRefresh("state");
});
chrome.tabs.onRemoved.addListener((id, { windowId }) => {
  if (id === activeTab?.id) scheduleRefresh("current");
  if (hasControlledWindow(windowId)) scheduleRefresh("state");
});
chrome.tabs.onCreated.addListener((tab) => {
  if (state?.leases.some(lease => lease.tabs.some(entry => entry.windowId === tab.windowId && entry.index >= tab.index))) {
    scheduleRefresh("state");
  }
});
chrome.tabs.onMoved.addListener((_id, { windowId }) => {
  if (hasControlledWindow(windowId)) scheduleRefresh("state");
});
chrome.tabs.onAttached.addListener((id, { newWindowId }) => {
  if (isControlled(id) || hasControlledWindow(newWindowId)) scheduleRefresh("state");
  if (id === activeTab?.id || newWindowId === activeTab?.windowId) scheduleRefresh("current");
});
chrome.tabs.onDetached.addListener((id, { oldWindowId }) => {
  if (hasControlledWindow(oldWindowId)) scheduleRefresh("state");
  if (id === activeTab?.id) scheduleRefresh("current");
});
void refresh("state", "current", "activity");

function isControlled(id: number): boolean {
  return state?.leases.some(lease => lease.tabs.some(tab => tab.tabId === id)) ?? false;
}

function hasControlledWindow(id: number): boolean {
  return state?.leases.some(lease => lease.tabs.some(tab => tab.windowId === id)) ?? false;
}

function scheduleRefresh(...scopes: RefreshScope[]): void {
  for (const scope of scopes) requested.add(scope);
  if (refreshing || refreshTimer) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = undefined;
    void refresh();
  }, 40);
}

function refresh(...scopes: RefreshScope[]): Promise<void> {
  for (const scope of scopes) requested.add(scope);
  refreshing ??= drainRefresh().finally(() => {
    refreshing = undefined;
    if (requested.size) scheduleRefresh();
  });
  return refreshing;
}

async function drainRefresh(): Promise<void> {
  while (requested.size) {
    const scopes = new Set(requested);
    requested.clear();
    const jobs = [];
    if (scopes.has("state")) {
      jobs.push(chrome.runtime.sendMessage({ type: "get_state" }).then((nextState: PanelState) => {
        if (!Array.isArray(nextState?.leases)) throw new Error("Panel state unavailable");
        state = nextState;
        refreshFailed = false;
      }).catch(() => { refreshFailed = true; }));
    }
    if (scopes.has("current")) {
      jobs.push(chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
        activeTab = tab;
      }).catch(() => { activeTab = undefined; }));
    }
    if (scopes.has("activity")) {
      const includeEvents = activityDetails.open;
      jobs.push(chrome.runtime.sendMessage({ type: "get_activity", includeEvents })
        .then((reply: { count: number; events?: AuditEvent[] } | undefined) => {
          if (typeof reply?.count !== "number") return;
          activityTotal = reply.count;
          if (reply.events) activityEvents = reply.events;
        }).catch(() => undefined));
    }
    await Promise.all(jobs);
    if (scopes.has("state") || scopes.has("current")) render();
    if (scopes.has("activity")) renderActivity(activityDetails.open);
  }
}

function render(): void {
  const connected = !refreshFailed && state?.nativeConnected === true;
  const connectionLabel = !state && !refreshFailed ? "Connecting" : connected ? "Connected" : "Disconnected";
  if (status.textContent !== connectionLabel) status.textContent = connectionLabel;
  status.classList.toggle("disconnected", !connected);
  const leases = state?.leases ?? [];
  const owner = leases.find((lease) => lease.tabs.some(({ tabId }) => tabId === activeTab?.id));
  const url = activeTab?.url;
  const origin = url ? exactOrigin(url) : undefined;
  const changing = activeTab?.pendingUrl !== undefined && activeTab.pendingUrl !== url;
  currentTitle.textContent = activeTab?.title || (activeTab ? "Untitled tab" : "No active tab");
  currentAddress.textContent = origin && url ? addressOf(origin, new URL(url).pathname) : "";
  currentAddress.hidden = !origin;
  currentOwner.textContent = owner ? `Controlled by ${owner.displayName}` : "";
  currentOwner.hidden = !owner;

  handoff.hidden = Boolean(owner) || !connected || !leases.length || !origin;
  const options = leases.map((lease) => [lease.sessionId, lease.displayName]);
  const optionsKey = JSON.stringify(options);
  if (renderedOptions !== optionsKey) {
    renderedOptions = optionsKey;
    select.replaceChildren(
      new Option("Choose a session", ""),
      ...options.map(([id, label]) => new Option(label, id))
    );
  }
  if (!leases.some((lease) => lease.sessionId === chosenSessionId)) chosenSessionId = "";
  select.value = chosenSessionId || (leases.length === 1 ? leases[0]?.sessionId ?? "" : "");
  giveControl.disabled = handoff.hidden || pendingAction || changing || !select.value;
  select.disabled = pendingAction;
  controlHelp.textContent = helpText({ connected, hasState: Boolean(state), hasSessions: leases.length > 0, owner, origin, changing });

  sessionCount.textContent = leases.length ? `${leases.length} ${leases.length === 1 ? "session" : "sessions"}` : "";
  sessionsEmpty.hidden = leases.length > 0;
  sessionsEmpty.textContent = !state && !refreshFailed ? "Checking agent sessions…" : connected
    ? "No agent sessions yet."
    : "Reconnect the agent to see its sessions.";
  const sessionsKey = JSON.stringify(leases);
  if (sessionsKey !== renderedSessions) {
    renderedSessions = sessionsKey;
    renderSessions(leases);
  }
  const total = leases.reduce((count, lease) => count + lease.tabs.length, 0);
  releaseAll.hidden = total === 0;
  controlledCount.textContent = `${total} ${total === 1 ? "tab" : "tabs"} controlled`;
  revokeLease.setAttribute("aria-disabled", String(pendingAction));
  clearLog.setAttribute("aria-disabled", String(pendingAction));
  renderSiteControls();
  const approvals = state?.approvals ?? [];
  const approvalKey = JSON.stringify(approvals);
  if (approvalKey !== renderedApprovals) {
    renderedApprovals = approvalKey;
    renderApprovals(approvals);
  }
  const sites = state?.allowedSites ?? [];
  const siteKey = JSON.stringify(sites);
  if (siteKey !== renderedSites) {
    renderedSites = siteKey;
    renderSites(sites);
  }
  placeFeedback();
}

function helpText(input: {
  connected: boolean;
  hasState: boolean;
  hasSessions: boolean;
  owner?: PanelLease;
  origin?: string;
  changing: boolean;
}): string {
  if (!input.hasState && !refreshFailed) return "Checking the connector…";
  if (!input.connected) return input.hasSessions
    ? "The agent is disconnected. You can still take back a tab."
    : "Reconnect your agent before giving it a tab.";
  if (input.changing) return "Wait for the tab to finish changing before giving control.";
  if (input.owner) return "";
  if (!input.origin) return "Switch to a website to give the agent control.";
  if (!input.hasSessions) return "Start a browser task in your agent before giving it this tab.";
  return "";
}

function renderSessions(leases: PanelLease[]): void {
  const previous = [...sessionsRoot.querySelectorAll<HTMLDetailsElement>(".session")];
  const expanded = new Map(previous.map(section => [section.dataset.sessionId, section.open]));
  const focused = document.activeElement as HTMLElement | null;
  const oldSession = focused?.closest<HTMLElement>(".session");
  const oldRows = oldSession ? [...oldSession.querySelectorAll<HTMLElement>("[data-tab-id]")] : [];
  const oldIndex = oldRows.findIndex(row => row.contains(focused ?? null));
  const actionKey = focused?.dataset.actionKey;
  const tabs = leases.flatMap(lease => lease.tabs);
  const counts = new Map<string, number>();
  for (const tab of tabs) {
    const key = tabIdentity(tab);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const windows = [...new Set(tabs.map(tab => tab.windowId))].sort((a, b) => a - b);
  const owner = leases.find(lease => lease.tabs.some(tab => tab.tabId === activeTab?.id));
  sessionsRoot.replaceChildren(...leases.map((lease, index) => {
    const card = element("details", "session");
    card.dataset.sessionId = lease.sessionId;
    card.open = expanded.get(lease.sessionId) ?? (leases.length <= 2 || (owner ? owner === lease : index === 0));
    const summary = element("summary", "");
    const heading = element("h3", "session-title", lease.displayName);
    heading.append(element("span", "count", ` · ${lease.tabs.length} ${lease.tabs.length === 1 ? "tab" : "tabs"}`));
    summary.append(heading);
    card.append(summary);
    if (!lease.tabs.length) {
      card.append(element("p", "session-empty", "No controlled tabs."));
    } else {
      const list = element("ul", "tab-list");
      lease.tabs.forEach((tab, rowIndex) => {
        const position = (counts.get(tabIdentity(tab)) ?? 0) > 1
          ? tabPosition(tab, windows) : undefined;
        list.append(renderTab(lease, tab, rowIndex, position));
      });
      card.append(list);
    }
    return card;
  }));
  if (!oldSession) return;
  const session = findSession(oldSession.dataset.sessionId);
  const exact = [...(session?.querySelectorAll("button") ?? [])].find(button => button.dataset.actionKey === actionKey);
  const rows = session?.querySelectorAll("[data-tab-id]");
  const neighbor = rows?.[Math.min(Math.max(oldIndex, 0), rows.length - 1)];
  const next = exact ?? (oldIndex >= 0 ? neighbor?.querySelector("button") : undefined) ??
    session?.querySelector("summary") ?? sessionsHeading;
  next.focus({ preventScroll: true });
  if (!exact) next.scrollIntoView({ block: "nearest" });
}

function findSession(id: string | undefined): HTMLElement | undefined {
  return [...sessionsRoot.querySelectorAll<HTMLElement>(".session")].find(section => section.dataset.sessionId === id);
}

function tabIdentity(tab: PanelTab): string {
  return JSON.stringify([tab.title, tab.origin, tab.path]);
}

function tabPosition(tab: PanelTab, windows: number[]): string {
  return `Window ${windows.indexOf(tab.windowId) + 1} · Tab ${tab.index + 1}`;
}

function renderTab(lease: PanelLease, tab: PanelTab, rowIndex: number, position?: string): HTMLElement {
  const row = element("li", "tab");
  row.dataset.tabId = String(tab.tabId);
  const address = tab.origin ? addressOf(tab.origin, tab.path) : "Browser page";
  const identity = element("div", "tab-identity");
  identity.append(element("span", "tab-title", tab.title), element("span", "tab-address", address));
  if (position) identity.append(element("span", "tab-position", position));
  const actions = element("div", "tab-actions");
  for (const [type, label, pending, success] of [
    ["show_tab", "Show", "Showing tab…", `Showing ${tab.title}.`],
    ["release_tab", "Take back", "Taking back tab…", `${tab.title} is back under your control. The tab is still open.`]
  ] as const) {
    const button = element("button", "secondary", label);
    button.type = "button";
    button.setAttribute("aria-label", `${label} ${tab.title}${position ? `, ${position}` : ""}`);
    button.setAttribute("aria-description", address);
    if (pendingAction) button.setAttribute("aria-disabled", "true");
    button.dataset.actionKey = `${lease.sessionId}:${tab.tabId}:${type}`;
    button.addEventListener("click", () => void runAction(
      { type, sessionId: lease.sessionId, tabId: tab.tabId }, pending, success, rowIndex
    ));
    actions.append(button);
  }
  row.append(identity, actions);
  return row;
}

function renderApprovals(requests: ApprovalRequest[]): void {
  approvalsSection.hidden = requests.length === 0;
  const before = document.activeElement?.closest<HTMLElement>("[data-approval-id]");
  const live = new Set(requests.map(request => request.id));
  for (const [id, item] of approvalRows) {
    if (!live.has(id)) {
      item.remove();
      approvalRows.delete(id);
    }
  }
  const controlledTabs = state?.leases.flatMap(lease => lease.tabs) ?? [];
  for (const [index, request] of requests.entries()) {
    if (approvalRows.has(request.id)) continue;
    const item = document.createElement("li");
    item.dataset.approvalId = request.id;
    const title = document.createElement("h3");
    title.textContent = request.method === "javascript_tool" && request.kind === "action" ? "Run JavaScript" : request.title;
    item.append(title);
    item.append(element("p", "approval-session", request.sessionName ?? request.hostId));
    const targets = request.targets ?? [];
    const candidates = [...controlledTabs, ...targets];
    const windows = [...new Set(candidates.map(tab => tab.windowId))].sort((a, b) => a - b);
    const targetLabels = targets.map(tab => {
      const address = tab.origin ? addressOf(tab.origin, tab.path) : "Browser page";
      const key = tabIdentity(tab);
      const duplicate = candidates.some(other => other.tabId !== tab.tabId && tabIdentity(other) === key);
      return `${tab.title} · ${address}${duplicate ? ` · ${tabPosition(tab, windows)}` : ""}`;
    });
    for (const label of targetLabels) item.append(element("p", "approval-target", label));
    const detail = document.createElement("p");
    detail.className = "detail";
    detail.textContent = `${request.origin && !request.targets?.length ? `${request.origin} · ` : ""}${request.detail}`;
    item.append(detail);
    if (request.preview) {
      const preview = document.createElement("pre");
      preview.textContent = request.preview;
      item.append(preview);
    }
    const actions = document.createElement("div");
    actions.className = "actions";
    const choices: Array<[GrantDecision, string, boolean]> = [
      ["once", "Allow once", true],
      ["session", "This session", request.allowSessionGrant],
      ["always", "Always", request.allowPersistentGrant],
      ["deny", "Deny", true]
    ];
    for (const [decision, label, offered] of choices) {
      if (!offered) continue;
      const button = document.createElement("button");
      button.textContent = label;
      if (decision === "deny") button.className = "secondary";
      button.dataset.decision = decision;
      button.setAttribute("aria-label", `${label} · ${request.sessionName ?? request.hostId}`);
      if (targetLabels.length === 1) button.setAttribute("aria-description", targetLabels[0]!);
      button.addEventListener("click", () => void decideApproval(item, request.id, decision));
      actions.append(button);
    }
    item.append(actions);
    approvalRows.set(request.id, item);
    approvalsRoot.insertBefore(item, approvalsRoot.children[index] ?? null);
  }
  if (before && !before.isConnected) {
    const next = approvalsRoot.querySelector<HTMLButtonElement>('[data-decision="deny"]') ??
      document.querySelector<HTMLElement>("#current-heading");
    if (next) {
      if (next.tagName !== "BUTTON") next.tabIndex = -1;
      next.focus();
    }
  }
}

async function decideApproval(item: HTMLElement, id: string, decision: GrantDecision): Promise<void> {
  if (item.dataset.saving) return;
  item.dataset.saving = "true";
  const buttons = [...item.querySelectorAll("button")];
  for (const button of buttons) button.setAttribute("aria-disabled", "true");
  const error = element("p", "feedback");
  try {
    const result = await chrome.runtime.sendMessage({ type: "approval_decision", approvalId: id, decision }) as
      { ok?: boolean; error?: string } | undefined;
    if (!result?.ok) throw new Error(result?.error || "The decision could not be saved.");
    announcement.textContent = decision === "deny" ? "Request denied." : "Request allowed.";
    await refresh("state");
  } catch (failure) {
    error.dataset.outcome = "error";
    error.textContent = failure instanceof Error ? failure.message : "The decision could not be saved.";
    item.querySelector(".feedback")?.remove();
    item.append(error);
    announcement.textContent = error.textContent;
    await refresh("state");
  } finally {
    delete item.dataset.saving;
    for (const button of buttons) button.removeAttribute("aria-disabled");
  }
}

function renderSites(origins: string[]): void {
  sitesRoot.replaceChildren();
  if (!origins.length) {
    const empty = document.createElement("li");
    empty.className = "empty";
    empty.textContent = "No saved sites.";
    sitesRoot.append(empty);
  }
  for (const origin of origins) {
    const item = document.createElement("li");
    const name = document.createElement("span");
    name.textContent = origin;
    const remove = document.createElement("button");
    remove.className = "link";
    remove.textContent = "Remove";
    remove.setAttribute("aria-label", `Remove ${origin}`);
    remove.addEventListener("click", () => void runAction({ type: "revoke_site", origin }, "Removing site…", `Removed ${origin}.`));
    item.append(name, remove);
    sitesRoot.append(item);
  }
}

function renderActivity(includeEvents: boolean): void {
  activityCount.textContent = activityTotal ? String(activityTotal) : "";
  activityEmpty.hidden = activityTotal > 0;
  clearLog.hidden = activityTotal === 0;
  if (!includeEvents) return;
  const live = new Set(activityEvents.map(event => event.id));
  for (const [id, row] of auditRows) {
    if (!live.has(id)) {
      row.remove();
      auditRows.delete(id);
    }
  }
  activityEvents.forEach((event, index) => {
    if (auditRows.has(event.id)) return;
    const description = event.method === "control_lease" && event.message
      ? event.message
      : `${event.method} · ${event.outcome}${event.origin ? ` · ${event.origin}` : ""}`;
    const item = element("li", "", `${event.hostId} · ${description}`);
    const time = element("time", "", new Date(event.timestamp).toLocaleString());
    time.dateTime = new Date(event.timestamp).toISOString();
    item.append(time);
    auditRows.set(event.id, item);
    auditRoot.insertBefore(item, auditRoot.children[index] ?? null);
  });
}

function manualOrigin(value: string): string | undefined {
  const input = value.trim();
  if (!input || /[\s*\\]/.test(input)) return undefined;
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(input) ? input : `https://${input}`;
  try {
    const url = new URL(candidate);
    if (url.username || url.password || url.hostname.includes("*")) return undefined;
    return exactOrigin(url.href);
  } catch { return undefined; }
}

function renderSiteControls(): void {
  const origin = activeTab?.url ? exactOrigin(activeTab.url) : undefined;
  const saved = state?.allowedSites ?? [];
  const currentStatus = !origin ? "No website open" : isLocalDevelopmentOrigin(origin) ? `${origin} · Already allowed`
    : saved.includes(origin) ? `${origin} · Added` : origin;
  siteCurrentOrigin.textContent = currentStatus;
  addCurrent.disabled = pendingAction || !origin || isLocalDevelopmentOrigin(origin) || saved.includes(origin) ||
    Boolean(activeTab?.pendingUrl && activeTab.pendingUrl !== activeTab.url);
  const manual = manualOrigin(siteInput.value);
  addManual.disabled = pendingAction || !manual || isLocalDevelopmentOrigin(manual) || saved.includes(manual);
  siteHelp.textContent = !siteInput.value.trim() ? "Use a host or an HTTP(S) URL."
    : !manual ? "Enter a valid HTTP(S) site address."
      : isLocalDevelopmentOrigin(manual) || saved.includes(manual) ? `${manual} is already allowed.`
        : `Site to add: ${manual}`;
}

async function addSite(origin: string, manual = false): Promise<void> {
  const input = siteInput.value;
  const added = await runAction({ type: "add_site", origin }, "Adding site…", `Allowed ${origin}.`);
  if (added && manual && siteInput.value === input) {
    siteInput.value = "";
    renderSiteControls();
    siteInput.focus();
  }
}

function placeFeedback(): void {
  const session = findSession(feedbackSession);
  const rows = session?.querySelectorAll<HTMLElement>("[data-tab-id]");
  const anchor = rows ? ([...rows].find(row => Number(row.dataset.tabId) === feedbackTab) ??
    rows[Math.min(feedbackIndex, rows.length - 1)]) : undefined;
  const destination = feedbackAtSite ? siteFeedback : anchor ?? session ?? currentFeedback;
  if (feedback.parentElement !== destination) {
    destination.append(feedback);
    if (session?.contains(document.activeElement) && feedback.getBoundingClientRect().bottom > innerHeight) {
      feedback.scrollIntoView({ block: "nearest" });
    }
  }
}

function setFeedback(outcome: string, message: string): void {
  feedback.dataset.outcome = outcome;
  feedback.textContent = message;
  announcement.textContent = message;
  placeFeedback();
}

async function runAction(message: Record<string, unknown>, pending: string, success: string, rowIndex = 0): Promise<boolean> {
  if (pendingAction) return false;
  const trigger = document.activeElement;
  feedbackSession = typeof message.sessionId === "string" && rowIndex >= 0 &&
    (message.type === "release_tab" || message.type === "show_tab") ? message.sessionId : undefined;
  feedbackTab = typeof message.tabId === "number" ? message.tabId : undefined;
  feedbackIndex = rowIndex;
  feedbackAtSite = message.type === "add_site" || message.type === "revoke_site";
  pendingAction = true;
  for (const button of sessionsRoot.querySelectorAll("button")) button.setAttribute("aria-disabled", "true");
  setFeedback("pending", pending);
  render();
  let succeeded = false;
  try {
    const result = await chrome.runtime.sendMessage(message) as { ok?: boolean; error?: string } | undefined;
    if (!result?.ok) throw new Error(result?.error || "The action could not be completed. Try again.");
    setFeedback("success", success);
    succeeded = true;
  } catch (error) {
    setFeedback("error", error instanceof Error ? error.message : "The action could not be completed.");
  } finally {
    pendingAction = false;
    for (const button of sessionsRoot.querySelectorAll("button")) button.removeAttribute("aria-disabled");
    if (message.type === "clear_log") {
      await refresh("activity");
      render();
    } else await refresh("state", "current");
    if (document.activeElement === document.body) {
      if (trigger === giveControl && handoff.hidden && !currentOwner.hidden) currentOwner.focus();
      if (trigger === revokeLease && releaseAll.hidden) sessionsHeading.focus();
      if (trigger === addCurrent || message.type === "revoke_site") siteInput.focus();
    }
  }
  return succeeded;
}

function addressOf(origin: string, path?: string): string {
  return new URL(origin).host + (path && path !== "/" ? path : "");
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function byId(id: string): HTMLElement {
  const value = document.getElementById(id);
  if (!value) throw new Error(`Missing #${id}`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
