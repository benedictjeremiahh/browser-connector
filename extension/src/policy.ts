import type { Risk } from "./types";

const READ_ONLY = new Set([
  "read_page",
  "get_page_text",
  "find",
  "read_console_messages",
  "read_network_requests"
]);

const PROTECTED = new Set(["javascript_tool", "upload_file", "download_file"]);
const RESTRICTED_PROTOCOLS = new Set(["chrome:", "chrome-extension:", "devtools:", "edge:", "file:"]);
const CRITICAL_WORDS = /\b(buy|purchase|pay|payment|place order|confirm order|complete order|checkout|transfer|wire|send money|withdraw|deposit|trade|bid|donate|delete|erase|wipe|empty trash|close account|terminate account|irreversible)\b/i;
const PROTECTED_WORDS = /\b(submit|publish|send|authorize|grant|upload|download|delete|remove)\b/i;

export interface Classification {
  risk: Risk;
  reason: string;
}

export function classifyRequest(
  method: string,
  params: Record<string, unknown>,
  targetDescription = ""
): Classification {
  if (method === "tabs_context" && !params.createIfEmpty) {
    return { risk: "read_only", reason: "Reads controlled-tab metadata" };
  }
  if (method === "label_session") {
    return { risk: "routine", reason: "Names this session's tab group" };
  }
  if (READ_ONLY.has(method)) {
    if (method === "read_network_requests" && params.includeResponseBody === true) {
      return { risk: "protected", reason: "Reads a network response body" };
    }
    return { risk: "read_only", reason: "Reads browser state" };
  }
  if (PROTECTED.has(method)) {
    return { risk: "protected", reason: `${method} always requires explicit approval` };
  }
  if (method === "browser_batch") {
    const actions = Array.isArray(params.actions) ? params.actions : [];
    let highest: Risk = "read_only";
    for (const action of actions) {
      if (!isRecord(action) || typeof action.tool !== "string" || !isRecord(action.arguments)) continue;
      const nested = classifyRequest(action.tool, action.arguments).risk;
      if (nested === "critical") return { risk: "critical", reason: "Batch contains a Critical Action" };
      if (nested === "protected") highest = "protected";
      else if (nested === "routine" && highest === "read_only") highest = "routine";
    }
    return { risk: highest, reason: `Batch inherits its highest action risk: ${highest}` };
  }

  if (CRITICAL_WORDS.test(targetDescription)) {
    return { risk: "critical", reason: `Target appears financially consequential or irreversible: ${targetDescription}` };
  }
  if (PROTECTED_WORDS.test(targetDescription)) {
    return { risk: "protected", reason: `Target creates an external consequence: ${targetDescription}` };
  }
  if (method === "computer" && params.action === "click" && !params.pageRef) {
    return { risk: "protected", reason: "Coordinate clicks cannot be semantically classified" };
  }
  return {
    risk: "routine",
    reason: "Routine browser mutation"
  };
}

export function isRestrictedUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return RESTRICTED_PROTOCOLS.has(url.protocol) || !["http:", "https:", "about:"].includes(url.protocol);
  } catch {
    return true;
  }
}

export function exactOrigin(value: string): string | undefined {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) ? url.origin : undefined;
  } catch {
    return undefined;
  }
}

export function hostPermissionPattern(origin: string): string {
  return `${origin}/*`;
}

export function redactUrl(value: string): string {
  try {
    const url = new URL(value);
    for (const key of [...url.searchParams.keys()]) url.searchParams.set(key, "[redacted]");
    url.hash = "";
    return url.toString();
  } catch {
    return "[invalid-url]";
  }
}

export function clampLimit(value: unknown, fallback: number, hardLimit: number): number {
  return Math.max(1, Math.min(typeof value === "number" ? Math.floor(value) : fallback, hardLimit));
}

export function boundedText(value: string, maxBytes = 65_536): { text: string; truncated: boolean; originalBytes: number } {
  const bytes = new TextEncoder().encode(value);
  if (bytes.length <= maxBytes) return { text: value, truncated: false, originalBytes: bytes.length };
  return {
    text: new TextDecoder().decode(bytes.slice(0, maxBytes)),
    truncated: true,
    originalBytes: bytes.length
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
