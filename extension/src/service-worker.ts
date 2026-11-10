import { BrowserController, connectorError, normalizeError, type GroupDescriptor } from "./browser";
import { RELEASED_TAB_TTL_MS, adoptableOpenTab, adoptableTabs, orphanBlankTabsToClose, releasedTabsToClose, reusableReleasedTab, shouldRecordAgentTab, type AgentTabRecords } from "./adoption";
import { explicitMark, groupColor, isConnectorGroupTitle, meaningfulSessionLabel, normalizeMark, sessionGroupLabel, sessionMark, withoutLeadingMark } from "./naming";
import { SessionEndings, isSessionEnded } from "./session-endings";
import { classifyRequest, exactOrigin, hostPermissionPattern, isLocalDevelopmentOrigin, methodsNeedingApproval, redactUrl, sameNavigationTarget, sameTargetDifferentHash } from "./policy";
import {
  type ApprovalRequest,
  type ActivityState,
  type AuditEvent,
  type GrantDecision,
  type NativeRequest,
  type NativeResponse,
  type PanelState,
  type PanelTab,
  type PersistedState,
  type Risk
} from "./types";

const SESSION_PREFIX = "s:";
const AGENT_TABS_KEY = "agentTabs";
const RECLAIMED_TABS_KEY = "reclaimedTabs";
const NATIVE_HOST = "io.browser_connector.native";
/* Below the relay's 60 second request timeout, so an unanswered approval fails with a definite
   approval_timeout rather than an outcome the agent cannot know. */
const APPROVAL_TIMEOUT_MS = 50_000;
const AUDIT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const browser = new BrowserController();
const approvals = new Map<string, { request: ApprovalRequest; sessionId: string; resolve: (decision: GrantDecision) => void }>();
let nativePort: chrome.runtime.Port | undefined;
let nativeConnected = false;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let leaseReleaseTimer: ReturnType<typeof setTimeout> | undefined;

/* Adoption and tab creation both read which tabs no one else holds and then write this session's
   controlled set. Two requests arriving together must not take the same tab, so that decision
   runs one at a time; the approval wait before it is not serialized. */
const hostOrdinals = new Map<string, number>();
const sessionJobs = new Map<string, Promise<unknown>>();
const pendingReleases = new Map<number, string>();
let auditMutation: Promise<void> = Promise.resolve();
let grantMutation: Promise<void> = Promise.resolve();
let pairingMutation: Promise<void> = Promise.resolve();
let releasingAll = false;
const sessionsReady = restoreSessions();
let tabDecision: Promise<unknown> = sessionsReady;
function serializeTabDecision<T>(work: () => Promise<T>): Promise<T> {
  const next = tabDecision.then(work, work);
  tabDecision = next.catch(() => undefined);
  return next;
}

function queueSession<T>(sessionId: string, work: () => Promise<T>): Promise<T> {
  const job = (sessionJobs.get(sessionId) ?? sessionsReady).then(work);
  const settled = job.catch(() => undefined);
  sessionJobs.set(sessionId, settled);
  void settled.then(() => {
    if (sessionJobs.get(sessionId) === settled) sessionJobs.delete(sessionId);
  });
  return job;
}

function cancelApprovals(sessionId?: string): void {
  for (const pending of approvals.values()) {
    if (sessionId === undefined || pending.sessionId === sessionId) pending.resolve("deny");
  }
}

chrome.runtime.onInstalled.addListener(() => {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  void pruneAudit();
  void serializeTabDecision(dropAutoApprovedSiteGrants);
  void serializeTabDecision(sweepLegacyBlanks);
});

/* The auto-approve build stored an "always" grant for every origin it touched, so those grants
   record where agents went, not what a person allowed. They are cleared once, when this build is
   first installed. */
