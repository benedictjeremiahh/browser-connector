import { BrowserController, connectorError, normalizeError, type GroupDescriptor } from "./browser";
import { RELEASED_TAB_TTL_MS, adoptableOpenTab, adoptableTabs, orphanBlankTabsToClose, releasedTabsToClose, reusableReleasedTab, shouldRecordAgentTab, type AgentTabRecords } from "./adoption";
import { DEFAULT_MARK, explicitMark, groupColor, isConnectorGroupTitle, normalizeMark, sessionGroupLabel, sessionMark } from "./naming";
import { SessionEndings, isSessionEnded } from "./session-endings";
import { classifyRequest, exactOrigin, hostPermissionPattern, isLocalDevelopmentOrigin, methodsNeedingApproval, redactUrl, sameNavigationTarget, sameTargetDifferentHash } from "./policy";
import {
  DEFAULT_STATE,
  type ApprovalRequest,
  type AuditEvent,
  type GrantDecision,
  type NativeRequest,
  type NativeResponse,
  type PanelState,
  type PersistedState,
  type Risk
} from "./types";

const NATIVE_HOST = "io.browser_connector.native";
/* Below the relay's 60 second request timeout, so an unanswered approval fails with a definite
   approval_timeout rather than an outcome the agent cannot know. */
const APPROVAL_TIMEOUT_MS = 50_000;
const AUDIT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const browser = new BrowserController();
const approvals = new Map<string, { request: ApprovalRequest; resolve: (decision: GrantDecision) => void }>();
let nativePort: chrome.runtime.Port | undefined;
let nativeConnected = false;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let leaseReleaseTimer: ReturnType<typeof setTimeout> | undefined;

/* Adoption and tab creation both read which tabs no one else holds and then write this session's
   controlled set. Two requests arriving together must not take the same tab, so that decision
   runs one at a time; the approval wait before it is not serialized. */
let tabDecision: Promise<unknown> = Promise.resolve();
function serializeTabDecision<T>(work: () => Promise<T>): Promise<T> {
  const next = tabDecision.then(work, work);
  tabDecision = next.catch(() => undefined);
  return next;
}

chrome.runtime.onInstalled.addListener(() => {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  void pruneAudit();
  void dropAutoApprovedSiteGrants();
  void serializeTabDecision(sweepLegacyBlanks);
});

/* The auto-approve build stored an "always" grant for every origin it touched, so those grants
   record where agents went, not what a person allowed. They are cleared once, when this build is
   first installed. */
const SITE_GRANT_FLOOR_KEY = "siteGrantFloor";
async function dropAutoApprovedSiteGrants(): Promise<void> {
  const stored = await chrome.storage.local.get(SITE_GRANT_FLOOR_KEY);
  if (stored[SITE_GRANT_FLOOR_KEY] === 1) return;
  const state = await persistedState();
  state.alwaysSiteGrants = [];
  await savePersistedState(state);
  for (const session of (await allSessions()).values()) {
    session.sessionSiteGrants = [];
    await saveSessionState(session);
  }
  await chrome.storage.local.set({ [SITE_GRANT_FLOOR_KEY]: 1 });
}

chrome.runtime.onStartup.addListener(() => { void connectNative(); void serializeTabDecision(sweepLegacyBlanks); });
/* Released agent tabs and orphan blanks are swept on a timer the browser keeps, since the worker
   itself may sleep. */
const SWEEP_ALARM = "released-agent-tabs";
void chrome.alarms?.create(SWEEP_ALARM, { periodInMinutes: 1 });
chrome.alarms?.onAlarm.addListener((alarm) => {
  if (alarm.name !== SWEEP_ALARM) return;
  /* One turn with tab creation: a blank created and grouped but not yet saved must not look
     orphaned to the sweep. */
  void serializeTabDecision(async () => { await sweepReleasedTabs(); await sweepOrphanBlanks(); });
});
chrome.tabs.onRemoved.addListener((tabId) => void removeControlledTab(tabId));
chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  void handlePanelMessage(message).then(sendResponse, (error) => sendResponse({ ok: false, error: String(error) }));
  return true;
});

void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
void connectNative();

async function connectNative(): Promise<void> {
  if (nativePort) return;
  try {
    const port = chrome.runtime.connectNative(NATIVE_HOST);
    nativePort = port;
    nativeConnected = true;
    /* A reconnect means the host is back; a pending disconnect release must not fire over it. */
    if (leaseReleaseTimer) {
      clearTimeout(leaseReleaseTimer);
      leaseReleaseTimer = undefined;
    }
    /* The one-time migration also runs here, so reloading the extension clears blanks an older
       build left behind even when Chrome does not fire onInstalled or onStartup. The floor key
       makes it a no-op after the first run. */
    void serializeTabDecision(sweepLegacyBlanks);
    port.onMessage.addListener((message: unknown) => {
      if (isNativeRequest(message)) void handleNativeRequest(message, port);
      else if (isSessionEnded(message)) sessionEndings.ended(message.sessionId);
    });
    port.onDisconnect.addListener(() => {
      const disconnectMessage = chrome.runtime.lastError?.message;
      nativePort = undefined;
      nativeConnected = false;
      void broadcastState();
      scheduleReconnect();
      leaseReleaseTimer = setTimeout(
        () => void releaseAllSessions(disconnectMessage ? `Agent Host disconnected: ${disconnectMessage}` : "Agent Host disconnected"),
        15_000
      );
    });
    await broadcastState();
  } catch {
    nativePort = undefined;
    nativeConnected = false;
    scheduleReconnect();
  }
}

