import { BrowserController, connectorError, normalizeError } from "./browser";
import { classifyRequest, exactOrigin, hostPermissionPattern } from "./policy";
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
const AUDIT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const browser = new BrowserController();
const approvals = new Map<string, { request: ApprovalRequest; resolve: (decision: GrantDecision) => void }>();
let nativePort: chrome.runtime.Port | undefined;
let nativeConnected = false;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let leaseReleaseTimer: ReturnType<typeof setTimeout> | undefined;

chrome.runtime.onInstalled.addListener(() => {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  void pruneAudit();
});

chrome.runtime.onStartup.addListener(() => void connectNative());
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
    port.onMessage.addListener((message: unknown) => {
      if (isNativeRequest(message)) void handleNativeRequest(message, port);
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

async function handleNativeRequest(request: NativeRequest, port: chrome.runtime.Port): Promise<void> {
  let response: NativeResponse;
  let risk: Risk = "routine";
  let origin: string | undefined;
  try {
    const authorization = await authorize(request);
    risk = authorization.risk;
    origin = authorization.origin;
    const controlled = await controlledTabs(request.sessionId);
    const session = await sessionState(request.sessionId);
    const group = { key: request.sessionId, label: sessionGroupLabel(session) };
    const result = request.method === "label_session"
      ? await labelSession(request, session)
      : await browser.dispatch(request.method, request.params, controlled, group);
    await saveControlledTabs(request.sessionId, controlled);
    response = { kind: "response", id: request.id, result };
    await audit(request, risk, origin, "succeeded");
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
  const mustApproveAction = classification.risk === "protected"
    || classification.risk === "critical";
  if (mustApproveAction) {
    const decision = await askApproval({
      kind: "action",
      risk: classification.risk,
      hostId: request.hostId,
      method: request.method,
      origin: origins[0],
      title: actionTitle(request.method, classification.risk),
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
    detail: "The connector needs exact-origin access before it can read or act on this site.",
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
     no site grant; the controlled-tab check still gates it. Naming touches no page either. */
  if (method === "tabs_close") return [];
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

// Auto-approval build: host pairing, site grants and action approval all
// resolve without the side panel, so a connected Agent Host needs no user
// action. The panel becomes a status and audit view.
//
// This deliberately removes the Control Lease / Site Grant / Protected Action
// gate. Chrome host permissions are declared statically in the manifest, so the
// per-origin prompt is gone too. "always" persists site grants so the decision
// is not re-evaluated per request.
async function askApproval(_input: Omit<ApprovalRequest, "id" | "createdAt">): Promise<GrantDecision> {
  return "always";
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
  /* What this session is working on, as the agent named it. Absent until the agent says. */
  label?: string;
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

/* The group title is how a person tells two sessions apart in the tab strip, so it carries a
   readable slice of the session id rather than an opaque index. Chrome truncates long titles
   from the end, which is why the id goes first and stays short. */
function sessionGroupLabel(session: SessionState): string {
  if (session.label) return session.label;
  return session.sessionId ? `Browser Connector ${session.sessionId.slice(0, 8)}` : "Browser Connector";
}

/* Naming is session metadata, not a browser action, so it does not go through Browser.dispatch
   — but it does go through authorize first, like everything else the native host asks for. */
async function labelSession(request: NativeRequest, session: SessionState): Promise<unknown> {
  const label = typeof request.params.label === "string" ? request.params.label.trim().slice(0, 60) : "";
  if (!label) throw connectorError("invalid_arguments", "A label is required");
  session.label = label;
  await saveSessionState(session);
  await browser.renameGroup({ key: request.sessionId, label });
  return { labelled: label };
}

function normalizeSession(value: unknown, sessionId: string): SessionState {
  const record = isRecord(value) ? value : {};
  return {
    sessionId,
    leaseHostId: typeof record.leaseHostId === "string" ? record.leaseHostId : undefined,
    label: typeof record.label === "string" && record.label ? record.label : undefined,
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
