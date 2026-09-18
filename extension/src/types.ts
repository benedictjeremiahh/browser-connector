export type Risk = "read_only" | "routine" | "protected" | "critical";
export type GrantDecision = "once" | "session" | "always" | "deny";

export interface NativeRequest {
  kind: "request";
  id: number;
  method: string;
  params: Record<string, unknown>;
  hostId: string;
  sessionId: string;
  pairingProof: string;
}

export interface NativeResponse {
  kind: "response";
  id: number;
  result?: unknown;
  error?: { code: string; message: string; outcomeUnknown?: boolean };
}

export interface ApprovalRequest {
  id: string;
  kind: "pairing" | "site" | "action";
  risk: Risk;
  hostId: string;
  method: string;
  origin?: string;
  title: string;
  detail: string;
  preview?: string;
  createdAt: number;
  allowPersistentGrant: boolean;
  allowSessionGrant: boolean;
}

export interface AuditEvent {
  id: string;
  timestamp: number;
  hostId: string;
  method: string;
  origin?: string;
  outcome: "allowed" | "denied" | "succeeded" | "failed" | "unknown";
  risk: Risk;
  message?: string;
}

export interface PersistedState {
  pairedHosts: Record<string, string>;
  alwaysSiteGrants: string[];
  auditEvents: AuditEvent[];
}

export interface PanelState {
  nativeConnected: boolean;
  pairedHosts: string[];
  leaseHostId?: string;
  controlledTabIds: number[];
  approvals: ApprovalRequest[];
  auditEvents: AuditEvent[];
}

export const DEFAULT_STATE: PersistedState = {
  pairedHosts: {},
  alwaysSiteGrants: [],
  auditEvents: []
};