function scheduleReconnect(): void {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => void connectNative(), 2_000);
}

const sessionEndings = new SessionEndings(async (sessionId) => {
  const session = (await allSessions()).get(sessionId);
  if (!session) return;
  /* An ordinary end is not a revoked lease, so unlike releaseSession it records no denial. */
  await chrome.storage.session.remove(SESSION_PREFIX + sessionId);
  await browser.detachTabs(session.controlledTabIds);
  await markReleased(session.controlledTabIds);
  await broadcastState();
});

async function handleNativeRequest(request: NativeRequest, port: chrome.runtime.Port): Promise<void> {
  sessionEndings.resumed(request.sessionId);
  let response: NativeResponse;
  let risk: Risk = "routine";
  let origin: string | undefined;
  try {
    const authorization = await authorize(request);
    risk = authorization.risk;
    origin = authorization.origin;
    const session = await sessionState(request.sessionId);
    /* The mark names the topic and is fixed once it has a real topic. A generic
       default is not stored, so a later label or URL can still supply one. */
    if (!session.mark) {
      const topic = typeof request.params.url === "string" ? request.params.url : undefined;
      const derived = sessionMark({ label: session.label, url: topic });
      if (derived !== DEFAULT_MARK) {
        session.mark = derived;
        await saveSessionState(session);
      }
    }
    const group = {
      key: request.sessionId,
      label: sessionGroupLabel(session),
      color: groupColor(session.leaseHostId, session.sessionId)
    };
    let result: unknown;
    if (request.method === "label_session" || request.method === "tabs_create") {
      /* Read the controlled set inside the turn: an earlier request may have added a tab after this
         one read it, and the write that follows must not drop that tab. */
      result = await serializeTabDecision(async () => {
        const controlled = await controlledTabs(request.sessionId);
        let value: unknown;
        if (request.method === "label_session") {
          value = await labelSession(request, session, controlled);
        } else {
          const url = typeof request.params.url === "string" ? request.params.url : undefined;
          /* The session's own Controlled Tab and Controlled blank win before anything outside the
             boundary is considered (ADR-0023, ADR-0031, ADR-0032). */
          value = await browser.canReuseControlled(controlled, url)
            ? await browser.dispatch(request.method, request.params, controlled, group)
            : (await takeReleasedTab(request, session, controlled, group))
              ?? (await takeExistingTab(request, controlled, group))
              ?? await browser.dispatch(request.method, request.params, controlled, group);
          await recordAgentTab(value, session);
        }
        await saveControlledTabs(request.sessionId, controlled);
        /* Adoption paths return before dispatch; mark the tab here, while the session still holds
           it, so ADR-0024's badge appears on the request that adopted it. */
        await browser.syncMarkers(controlled);
        return value;
      });
    } else {
      const controlled = await controlledTabs(request.sessionId);
      result = await browser.dispatch(request.method, request.params, controlled, group);
      if (request.method === "browser_batch" && isRecord(result) && Array.isArray(result.results)) {
        for (const entry of result.results) await recordAgentTab(entry, session);
      }
      await saveControlledTabs(request.sessionId, controlled);
    }
    const adopted = isRecord(result) && result.adopted === true && typeof result.tabId === "number"
      ? `adopted tab ${result.tabId}`
      : undefined;
    response = { kind: "response", id: request.id, result };
    await audit(request, risk, origin, "succeeded", adopted);
  } catch (error) {
    const normalized = normalizeError(error);
    response = { kind: "response", id: request.id, error: normalized };
    await audit(request, risk, origin, normalized.outcomeUnknown ? "unknown" : "failed", normalized.message);
  }
  try { port.postMessage(response); } catch { /* response lost; bridge returns outcome_unknown */ }
  await broadcastState();
}