const SITE_GRANT_FLOOR_KEY = "siteGrantFloor";
async function dropAutoApprovedSiteGrants(): Promise<void> {
  const stored = await chrome.storage.local.get(SITE_GRANT_FLOOR_KEY);
  if (stored[SITE_GRANT_FLOOR_KEY] === 1) return;
  await updateAlwaysSiteGrants(() => []);
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
  void sessionsReady.then(() => handlePanelMessage(message))
    .then(sendResponse, (error) => sendResponse({ ok: false, error: normalizeError(error).message }));
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
      if (isNativeRequest(message)) {
        if (releasingAll) {
          port.postMessage({ kind: "response", id: message.id, error: {
            code: "control_releasing", message: "Tab control is being released. Refresh your tab context."
          } });
          return;
        }
        sessionEndings.resumed(message.sessionId);
        void queueSession(message.sessionId, () => handleNativeRequest(message, port));
      } else if (isSessionEnded(message)) sessionEndings.ended(message.sessionId);
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
  if (releasingAll) return;
  cancelApprovals(sessionId);
  await queueSession(sessionId, () => serializeTabDecision(async () => {
    const session = (await allSessions()).get(sessionId);
    if (!session) return;
    /* An ordinary end keeps agent-created tabs eligible for the same work to resume. */
    await chrome.storage.session.remove(SESSION_PREFIX + sessionId);
    await browser.detachTabs(session.controlledTabIds);
    await markReleased(session.controlledTabIds);
  }));
  await broadcastState();
});

