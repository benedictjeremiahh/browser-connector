import { exactOrigin, hostPermissionPattern } from "./policy";
import type { PanelState } from "./types";

const status = byId("status");
const pairedHost = byId("paired-host");
const leaseHost = byId("lease-host");
const tabCount = byId("tab-count");
const mode = byId("permission-mode") as HTMLSelectElement;
const auditRoot = byId("audit-log");

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
  renderAudit(state);
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