async function authorize(request: NativeRequest): Promise<{ risk: Risk; origin?: string }> {
  const state = await persistedState();
  const pairedProof = state.pairedHosts[request.hostId];
  if (pairedProof !== request.pairingProof) {
    const decision = await askApproval({
      kind: "pairing",
      risk: "protected",
      hostId: request.hostId,
      method: request.method,
      title: `Pair ${request.hostId}`,
      detail: "This local Agent Host will be able to request browser access. Pairing does not grant access to any site.",
      preview: `Host: ${request.hostId}\nSession: ${request.sessionId}`,
      allowPersistentGrant: false,
      allowSessionGrant: false
    });
    if (decision === "deny") throw connectorError("pairing_denied", "User denied Host Pairing");
    state.pairedHosts[request.hostId] = request.pairingProof;
    await savePersistedState(state);
  }

  /* No supersede and no browser_busy. Both existed because one record had to represent every
     session at once; with an entry per session there is no incumbent to displace and no other
     session's lease to collide with. */
  const session = await sessionState(request.sessionId);
  if (leaseReleaseTimer) {
    clearTimeout(leaseReleaseTimer);
    leaseReleaseTimer = undefined;
  }
  session.leaseHostId = request.hostId;
  session.sessionId = request.sessionId;
  await saveSessionState(session);

  const controlled = new Set(session.controlledTabIds);
  validateControlledTargets(request.method, request.params, controlled);

  const origins = await requestOrigins(request.method, request.params);
  for (const origin of origins) await ensureSiteGrant(request, origin, state, session);

  const { classification, targetDescription } = await classifyAuthorizedRequest(
    request.method,
    request.params
  );
  if (request.method === "browser_batch" && classification.risk === "critical") {
    throw connectorError(
      "critical_action_not_batchable",
      "Critical Actions cannot be batched; request each one separately so it receives its own consequence warning"
    );
  }
  /* Protected and Critical classifications are recorded, not gated; only code execution and file
     transfer wait for a person (ADR-0029). */
  const gated = methodsNeedingApproval(request.method, request.params);
  if (gated.length) {
    const decision = await askApproval({
      kind: "action",
      risk: classification.risk,
      hostId: request.hostId,
      method: request.method,
      origin: origins[0],
      title: actionTitle(gated[0]!, classification.risk),
      detail: classification.reason,
      preview: actionPreview(request, targetDescription, origins),
      allowPersistentGrant: false,
      allowSessionGrant: false
    });
    if (decision === "deny") throw connectorError("action_denied", "User denied browser action");
  }
  return { risk: classification.risk, origin: origins[0] };
}

async function ensureSiteGrant(
  request: NativeRequest,
  origin: string,
  state: PersistedState,
  session: SessionState
): Promise<void> {
  if (isLocalDevelopmentOrigin(origin)) return;
  const hasGrant = state.alwaysSiteGrants.includes(origin) || session.sessionSiteGrants.includes(origin);
  const hasChromePermission = await chrome.permissions.contains({ origins: [hostPermissionPattern(origin)] });
  if (hasGrant && hasChromePermission) return;
  const decision = await askApproval({
    kind: "site",
    risk: "routine",
    hostId: request.hostId,
    method: request.method,
    origin,
    title: `Allow access to ${origin}`,
    detail: "The connector needs exact-origin access before it can read or act on this site. If this page is already open in a tab, the agent may use that tab.",
    preview: origin,
    allowPersistentGrant: true,
    allowSessionGrant: true
  });
  if (decision === "deny") throw connectorError("site_denied", `User denied access to ${origin}`);
  const nowPermitted = await chrome.permissions.contains({ origins: [hostPermissionPattern(origin)] });
  if (!nowPermitted) throw connectorError("chrome_permission_missing", `Chrome host permission was not granted for ${origin}`);
  if (decision === "always") {
    state.alwaysSiteGrants = [...new Set([...state.alwaysSiteGrants, origin])];
    await savePersistedState(state);
  } else if (decision === "session") {
    session.sessionSiteGrants = [...new Set([...session.sessionSiteGrants, origin])];
    await saveSessionState(session);
  }
}

function validateControlledTargets(method: string, params: Record<string, unknown>, controlled: Set<number>): void {
  if (method === "tabs_context" || method === "tabs_create" || method === "resize_window" || method === "label_session") return;
  if (method === "browser_batch") {
    const actions = Array.isArray(params.actions) ? params.actions : [];
    for (const action of actions) {
      if (!isRecord(action) || typeof action.tool !== "string" || !isRecord(action.arguments)) {
        throw connectorError("invalid_batch", "Batch contains an invalid action");
      }
      if (action.tool === "javascript_tool") throw connectorError("invalid_batch", "javascript_tool cannot be batched");
      validateControlledTargets(action.tool, action.arguments, controlled);
    }
    return;
  }
  if (typeof params.tabId !== "number" || !controlled.has(params.tabId)) {
    throw connectorError("tab_not_controlled", "The requested tab is not a Controlled Tab");
  }
}

async function requestOrigins(method: string, params: Record<string, unknown>): Promise<string[]> {
  /* Closing a tab reads nothing and writes nothing on any origin, so it asks for
     no site grant; the controlled-tab check still gates it. Activating one only
     chooses which controlled tab is in front, and naming touches no page either. */
  if (method === "tabs_close") return [];
  if (method === "tabs_activate") return [];
  if (method === "label_session") return [];
  if (method === "browser_batch") {
    const origins = new Set<string>();
    for (const action of Array.isArray(params.actions) ? params.actions : []) {
      if (isRecord(action) && typeof action.tool === "string" && isRecord(action.arguments)) {
        for (const origin of await requestOrigins(action.tool, action.arguments)) origins.add(origin);
      }
    }
    return [...origins];
  }
  const origins = new Set<string>();
  let explicitOrigin: string | undefined;
  if ((method === "tabs_create" || method === "download_file" || (method === "navigate" && params.action === "go_to"))
    && typeof params.url === "string") {
    explicitOrigin = exactOrigin(params.url);
  }
  if (typeof params.tabId === "number") {
    const tab = await chrome.tabs.get(params.tabId);
    const tabOrigin = tab.url ? exactOrigin(tab.url) : undefined;
    if (tabOrigin) origins.add(tabOrigin);
    if (typeof params.pageRef === "string") {
      const context = await browser.describePageRef(params.tabId, params.pageRef).catch(() => undefined);
      if (context?.destinationOrigin) origins.add(context.destinationOrigin);
    }
  }
  if (explicitOrigin) origins.add(explicitOrigin);
  return [...origins];
}