async function handleNativeRequest(request: NativeRequest, port: chrome.runtime.Port): Promise<void> {
  let response: NativeResponse;
  let risk: Risk = "routine";
  let origin: string | undefined;
  let sessionCreated = false;
  try {
    if (nativePort !== port) throw connectorError("disconnected", "The agent connection was lost");
    if (releasingAll) throw connectorError("control_releasing", "Tab control is being released");
    const authorization = await authorize(request, (created) => { sessionCreated = created; });
    risk = authorization.risk;
    origin = authorization.origin;
    sessionCreated = authorization.sessionCreated;
    const session = await sessionState(request.sessionId);
    const group = groupFor(session);
    const validate = (method: string, params: Record<string, unknown>, controlled: Set<number>) =>
      validateControlledTargets(method, params, controlled);
    let result: unknown;
    if (request.method === "label_session" || request.method === "tabs_create") {
      /* Read the controlled set inside the turn: an earlier request may have added a tab after this
         one read it, and the write that follows must not drop that tab. */
      result = await serializeTabDecision(async () => {
        const controlled = await controlledTabs(request.sessionId);
        validate(request.method, request.params, controlled);
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
      validate(request.method, request.params, controlled);
      result = await browser.dispatch(request.method, request.params, controlled, group,
        (method, params) => validate(method, params, controlled));
      if (request.method === "browser_batch" && isRecord(result) && Array.isArray(result.results)) {
        await serializeTabDecision(async () => {
          for (const entry of (result as { results: unknown[] }).results) await recordAgentTab(entry, session);
        });
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
  await broadcastState(sessionCreated || requestChangesLease(request) ? "full" : "activity");
}

async function authorize(
  request: NativeRequest,
  onSessionCreated: (created: boolean) => void
): Promise<{ risk: Risk; origin?: string; sessionCreated: boolean }> {
  const state = await readAuthorization();
  const pairedProof = state.pairedHosts[request.hostId];
  if (pairedProof !== request.pairingProof) {
    const decision = await askApproval(request.sessionId, {
      kind: "pairing",
      risk: "protected",
      hostId: request.hostId,
      method: request.method,
      title: `Pair ${request.hostId}`,
      detail: "This local Agent Host will be able to request browser access. Pairing does not grant access to any site.",
      preview: `Host: ${request.hostId}\nSession: ${request.sessionId}`,
      allowPersistentGrant: false,
      allowSessionGrant: false
    }, request);
    if (decision === "deny") throw connectorError("pairing_denied", "User denied Host Pairing");
    await updatePairedHosts((pairedHosts) => ({ ...pairedHosts, [request.hostId]: request.pairingProof }));
  }

  /* No supersede and no browser_busy. Both existed because one record had to represent every
     session at once; with an entry per session there is no incumbent to displace and no other
     session's lease to collide with. */
  const session = await sessionState(request.sessionId);
  const sessionCreated = !session.leaseHostId;
  onSessionCreated(sessionCreated);
  if (leaseReleaseTimer) {
    clearTimeout(leaseReleaseTimer);
    leaseReleaseTimer = undefined;
  }
  if (session.leaseHostId && session.leaseHostId !== request.hostId) {
    throw connectorError("session_host_mismatch", "This browser session belongs to a different agent host");
  }
  session.leaseHostId = request.hostId;
  session.ordinal ??= nextOrdinal(request.hostId);
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
    const decision = await askApproval(request.sessionId, {
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
    }, request);
    if (decision === "deny") throw connectorError("action_denied", "User denied browser action");
  }
  return { risk: classification.risk, origin: origins[0], sessionCreated };
}

async function ensureSiteGrant(
  request: NativeRequest,
  origin: string,
  state: Pick<PersistedState, "alwaysSiteGrants">,
  session: SessionState
): Promise<void> {
  if (isLocalDevelopmentOrigin(origin)) return;
  const hasGrant = state.alwaysSiteGrants.includes(origin) || session.sessionSiteGrants.includes(origin);
  const hasChromePermission = await chrome.permissions.contains({ origins: [hostPermissionPattern(origin)] });
  if (hasGrant && hasChromePermission) return;
  const decision = await askApproval(request.sessionId, {
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
  }, request);
  if (decision === "deny") throw connectorError("site_denied", `User denied access to ${origin}`);
  const nowPermitted = await chrome.permissions.contains({ origins: [hostPermissionPattern(origin)] });
  if (!nowPermitted) throw connectorError("chrome_permission_missing", `Chrome host permission was not granted for ${origin}`);
  if (decision === "always") {
    await updateAlwaysSiteGrants((grants) => grants.includes(origin) ? grants : [...grants, origin]);
  } else if (decision === "session") {
    session.sessionSiteGrants = [...new Set([...session.sessionSiteGrants, origin])];
    await saveSessionState(session);
  }
}

function validateControlledTargets(method: string, params: Record<string, unknown>, controlled: Set<number>): void {
  if (releasingAll) throw connectorError("control_releasing", "Tab control is being released");
  if ((method === "tabs_create" || method === "resize_window") && [...controlled].some((id) => pendingReleases.has(id))) {
    throw connectorError("control_releasing", "The user is taking back a tab in this session");
  }
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
  if (pendingReleases.has(params.tabId)) throw connectorError("control_releasing", "The user is taking back this tab");
}

const ACTIVITY_ONLY_METHODS = new Set([
  "read_page", "get_page_text", "find", "read_console_messages", "read_network_requests", "wait_for", "assert"
]);

function requestChangesLease(request: NativeRequest): boolean {
  const isActivityOnly = (method: string, params: Record<string, unknown>): boolean => {
    if (method === "tabs_context") return params.createIfEmpty !== true;
    if (method === "browser_batch") {
      const actions = Array.isArray(params.actions) ? params.actions : [];
      return actions.every((action) => isRecord(action) && typeof action.tool === "string" && isRecord(action.arguments)
        && isActivityOnly(action.tool, action.arguments));
    }
    return ACTIVITY_ONLY_METHODS.has(method);
  };
  return !isActivityOnly(request.method, request.params);
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
async function askApproval(
  sessionId: string,
  input: Omit<ApprovalRequest, "id" | "createdAt" | "sessionName" | "targets">,
  sourceRequest?: NativeRequest
): Promise<GrantDecision> {
  if (releasingAll || [...pendingReleases.values()].includes(sessionId)) return "deny";
  if (input.kind === "pairing") return "always";
  const session = await sessionState(sessionId);
  const sessionName = session.leaseHostId ? sessionGroupLabel(session) : sourceRequest?.hostId;
  const targetIds = approvalTargetIds(sourceRequest);
  const targets = (await Promise.all(targetIds.map(panelTab))).filter((tab): tab is PanelTab => tab !== undefined);
  if (releasingAll || [...pendingReleases.values()].includes(sessionId)) return "deny";
  const request: ApprovalRequest = {
    ...input,
    ...(sessionName ? { sessionName } : {}),
    ...(targets.length ? { targets } : {}),
    id: crypto.randomUUID(),
    createdAt: Date.now()
  };
  let timedOut = false;
  const decision = await new Promise<GrantDecision>((resolve) => {
    const timer = setTimeout(() => { timedOut = true; resolve("deny"); }, APPROVAL_TIMEOUT_MS);
    approvals.set(request.id, { request, sessionId, resolve: (value) => { clearTimeout(timer); resolve(value); } });
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

function approvalTargetIds(request: NativeRequest | undefined): number[] {
  if (!request) return [];
  const ids = new Set<number>();
  const add = (value: unknown) => {
    if (typeof value === "number" && Number.isSafeInteger(value)) ids.add(value);
  };
  add(request.params.tabId);
  if (request.method === "browser_batch" && Array.isArray(request.params.actions)) {
    for (const action of request.params.actions) {
      if (isRecord(action) && isRecord(action.arguments)) add(action.arguments.tabId);
    }
  }
  return [...ids];
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
  if (message.type === "get_activity") {
    const events = await readAuditEvents();
    const activity: ActivityState = { count: events.length };
    if (message.includeEvents === true) activity.events = events.slice(-50).reverse();
    return activity;
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
  if (message.type === "control_tab" || message.type === "release_tab" || message.type === "show_tab") {
    const { sessionId, tabId } = message;
    if (typeof sessionId !== "string" || typeof tabId !== "number" || !Number.isSafeInteger(tabId)) {
      return { ok: false, error: "Choose a tab and an agent session." };
    }
    if (releasingAll) return { ok: false, error: "Tab control is being released." };
    const takingBack = message.type === "release_tab";
    if (takingBack) {
      if (pendingReleases.has(tabId)) return { ok: false, error: "This tab is already being released." };
      pendingReleases.set(tabId, sessionId);
      cancelApprovals(sessionId);
    }
    try {
      await queueSession(sessionId, () => serializeTabDecision(async () => {
        if (releasingAll) throw connectorError("control_releasing", "Tab control is being released");
        const session = (await allSessions()).get(sessionId);
        if (!session?.leaseHostId) throw connectorError("session_missing", "This agent session is no longer available.");
        if (message.type === "control_tab") {
          await claimTab(session, tabId, message.expectedUrl);
          return;
        }
        if (!session.controlledTabIds.includes(tabId)) {
          throw connectorError("tab_not_controlled", "This session no longer controls the tab.");
        }
        if (message.type === "show_tab") {
          const tab = await chrome.tabs.update(tabId, { active: true });
          if (tab?.windowId !== undefined) {
            const window = await chrome.windows.get(tab.windowId);
            if (window.state === "minimized") await chrome.windows.update(tab.windowId, { state: "normal" });
            await chrome.windows.update(tab.windowId, { focused: true });
          }
          return;
        }
        const remaining = session.controlledTabIds.filter((id) => id !== tabId);
        await protectReclaimedTabs([tabId]);
        session.controlledTabIds = remaining;
        await saveSessionState(session);
        await browser.detachTabs([tabId]);
        await browser.releaseGroup(groupFor(session), [tabId], remaining);
      }));
    } finally {
      if (takingBack) pendingReleases.delete(tabId);
    }
    await broadcastState();
    return { ok: true };
  }
  if (message.type === "revoke_site") {
    await updateAlwaysSiteGrants((grants) => grants.filter(origin => origin !== String(message.origin)));
    await broadcastState();
    return { ok: true };
  }
  if (message.type === "add_site") {
    const origin = canonicalSiteOrigin(message.origin);
    if (!origin) return { ok: false, error: "Enter a canonical HTTP or HTTPS origin." };
    if (isLocalDevelopmentOrigin(origin)) return { ok: true, alreadyAllowed: true };
    if ((await readAlwaysSiteGrants()).includes(origin)) return { ok: true, alreadyAllowed: true };
    if (!await chrome.permissions.contains({ origins: [hostPermissionPattern(origin)] })) {
      return { ok: false, error: "Chrome has not granted access to this site." };
    }
    const updated = await updateAlwaysSiteGrants((grants) => grants.includes(origin) ? grants : [...grants, origin]);
    if (!updated.changed) return { ok: true, alreadyAllowed: true };
    await broadcastState();
    return { ok: true };
  }
  if (message.type === "revoke_lease") {
    await releaseAllSessions("Revoked by user", true);
    return { ok: true };
  }
  if (message.type === "clear_log") {
    await updateAuditEvents(() => []);
    await broadcastState("activity");
    return { ok: true };
  }
  return { ok: false };
}

async function auditLease(hostId: string | undefined, message: string): Promise<void> {
  if (!hostId) return;
  await updateAuditEvents((events) => [...events, {
    id: crypto.randomUUID(), timestamp: Date.now(), hostId, method: "control_lease", outcome: "denied", risk: "routine", message
  }]);
}

async function claimTab(session: SessionState, tabId: number, expectedUrl: unknown): Promise<void> {
  if (!nativeConnected) throw connectorError("disconnected", "Reconnect before giving control.");
  const owner = [...(await allSessions()).values()].find((candidate) => candidate.controlledTabIds.includes(tabId));
  if (owner && owner.sessionId !== session.sessionId) {
    throw connectorError("tab_already_controlled", `This tab is already controlled by ${sessionGroupLabel(owner)}.`);
  }
  const origin = typeof expectedUrl === "string" ? exactOrigin(expectedUrl) : undefined;
  if (!origin) throw connectorError("unsupported_tab", "Switch to a website before giving control.");
  if (!await chrome.permissions.contains({ origins: [hostPermissionPattern(origin)] })) {
    throw connectorError("chrome_permission_missing", "Allow Browser Connector to access this site in Chrome, then try again.");
  }
  const tab = await chrome.tabs.get(tabId).catch(() => undefined);
  if (!tab?.active || tab.url !== expectedUrl || (tab.pendingUrl && tab.pendingUrl !== tab.url)) {
    throw connectorError("tab_changed", "The active tab changed. Check the tab and try again.");
  }
  if (!nativeConnected) throw connectorError("disconnected", "Reconnect before giving control.");
  const reclaimed = await reclaimedTabs();
  const wasReclaimed = reclaimed.delete(tabId);
  if (!session.controlledTabIds.includes(tabId)) session.controlledTabIds.push(tabId);
  if (!session.sessionSiteGrants.includes(origin)) session.sessionSiteGrants.push(origin);
  await saveSessionState(session, wasReclaimed ? { [RECLAIMED_TABS_KEY]: [...reclaimed] } : {});
  if (wasReclaimed && tab.groupId >= 0) {
    const group = await chrome.tabGroups.get(tab.groupId).catch(() => undefined);
    // A tab given back to an agent must stop appearing under a released group.
    if (group?.title?.startsWith("Released · ")) await chrome.tabs.ungroup(tabId).catch(() => undefined);
  }
  await browser.syncMarkers([tabId]);
}

async function releaseAllSessions(message: string, explicit = false): Promise<void> {
  if (releasingAll) return;
  releasingAll = true;
  cancelApprovals();
  try {
    await Promise.all(sessionJobs.values());
    await serializeTabDecision(async () => {
      const sessions = await allSessions();
      if (explicit) await protectReclaimedTabs([...sessions.values()].flatMap((session) => session.controlledTabIds));
      await chrome.storage.session.remove([...sessions.keys()].map((id) => SESSION_PREFIX + id));
      for (const session of sessions.values()) {
        await browser.detachTabs(session.controlledTabIds);
        if (explicit) await browser.releaseGroup(groupFor(session), session.controlledTabIds, []);
        else await markReleased(session.controlledTabIds);
        await auditLease(session.leaseHostId, message);
      }
    });
  } finally {
    releasingAll = false;
    await broadcastState();
  }
}

async function removeControlledTab(tabId: number): Promise<void> {
  await sessionsReady;
  const sessions = await allSessions();
  if (releasingAll) return;
  await Promise.all([...sessions.keys()].map((id) => queueSession(id, async () => {
    const session = await sessionState(id);
    if (!session.controlledTabIds.includes(tabId)) return;
    session.controlledTabIds = session.controlledTabIds.filter((value) => value !== tabId);
    await saveSessionState(session);
  })));
  await serializeTabDecision(async () => {
    const records = await agentTabRecords();
    const reclaimed = await reclaimedTabs();
    if (records[tabId]) {
      delete records[tabId];
      await chrome.storage.session.set({ [AGENT_TABS_KEY]: records });
    }
    if (reclaimed.delete(tabId)) await chrome.storage.session.set({ [RECLAIMED_TABS_KEY]: [...reclaimed] });
  });
  await broadcastState();
}

async function reclaimedTabs(): Promise<Set<number>> {
  const stored = (await chrome.storage.session.get(RECLAIMED_TABS_KEY))[RECLAIMED_TABS_KEY];
  return new Set(Array.isArray(stored) ? stored.filter((id): id is number => Number.isSafeInteger(id)) : []);
}

async function protectReclaimedTabs(tabIds: number[]): Promise<void> {
  if (!tabIds.length) return;
  const reclaimed = await reclaimedTabs();
  const records = await agentTabRecords();
  for (const tabId of tabIds) {
    reclaimed.add(tabId);
    delete records[tabId];
  }
  await chrome.storage.session.set({ [RECLAIMED_TABS_KEY]: [...reclaimed], [AGENT_TABS_KEY]: records });
}

async function audit(
  request: NativeRequest,
  risk: Risk,
  origin: string | undefined,
  outcome: AuditEvent["outcome"],
  message?: string
): Promise<void> {
  await updateAuditEvents((events) => {
    const retained = events.filter((event) => event.timestamp > Date.now() - AUDIT_RETENTION_MS);
    retained.push({
    id: crypto.randomUUID(), timestamp: Date.now(), hostId: request.hostId, method: request.method, origin, outcome, risk, message
    });
    return retained.slice(-500);
  });
}

async function pruneAudit(): Promise<void> {
  await updateAuditEvents((events) => events.filter((event) => event.timestamp > Date.now() - AUDIT_RETENTION_MS));
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
  ordinal?: number;
  suffix?: string;
}

async function readAuthorization(): Promise<Pick<PersistedState, "pairedHosts" | "alwaysSiteGrants">> {
  const { pairedHosts, alwaysSiteGrants } = await chrome.storage.local.get(["pairedHosts", "alwaysSiteGrants"]);
  return {
    pairedHosts: isRecord(pairedHosts) ? pairedHosts as Record<string, string> : {},
    alwaysSiteGrants: Array.isArray(alwaysSiteGrants) ? alwaysSiteGrants.map(String) : []
  };
}

async function readAlwaysSiteGrants(): Promise<string[]> {
  const { alwaysSiteGrants } = await chrome.storage.local.get("alwaysSiteGrants");
  return Array.isArray(alwaysSiteGrants) ? alwaysSiteGrants.map(String) : [];
}

async function readAuditEvents(): Promise<AuditEvent[]> {
  const { auditEvents } = await chrome.storage.local.get("auditEvents");
  return Array.isArray(auditEvents) ? auditEvents as AuditEvent[] : [];
}

async function updateAuditEvents(update: (events: AuditEvent[]) => AuditEvent[]): Promise<void> {
  const next = auditMutation.then(async () => {
    await chrome.storage.local.set({ auditEvents: update(await readAuditEvents()) });
  });
  auditMutation = next.catch(() => undefined);
  return next;
}

async function updateAlwaysSiteGrants(update: (grants: string[]) => string[]): Promise<{ grants: string[]; changed: boolean }> {
  let result: { grants: string[]; changed: boolean } = { grants: [], changed: false };
  const next = grantMutation.then(async () => {
    const current = await readAlwaysSiteGrants();
    const grants = update(current);
    result = { grants, changed: grants.length !== current.length || grants.some((origin, index) => origin !== current[index]) };
    if (result.changed) await chrome.storage.local.set({ alwaysSiteGrants: grants });
  });
  grantMutation = next.catch(() => undefined);
  await next;
  return result;
}

async function updatePairedHosts(update: (hosts: Record<string, string>) => Record<string, string>): Promise<void> {
  const next = pairingMutation.then(async () => {
    const stored = await chrome.storage.local.get("pairedHosts");
    const hosts = isRecord(stored.pairedHosts) ? stored.pairedHosts as Record<string, string> : {};
    await chrome.storage.local.set({ pairedHosts: update(hosts) });
  });
  pairingMutation = next.catch(() => undefined);
  return next;
}

/* Naming is session metadata, not a browser action, so it does not go through Browser.dispatch
   — but it does go through authorize first, like everything else the native host asks for. */
async function labelSession(request: NativeRequest, session: SessionState, controlled: Set<number>): Promise<unknown> {
  const raw = typeof request.params.label === "string" ? request.params.label.trim() : "";
  if (!raw) throw connectorError("invalid_arguments", "A label is required");
  const requested = typeof request.params.mark === "string" ? request.params.mark.trim() : "";
  const chosen = requested ? normalizeMark(requested) : undefined;
  if (requested && !chosen) throw connectorError("invalid_arguments", "mark must be a single emoji");
  const name = meaningfulSessionLabel(raw, session.leaseHostId);
  if (!name) return { labelled: meaningfulSessionLabel(session.label, session.leaseHostId) ?? null, displayName: sessionGroupLabel(session) };

  const previousGroup = groupFor(session);
  const label = [...name].slice(0, 60).join("");
  if (session.label !== label) session.suffix = undefined;
  session.mark = chosen ?? explicitMark(raw) ?? (session.label === label ? session.mark : undefined) ?? sessionMark({ label });
  session.label = label;
  const titles = new Set([...(await allSessions()).values()]
    .filter((other) => other.sessionId !== session.sessionId)
    .map(sessionGroupLabel));
  disambiguateSession(session, titles);
  session.controlledTabIds = [...controlled];
  await saveSessionState(session);
  const records = await agentTabRecords();
  for (const tabId of controlled) if (records[tabId]) records[tabId]!.label = label;
  /* The same work resuming in a new session takes back the tabs it opened (ADR-0025). */
  const liveControlled = await liveControlledTabs(request.sessionId);
  const openTabs = new Set((await chrome.tabs.query({})).flatMap((tab) => tab.id === undefined ? [] : [tab.id]));
  const adopted = adoptableTabs(records, session, liveControlled, openTabs).filter((tabId) => !controlled.has(tabId));
  for (const tabId of adopted) { controlled.add(tabId); delete records[tabId]!.releasedAt; }
  await chrome.storage.session.set({ [AGENT_TABS_KEY]: records });
  await saveControlledTabs(request.sessionId, controlled);
  const group = groupFor(session);
  await browser.renameGroup(group, previousGroup);
  if (adopted.length) await browser.adoptGroup(group, adopted);
  return { labelled: label, displayName: group.label, ...(adopted.length ? { adoptedTabIds: adopted } : {}) };
}

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
  const unavailable = await reclaimedTabs();
  for (const session of (await allSessions()).values()) {
    if (session.sessionId !== exceptSessionId) for (const id of session.controlledTabIds) unavailable.add(id);
  }
  return unavailable;
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
  const current = await chrome.tabs.get(tabId).catch(() => tab);
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
    const current = await chrome.tabs.get(tabId).catch(() => tab);
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
    ordinal: typeof record.ordinal === "number" && Number.isSafeInteger(record.ordinal) && record.ordinal > 0 ? record.ordinal : undefined,
    suffix: typeof record.suffix === "string" ? record.suffix : undefined
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
async function saveSessionState(state: SessionState, updates: Record<string, unknown> = {}): Promise<void> {
  if (!state.sessionId) return;
  await chrome.storage.session.set({ ...updates, [SESSION_PREFIX + state.sessionId]: state });
}

function groupFor(session: SessionState): GroupDescriptor {
  return { key: session.sessionId ?? "", label: sessionGroupLabel(session), color: groupColor(session.leaseHostId, session.sessionId) };
}

function nextOrdinal(hostId: string): number {
  const key = hostId.toLowerCase();
  const ordinal = (hostOrdinals.get(key) ?? 0) + 1;
  hostOrdinals.set(key, ordinal);
  return ordinal;
}

function disambiguateSession(session: SessionState, titles: Set<string>): void {
  if (!titles.has(sessionGroupLabel(session))) return;
  const identity = `${session.leaseHostId?.slice(0, 14) ?? "Session"} ${session.ordinal}`;
  session.suffix = identity;
  let counter = 2;
  while (titles.has(sessionGroupLabel(session))) session.suffix = `${identity} (${counter++})`;
}

async function restoreSessions(): Promise<void> {
  const sessions = await allSessions();
  const seen = new Set<number>();
  const shared = new Set<number>();
  for (const session of sessions.values()) {
    if (session.leaseHostId && session.ordinal !== undefined) {
      const host = session.leaseHostId.toLowerCase();
      hostOrdinals.set(host, Math.max(session.ordinal, hostOrdinals.get(host) ?? 0));
    }
    for (const id of new Set(session.controlledTabIds)) {
      if (seen.has(id)) shared.add(id);
      seen.add(id);
    }
  }
  const titles = new Set<string>();
  for (const session of sessions.values()) {
    if (!session.leaseHostId) continue;
    const previous = groupFor(session);
    session.ordinal ??= nextOrdinal(session.leaseHostId);
    disambiguateSession(session, titles);
    const group = groupFor(session);
    titles.add(group.label);
    session.controlledTabIds = session.controlledTabIds.filter((id) => !shared.has(id));
    await saveSessionState(session);
    if (group.label !== previous.label) await browser.renameGroup(group, previous);
  }
  if (shared.size) {
    await protectReclaimedTabs([...shared]);
    await browser.detachTabs(shared);
  }
}

async function controlledTabs(sessionId: string): Promise<Set<number>> {
  return new Set((await sessionState(sessionId)).controlledTabIds);
}

async function saveControlledTabs(sessionId: string, tabs: Set<number>): Promise<void> {
  const session = await sessionState(sessionId);
  session.controlledTabIds = [...tabs];
  await saveSessionState(session);
}

async function panelTab(tabId: number): Promise<PanelTab | undefined> {
  const tab = await chrome.tabs.get(tabId).catch(() => undefined);
  if (!tab) return undefined;
  const origin = tab.url ? exactOrigin(tab.url) : undefined;
  const safeUrl = tab.url ? redactUrl(tab.url) : undefined;
  return {
    tabId, windowId: tab.windowId, index: tab.index, title: tab.title || "Untitled tab", origin,
    path: origin && safeUrl ? new URL(safeUrl).pathname : undefined
  };
}

async function panelState(): Promise<PanelState> {
  const [grants, all] = await Promise.all([readAlwaysSiteGrants(), allSessions()]);
  const sessions = [...all.values()];
  const leases = await Promise.all(sessions.flatMap((session) => {
    if (!session.sessionId || !session.leaseHostId) return [];
    const { sessionId, leaseHostId: hostId, controlledTabIds } = session;
    return [Promise.all(controlledTabIds.map(panelTab)).then((tabs) => ({
      sessionId, hostId, displayName: sessionGroupLabel(session), tabs: tabs.filter((tab) => tab !== undefined)
    }))];
  }));
  leases.sort((a, b) => withoutLeadingMark(a.displayName).localeCompare(withoutLeadingMark(b.displayName), undefined, { numeric: true }));
  return {
    nativeConnected, leases,
    approvals: [...approvals.values()].map(({ request }) => request),
    allowedSites: grants.sort()
  };
}

async function broadcastState(scope: "full" | "activity" = "full"): Promise<void> {
  try {
    await chrome.runtime.sendMessage(scope === "activity"
      ? { type: "state_changed", scope: "activity" }
      : { type: "state_changed" });
  } catch { /* panel closed */ }
}

function canonicalSiteOrigin(value: unknown): string | undefined {
  if (typeof value !== "string" || !value || value.trim() !== value) return undefined;
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hostname.includes("*")) return undefined;
    return url.origin === value ? value : undefined;
  } catch {
    return undefined;
  }
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
