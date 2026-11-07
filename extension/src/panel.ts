import { exactOrigin, hostPermissionPattern } from "./policy";
import type { ApprovalRequest, GrantDecision, PanelState } from "./types";

const status = byId("status");
const pairedHost = byId("paired-host");
const leaseHost = byId("lease-host");
const tabCount = byId("tab-count");
const auditRoot = byId("audit-log");
const approvalsSection = byId("approvals-section");
const approvalsRoot = byId("approvals");
const sitesRoot = byId("allowed-sites");

byId("revoke-lease").addEventListener("click", () => void chrome.runtime.sendMessage({ type: "revoke_lease" }));
byId("clear-log").addEventListener("click", () => void chrome.runtime.sendMessage({ type: "clear_log" }));
byId("control-current").addEventListener("click", () => void controlCurrentTab());

chrome.runtime.onMessage.addListener((message: unknown) => {
  if (isRecord(message) && message.type === "state_changed" && isRecord(message.state)) render(message.state as unknown as PanelState);
});

void refresh();

async function refresh(): Promise<void> {
  const state = await chrome.runtime.sendMessage({ type: "get_state" }) as PanelState;
  render(state);
}

function render(state: PanelState): void {
  status.textContent = state.nativeConnected ? "Connected" : "Disconnected";
  status.classList.toggle("disconnected", !state.nativeConnected);
  pairedHost.textContent = state.pairedHosts.join(", ") || "None";
  leaseHost.textContent = state.leaseHostId ?? "None";
  tabCount.textContent = String(state.controlledTabIds.length);
  renderApprovals(state.approvals);
  renderSites(state.allowedSites ?? []);
  renderAudit(state);
}

function renderApprovals(requests: ApprovalRequest[]): void {
  approvalsSection.hidden = requests.length === 0;
  approvalsRoot.replaceChildren();
  for (const request of requests) {
    const item = document.createElement("li");
    const title = document.createElement("h3");
    title.textContent = request.title;
    const detail = document.createElement("p");
    detail.className = "detail";
    detail.textContent = `${request.hostId}${request.origin ? ` · ${request.origin}` : ""} · ${request.detail}`;
    item.append(title, detail);
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
      button.addEventListener("click", () => void chrome.runtime.sendMessage({ type: "approval_decision", approvalId: request.id, decision }));
      actions.append(button);
    }
    item.append(actions);
    approvalsRoot.append(item);
  }
}

function renderSites(origins: string[]): void {
  sitesRoot.replaceChildren();
  if (!origins.length) {
    const empty = document.createElement("li");
    empty.textContent = "None";
    sitesRoot.append(empty);
  }
  for (const origin of origins) {
    const item = document.createElement("li");
    const name = document.createElement("span");
    name.textContent = origin;
    const remove = document.createElement("button");
    remove.className = "link";
    remove.textContent = "Remove";
    remove.addEventListener("click", () => void chrome.runtime.sendMessage({ type: "revoke_site", origin }));
    item.append(name, remove);
    sitesRoot.append(item);
  }
}

function renderAudit(state: PanelState): void {
  auditRoot.replaceChildren();
  for (const event of state.auditEvents) {
    const item = document.createElement("li");
    item.textContent = `${event.hostId} · ${event.method} · ${event.outcome}${event.origin ? ` · ${event.origin}` : ""}${event.message ? ` · ${event.message}` : ""}`;
    const time = document.createElement("time");
    time.dateTime = new Date(event.timestamp).toISOString();
    time.textContent = new Date(event.timestamp).toLocaleString();
    item.append(time);
    auditRoot.append(item);
  }
}

async function controlCurrentTab(): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url) return;
  const origin = exactOrigin(tab.url);
  if (!origin) return;
  const granted = await chrome.permissions.request({ origins: [hostPermissionPattern(origin)] });
  if (!granted) return;
  await chrome.runtime.sendMessage({ type: "control_tab", tabId: tab.id, origin });
}

function byId(id: string): HTMLElement {
  const value = document.getElementById(id);
  if (!value) throw new Error(`Missing #${id}`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