/* Host Pairing still resolves without a person: a paired host can reach nothing until a Site Grant
   or a local development origin lets it. Site and action approvals wait for the Connector Panel,
   and an unanswered one fails with approval_timeout (ADR-0029). */
async function askApproval(input: Omit<ApprovalRequest, "id" | "createdAt">): Promise<GrantDecision> {
  if (input.kind === "pairing") return "always";
  const request: ApprovalRequest = { ...input, id: crypto.randomUUID(), createdAt: Date.now() };
  let timedOut = false;
  const decision = await new Promise<GrantDecision>((resolve) => {
    const timer = setTimeout(() => { timedOut = true; resolve("deny"); }, APPROVAL_TIMEOUT_MS);
    approvals.set(request.id, { request, resolve: (value) => { clearTimeout(timer); resolve(value); } });
    void showPendingApprovals();
    void broadcastState();
  });
  approvals.delete(request.id);
  await showPendingApprovals();
  await broadcastState();
  if (timedOut) {
    throw connectorError("approval_timeout", `Nobody answered "${request.title}" in the Connector Panel within ${APPROVAL_TIMEOUT_MS / 1000} seconds`);
  }
  return decision;
}

async function showPendingApprovals(): Promise<void> {
  try {
    await chrome.action.setBadgeText({ text: approvals.size ? String(approvals.size) : "" });
    if (approvals.size) await chrome.action.setBadgeBackgroundColor({ color: "#b3261e" });
  } catch { /* badge is a hint only */ }
}

async function handlePanelMessage(message: unknown): Promise<unknown> {
  if (!isRecord(message) || typeof message.type !== "string") return { ok: false };
  if (message.type === "get_state") {
    await connectNative();
    return panelState();
  }
  if (message.type === "approval_decision") {
    const pending = approvals.get(String(message.approvalId));
    if (!pending) return { ok: false, error: "Approval request expired" };
    const decision = String(message.decision) as GrantDecision;
    if (!["once", "session", "always", "deny"].includes(decision)) return { ok: false, error: "Invalid decision" };
    approvals.delete(pending.request.id);
    pending.resolve(decision);
    await broadcastState();
    return { ok: true };
  }
  if (message.type === "control_tab") {
    const tabId = Number(message.tabId);
    const origin = String(message.origin ?? "");
    const session = await mostRecentSession();
    if (!session.sessionId) return { ok: false, error: "No Agent Host session to add the tab to" };
    session.controlledTabIds = [...new Set([...session.controlledTabIds, tabId])];
    if (origin) session.sessionSiteGrants = [...new Set([...session.sessionSiteGrants, origin])];
    await saveSessionState(session);
    await broadcastState();
    return { ok: true };
  }
  if (message.type === "revoke_site") {
    const state = await persistedState();
    state.alwaysSiteGrants = state.alwaysSiteGrants.filter(origin => origin !== String(message.origin));
    await savePersistedState(state);
    await broadcastState();
    return { ok: true };
  }
  if (message.type === "revoke_lease") {
    await releaseAllSessions("Revoked by user");
    return { ok: true };
  }
  if (message.type === "clear_log") {
    const state = await persistedState();
    state.auditEvents = [];
    await savePersistedState(state);
    await broadcastState();
    return { ok: true };
  }
  return { ok: false };
}

async function auditLease(hostId: string | undefined, message: string): Promise<void> {
  if (!hostId) return;
  const state = await persistedState();
  state.auditEvents.push({
    id: crypto.randomUUID(), timestamp: Date.now(), hostId, method: "control_lease", outcome: "denied", risk: "routine", message
  });
  await savePersistedState(state);
}

async function releaseSession(session: SessionState, message: string): Promise<void> {
  if (session.sessionId) await chrome.storage.session.remove(SESSION_PREFIX + session.sessionId);
  await browser.detachTabs(session.controlledTabIds);
  await markReleased(session.controlledTabIds);
  await auditLease(session.leaseHostId, message);
}

/* One native port carries every session, so its disconnect is the end of all of them. */
async function releaseAllSessions(message: string): Promise<void> {
  const sessions = [...(await allSessions()).values()];
  for (const session of sessions) await releaseSession(session, message);
  for (const pending of approvals.values()) pending.resolve("deny");
  approvals.clear();
  await broadcastState();
}

async function removeControlledTab(tabId: number): Promise<void> {
  const records = await agentTabRecords();
  if (records[tabId]) {
    delete records[tabId];
    await chrome.storage.session.set({ [AGENT_TABS_KEY]: records });
  }
  for (const session of (await allSessions()).values()) {
    if (!session.controlledTabIds.includes(tabId)) continue;
    session.controlledTabIds = session.controlledTabIds.filter((id) => id !== tabId);
    await saveSessionState(session);
  }
  await broadcastState();
}

