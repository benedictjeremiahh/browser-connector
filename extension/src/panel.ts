import { exactOrigin, hostPermissionPattern } from "./policy";
import type { ApprovalRequest, GrantDecision, PanelState } from "./types";

const status = byId("status");
const pairedHost = byId("paired-host");
const leaseHost = byId("lease-host");
const tabCount = byId("tab-count");
const mode = byId("permission-mode") as HTMLSelectElement;
const approvalCount = byId("approval-count");
const approvalsRoot = byId("approvals");
const auditRoot = byId("audit-log");
const template = byId("approval-template") as HTMLTemplateElement;

mode.addEventListener("change", () => void chrome.runtime.sendMessage({ type: "set_permission_mode", mode: mode.value }));
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
  mode.value = state.permissionMode;
  approvalCount.textContent = String(state.approvals.length);
  renderApprovals(state.approvals);
  renderAudit(state);
}

function renderApprovals(requests: ApprovalRequest[]): void {
  approvalsRoot.replaceChildren();
  if (requests.length === 0) {
    approvalsRoot.className = "empty";
    approvalsRoot.textContent = "No requests waiting.";
    return;
  }
  approvalsRoot.className = "";
  for (const request of requests) {
    const fragment = template.content.cloneNode(true) as DocumentFragment;
    setText(fragment, ".approval-kind", `${request.risk.toUpperCase()} · ${request.kind.toUpperCase()}`);
    setText(fragment, ".approval-title", request.title);
    setText(fragment, ".approval-detail", request.detail);
    const preview = fragment.querySelector<HTMLElement>(".approval-preview")!;
    preview.textContent = request.preview ?? "No content preview.";
    fragment.querySelector<HTMLElement>(".session")!.hidden = !request.allowSessionGrant;
    fragment.querySelector<HTMLElement>(".always")!.hidden = !request.allowPersistentGrant;
    for (const button of fragment.querySelectorAll<HTMLButtonElement>("[data-decision]")) {
      button.addEventListener("click", () => void decide(request, button.dataset.decision as GrantDecision));
    }
    approvalsRoot.append(fragment);
  }
}

function renderAudit(state: PanelState): void {
  auditRoot.replaceChildren();
  for (const event of state.auditEvents) {
    const item = document.createElement("li");
    item.textContent = `${event.hostId} · ${event.method} · ${event.outcome}${event.origin ? ` · ${event.origin}` : ""}`;
    const time = document.createElement("time");
    time.dateTime = new Date(event.timestamp).toISOString();
    time.textContent = new Date(event.timestamp).toLocaleString();
    item.append(time);
    auditRoot.append(item);
  }
}

async function decide(request: ApprovalRequest, decision: GrantDecision): Promise<void> {
  if (decision !== "deny" && request.origin) {
    const pattern = hostPermissionPattern(request.origin);
    const hasPermission = await chrome.permissions.contains({ origins: [pattern] });
    if (!hasPermission) {
      const granted = await chrome.permissions.request({ origins: [pattern] });
      if (!granted) {
        await chrome.runtime.sendMessage({ type: "approval_decision", approvalId: request.id, decision: "deny" });
        return;
      }
    }
  }
  await chrome.runtime.sendMessage({ type: "approval_decision", approvalId: request.id, decision });
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

function setText(root: DocumentFragment, selector: string, value: string): void {
  const element = root.querySelector<HTMLElement>(selector);
  if (element) element.textContent = value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