async function audit(
  request: NativeRequest,
  risk: Risk,
  origin: string | undefined,
  outcome: AuditEvent["outcome"],
  message?: string
): Promise<void> {
  const state = await persistedState();
  state.auditEvents = state.auditEvents.filter((event) => event.timestamp > Date.now() - AUDIT_RETENTION_MS);
  state.auditEvents.push({
    id: crypto.randomUUID(), timestamp: Date.now(), hostId: request.hostId, method: request.method, origin, outcome, risk, message
  });
  state.auditEvents = state.auditEvents.slice(-500);
  await savePersistedState(state);
}

async function pruneAudit(): Promise<void> {
  const state = await persistedState();
  state.auditEvents = state.auditEvents.filter((event) => event.timestamp > Date.now() - AUDIT_RETENTION_MS);
  await savePersistedState(state);
}

interface SessionState {
  leaseHostId?: string;
  sessionId?: string;
  /* What this session is working on. Set by the relay's default label before the first browser request, and replaced when the agent calls label_session. */
  label?: string;
  /* The topic mark in the tab group title, fixed once a real topic is known. */
  mark?: string;
  controlledTabIds: number[];
  sessionSiteGrants: string[];
  touchedAt: number;
}

async function persistedState(): Promise<PersistedState> {
  const stored = await chrome.storage.local.get(DEFAULT_STATE) as Partial<PersistedState>;
  return {
    pairedHosts: stored.pairedHosts ?? {},
    alwaysSiteGrants: stored.alwaysSiteGrants ?? [],
    auditEvents: stored.auditEvents ?? []
  };
}

async function savePersistedState(state: PersistedState): Promise<void> {
  await chrome.storage.local.set(state);
}

const SESSION_PREFIX = "s:";

/* Naming is session metadata, not a browser action, so it does not go through Browser.dispatch
   — but it does go through authorize first, like everything else the native host asks for. */
async function labelSession(request: NativeRequest, session: SessionState, controlled: Set<number>): Promise<unknown> {
  const label = typeof request.params.label === "string" ? request.params.label.trim().slice(0, 60) : "";
  if (!label) throw connectorError("invalid_arguments", "A label is required");
  session.label = label;
  /* The caller names the mark when it can. Otherwise an emoji it typed at the start
     of the label wins, then the label's topic, and only then a fallback. */
  const requested = typeof request.params.mark === "string" ? request.params.mark.trim() : "";
  const chosen = requested ? normalizeMark(requested) : undefined;
  if (requested && !chosen) throw connectorError("invalid_arguments", "mark must be a single emoji");
  if (chosen) session.mark = chosen;
  else {
    const explicit = explicitMark(label);
    if (explicit) session.mark = explicit;
    else if (!session.mark) {
      const derived = sessionMark({ label });
      if (derived !== DEFAULT_MARK) session.mark = derived;
    }
  }
  await saveSessionState(session);
  const records = await agentTabRecords();
  for (const tabId of controlled) if (records[tabId]) records[tabId]!.label = label;
  /* The same work resuming in a new session takes back the tabs it opened (ADR-0025). */
  const liveControlled = new Set([...(await allSessions()).values()].flatMap((other) => other.sessionId === request.sessionId ? [] : other.controlledTabIds));
  const openTabs = new Set((await chrome.tabs.query({})).flatMap((tab) => tab.id === undefined ? [] : [tab.id]));
  const adopted = adoptableTabs(records, session, liveControlled, openTabs).filter((tabId) => !controlled.has(tabId));
  for (const tabId of adopted) { controlled.add(tabId); delete records[tabId]!.releasedAt; }
  await chrome.storage.session.set({ [AGENT_TABS_KEY]: records });
  await saveControlledTabs(request.sessionId, controlled);
  const group = { key: request.sessionId, label: sessionGroupLabel(session), color: groupColor(session.leaseHostId, session.sessionId) };
  if (adopted.length) await browser.adoptGroup(group, adopted);
  /* The stored label is the session's label — the relay's default or the agent's replacement; the
     title is that label wearing the session's mark, which is why the title is recomputed here
     rather than reused. */
  await browser.renameGroup(group);
  return adopted.length ? { labelled: label, adoptedTabIds: adopted } : { labelled: label };
}

const AGENT_TABS_KEY = "agentTabs";

async function markReleased(tabIds: number[]): Promise<void> {
  const records = await agentTabRecords();
  let changed = false;
  for (const tabId of tabIds) {
    const record = records[tabId];
    if (!record) continue;
    const tab = await chrome.tabs.get(tabId).catch(() => undefined);
    record.releasedAt = Date.now();
    /* Where the tab lived when it was released: the sweep later closes it only while it is still
       in that group, so a tab the person moved out is theirs. */
    if (tab) {
      record.groupId = tab.groupId;
      record.windowId = tab.windowId;
    }
    changed = true;
  }
  if (changed) await chrome.storage.session.set({ [AGENT_TABS_KEY]: records });
}

async function liveControlledTabs(exceptSessionId?: string): Promise<Set<number>> {
  return new Set([...(await allSessions()).values()].flatMap((other) => other.sessionId === exceptSessionId ? [] : other.controlledTabIds));
}

/* tabs_create for a URL a released tab of the same Agent Host already shows takes that tab into this
   session instead of opening another copy (ADR-0025, ADR-0027). This branch must run only after the
   session's own Controlled Tab and Controlled blank tab have been checked (ADR-0031, ADR-0032). */
async function takeReleasedTab(request: NativeRequest, session: SessionState, controlled: Set<number>, group: GroupDescriptor): Promise<unknown> {
  const url = typeof request.params.url === "string" ? request.params.url : undefined;
  if (!url) return undefined;
  const records = await agentTabRecords();
  const open = (await chrome.tabs.query({})).flatMap((tab) => tab.id === undefined ? [] : [{
    id: tab.id, url: tab.url, pinned: tab.pinned, incognito: tab.incognito
  }]);
  const tabId = reusableReleasedTab(records, session.leaseHostId, await liveControlledTabs(request.sessionId), open, (tabUrl) => sameNavigationTarget(tabUrl, url));
  /* A tab this session already controls is not a released tab; browser.dispatch will reuse it
     under ADR-0023 without pretending it was adopted again. */
  if (tabId === undefined || controlled.has(tabId)) return undefined;
  const tab = await chrome.tabs.get(tabId).catch(() => undefined);
  /* The query snapshot is older than this read; do not overwrite a navigation the
     person made in between. */
  if (!tab?.url || !sameNavigationTarget(tab.url, url)) return undefined;
  /* sameNavigationTarget matches the document, not the hash route inside it. */
  const navigated = sameTargetDifferentHash(tab.url, url);
  if (navigated) await chrome.tabs.update(tabId, { url }).catch(() => undefined);
  controlled.add(tabId);
  delete records[tabId]!.releasedAt;
  if (session.label) records[tabId]!.label = session.label;
  await chrome.storage.session.set({ [AGENT_TABS_KEY]: records });
  await browser.adoptGroup(group, [tabId]);
  /* Written before the adoption lock opens again: the next session must see this tab as held. */
  await saveControlledTabs(request.sessionId, controlled);
  const current = navigated ? await chrome.tabs.get(tabId).catch(() => tab) : tab;
  return { tabId, windowId: current.windowId, url: current.url ? redactUrl(current.url) : redactUrl(url), reused: true, adopted: true, ...(navigated ? { navigated: true } : {}) };
}

/* A tab the person already has at the requested URL is taken into the session instead of opening a
   duplicate (ADR-0031). A tab recorded as an agent's is left to takeReleasedTab, which knows how to
   hand it back with its record. The tab is joined to this session's group rather than adopting the
   group it already lives in: that group is the person's. */
async function takeExistingTab(request: NativeRequest, controlled: Set<number>, group: GroupDescriptor): Promise<unknown> {
  const url = typeof request.params.url === "string" ? request.params.url : undefined;
  if (!url) return undefined;
  const records = await agentTabRecords();
  const sessionWindows = new Set<number>();
  for (const tabId of controlled) {
    const tab = await chrome.tabs.get(tabId).catch(() => undefined);
    if (tab) sessionWindows.add(tab.windowId);
  }
  const focused = await chrome.windows.getLastFocused({ windowTypes: ["normal"] }).catch(() => undefined);
  const tabId = adoptableOpenTab(await chrome.tabs.query({}), {
    records,
    liveControlled: await liveControlledTabs(request.sessionId),
    sessionControlled: controlled,
    windowIds: sessionWindows,
    focusedWindowId: focused?.id,
    matches: (candidate) => sameNavigationTarget(candidate, url)
  });
  if (tabId === undefined) return undefined;
  const tab = await chrome.tabs.get(tabId).catch(() => undefined);
  /* The person may have navigated the tab between the query and this read. */
  if (!tab?.url || !sameNavigationTarget(tab.url, url)) return undefined;
  /* The document matches, but a hash route inside it may not. */
  const navigated = sameTargetDifferentHash(tab.url, url);
  if (navigated) await chrome.tabs.update(tabId, { url }).catch(() => undefined);
  controlled.add(tabId);
  try {
    await browser.ensureTabGroup(group, tabId);
    /* Written before the adoption lock opens again: the next session must see this tab as held. */
    await saveControlledTabs(request.sessionId, controlled);
    const current = navigated ? await chrome.tabs.get(tabId).catch(() => tab) : tab;
    return { tabId, windowId: current.windowId, url: current.url ? redactUrl(current.url) : redactUrl(url), reused: true, adopted: true, ...(navigated ? { navigated: true } : {}) };
  } catch {
    controlled.delete(tabId);
    return undefined;
  }
}

async function sweepReleasedTabs(): Promise<void> {
  const records = await agentTabRecords();
  if (!Object.values(records).some((record) => record.releasedAt !== undefined && Date.now() - record.releasedAt >= RELEASED_TAB_TTL_MS)) return;
  const open = (await chrome.tabs.query({})).flatMap((tab) => tab.id === undefined ? [] : [{
    id: tab.id,
    groupId: tab.groupId,
    active: tab.active,
    pinned: tab.pinned,
    audible: tab.audible,
    incognito: tab.incognito
  }]);
  for (const tabId of releasedTabsToClose(records, Date.now(), await liveControlledTabs(), open)) {
    await chrome.tabs.remove(tabId).catch(() => undefined);
    delete records[tabId];
  }
  /* Records of tabs that are gone are dropped with them. */
  const openIds = new Set(open.map((tab) => tab.id));
  for (const key of Object.keys(records)) if (!openIds.has(Number(key))) delete records[key];
  await chrome.storage.session.set({ [AGENT_TABS_KEY]: records });
}

/* A blank tab left in a connector group has no content worth keeping: ADR-0027's ten minutes
   exists for pages, not placeholders. The group title is the only durable owner mark, and a tab a
   live session holds or the person is looking at is left alone. */
async function sweepOrphanBlanks(agentCreatedOnly = true): Promise<void> {
  const groups = await chrome.tabGroups.query({}).catch(() => []);
  const connectorGroups = new Map(
    groups.filter((group) => isConnectorGroupTitle(group.title)).map((group) => [group.id, group.title ?? ""])
  );
  if (!connectorGroups.size) return;
  const tabs = (await chrome.tabs.query({})).filter((tab) => tab.groupId !== undefined && connectorGroups.has(tab.groupId));
  const focused = new Set((await chrome.windows.getAll())
    .filter((window) => window.focused)
    .flatMap((window) => window.id === undefined ? [] : [window.id]));
  /* Chrome may not be the focused app, so the last window it had is still where the person left
     off looking. */
  const lastFocused = await chrome.windows.getLastFocused({ windowTypes: ["normal"] }).catch(() => undefined);
  if (lastFocused?.id !== undefined) focused.add(lastFocused.id);
  const records = await agentTabRecords();
  const agentCreated = agentCreatedOnly ? new Set(Object.keys(records).map(Number)) : undefined;
  const close = orphanBlankTabsToClose(
    tabs.map((tab) => ({ ...tab, groupTitle: connectorGroups.get(tab.groupId!) })),
    {
      liveControlled: await liveControlledTabs(),
      focusedWindowIds: focused,
      ...(agentCreated ? { agentCreated } : {})
    }
  );
  for (const tabId of close) await chrome.tabs.remove(tabId).catch(() => undefined);
}

/* A one-time migration for blanks an earlier build created without recording them. After it runs,
   the periodic sweep closes only tabs this build knows the agent created, so a tab the person
   opened can never be mistaken for one. */
const BLANK_SWEEP_FLOOR_KEY = "blankSweepFloor";
async function sweepLegacyBlanks(): Promise<void> {
  const stored = await chrome.storage.local.get(BLANK_SWEEP_FLOOR_KEY);
  if (stored[BLANK_SWEEP_FLOOR_KEY] === 1) return;
  await sweepOrphanBlanks(false);
  await chrome.storage.local.set({ [BLANK_SWEEP_FLOOR_KEY]: 1 });
}

async function agentTabRecords(): Promise<AgentTabRecords> {
  const stored = (await chrome.storage.session.get(AGENT_TABS_KEY))[AGENT_TABS_KEY];
  return isRecord(stored) ? stored as AgentTabRecords : {};
}

/* Only a tab the agent itself opened is recorded, so label_session resumption (ADR-0025) can
   never reach a tab the person opened or handed over through the panel; tabs_create's open-tab
   adoption is a separate path (ADR-0031). */
async function recordAgentTab(result: unknown, session: SessionState): Promise<void> {
  if (!shouldRecordAgentTab(result) || !session.leaseHostId) return;
  const records = await agentTabRecords();
  records[result.tabId] = { hostId: session.leaseHostId, ...(session.label ? { label: session.label } : {}) };
  await chrome.storage.session.set({ [AGENT_TABS_KEY]: records });
}

function normalizeSession(value: unknown, sessionId: string): SessionState {
  const record = isRecord(value) ? value : {};
  return {
    sessionId,
    leaseHostId: typeof record.leaseHostId === "string" ? record.leaseHostId : undefined,
    label: typeof record.label === "string" && record.label ? record.label : undefined,
    mark: typeof record.mark === "string" && record.mark ? record.mark : undefined,
    controlledTabIds: Array.isArray(record.controlledTabIds) ? record.controlledTabIds.map(Number) : [],
    sessionSiteGrants: Array.isArray(record.sessionSiteGrants) ? record.sessionSiteGrants.map(String) : [],
    touchedAt: typeof record.touchedAt === "number" ? record.touchedAt : 0
  };
}

async function allSessions(): Promise<Map<string, SessionState>> {
  const stored = await chrome.storage.session.get(null);
  const sessions = new Map<string, SessionState>();
  for (const [key, value] of Object.entries(stored)) {
    if (!key.startsWith(SESSION_PREFIX)) continue;
    const sessionId = key.slice(SESSION_PREFIX.length);
    sessions.set(sessionId, normalizeSession(value, sessionId));
  }
  return sessions;
}

async function sessionState(sessionId: string): Promise<SessionState> {
  return (await allSessions()).get(sessionId) ?? normalizeSession(undefined, sessionId);
}

/* The record carries its own id, so the callers that only ever held a record still work
   unchanged — only the readers that used to imply "the" session had to be told which one. */
async function saveSessionState(state: SessionState): Promise<void> {
  if (!state.sessionId) return;
  await chrome.storage.session.set({
    [SESSION_PREFIX + state.sessionId]: { ...state, touchedAt: Date.now() }
  });
}

/* For callers holding no session: the panel's control_tab, and the tab-removed listener. The
   most recently used session is exactly what "the" session meant when there was only one. It
   is a stopgap, not a model — the panel has no session of its own to name yet. */
async function mostRecentSession(): Promise<SessionState> {
  const sessions = [...(await allSessions()).values()];
  if (!sessions.length) return normalizeSession(undefined, "");
  return sessions.reduce((a, b) => (b.touchedAt > a.touchedAt ? b : a));
}

async function controlledTabs(sessionId: string): Promise<Set<number>> {
  return new Set((await sessionState(sessionId)).controlledTabIds);
}

async function saveControlledTabs(sessionId: string, tabs: Set<number>): Promise<void> {
  const session = await sessionState(sessionId);
  session.controlledTabIds = [...tabs];
  await saveSessionState(session);
}

async function panelState(): Promise<PanelState> {
  const state = await persistedState();
  const sessions = [...(await allSessions()).values()].sort((a, b) => b.touchedAt - a.touchedAt);
  const recent = sessions[0];
  return {
    nativeConnected,
    pairedHosts: Object.keys(state.pairedHosts),
    leaseHostId: recent?.leaseHostId,
    controlledTabIds: recent?.controlledTabIds ?? [],
    leases: sessions.map((session) => ({
      sessionId: session.sessionId ?? "",
      hostId: session.leaseHostId,
      tabIds: session.controlledTabIds
    })),
    approvals: [...approvals.values()].map(({ request }) => request),
    allowedSites: [...state.alwaysSiteGrants].sort(),
    auditEvents: [...state.auditEvents].reverse().slice(0, 50)
  };
}

async function broadcastState(): Promise<void> {
  try { await chrome.runtime.sendMessage({ type: "state_changed", state: await panelState() }); } catch { /* panel closed */ }
}

function actionTitle(method: string, risk: Risk): string {
  if (risk === "critical") return `Confirm Critical Action: ${method}`;
  if (risk === "protected") return `Approve Protected Action: ${method}`;
  return `Approve browser change: ${method}`;
}

function actionPreview(request: NativeRequest, targetDescription: string, origins: string[]): string {
  if (request.method === "javascript_tool") return String(request.params.source ?? "");
  const safeParams = redactPreviewValues(request.params);
  const crossOrigin = origins.length > 1
    ? `Source: ${origins[0]}\nDestination: ${origins.slice(1).join(", ")}\nData category: ${actionDataCategory(request)}`
    : "";
  return [crossOrigin, targetDescription && `Target: ${targetDescription}`, JSON.stringify(safeParams, null, 2)]
    .filter(Boolean)
    .join("\n");
}

function actionDataCategory(request: NativeRequest): string {
  if (request.method === "form_input") return "form value (redacted)";
  if (request.method === "upload_file") return "approved file bytes";
  if (request.method === "download_file") return "downloaded response bytes";
  if (request.method === "computer" && request.params.action === "type") return "typed text (redacted)";
  if (request.method === "navigate") return "navigation URL only";
  return "browser interaction; payload not inspectable";
}

async function classifyAuthorizedRequest(
  method: string,
  params: Record<string, unknown>
): Promise<{ classification: ReturnType<typeof classifyRequest>; targetDescription: string }> {
  if (method !== "browser_batch") {
    let targetDescription = "";
    if (typeof params.pageRef === "string" && typeof params.tabId === "number") {
      const context = await browser.describePageRef(params.tabId, params.pageRef).catch(() => undefined);
      targetDescription = [
        context?.description,
        context?.destinationOrigin && `Cross-origin destination: ${context.destinationOrigin}`
      ].filter(Boolean).join("\n");
    }
    return { classification: classifyRequest(method, params, targetDescription), targetDescription };
  }

  let classification: ReturnType<typeof classifyRequest> = {
    risk: "read_only",
    reason: "Batch contains read-only actions"
  };
  const descriptions: string[] = [];
  for (const action of Array.isArray(params.actions) ? params.actions : []) {
    if (!isRecord(action) || typeof action.tool !== "string" || !isRecord(action.arguments)) continue;
    const nested = await classifyAuthorizedRequest(action.tool, action.arguments);
    if (nested.targetDescription) descriptions.push(`${action.tool}: ${nested.targetDescription}`);
    if (riskRank(nested.classification.risk) > riskRank(classification.risk)) classification = nested.classification;
  }
  return {
    classification: { ...classification, reason: `Batch inherits its highest action risk: ${classification.risk}` },
    targetDescription: descriptions.join("\n")
  };
}

function riskRank(risk: Risk): number {
  return { read_only: 0, routine: 1, protected: 2, critical: 3 }[risk];
}

function redactPreviewValues(value: unknown, key?: string): unknown {
  if (key && ["dataBase64", "value", "text"].includes(key)) return "[redacted]";
  if (Array.isArray(value)) return value.map((entry) => redactPreviewValues(entry));
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([entryKey, entry]) => [entryKey, redactPreviewValues(entry, entryKey)]));
  }
  return value;
}

function isNativeRequest(value: unknown): value is NativeRequest {
  return isRecord(value)
    && value.kind === "request"
    && typeof value.id === "number"
    && typeof value.method === "string"
    && isRecord(value.params)
    && typeof value.hostId === "string"
    && typeof value.sessionId === "string"
    && typeof value.pairingProof === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
