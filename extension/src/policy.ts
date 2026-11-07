import type { Risk } from "./types";

const READ_ONLY = new Set([
  "read_page",
  "get_page_text",
  "find",
  "read_console_messages",
  "read_network_requests",
  "wait_for",
  "assert"
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
  if (method === "tabs_context") {
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

/* The comparable identity of a navigable address. A fragment is a position inside
   a document rather than a different document, so two tabs that differ only by
   hash are the same target; anything that is not http(s) has no comparable
   identity at all. */
export function navigationTarget(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol)) return undefined;
    url.hash = "";
    /* The order query parameters were written in is not part of the page's identity. */
    url.searchParams.sort();
    return url.toString();
  } catch {
    return undefined;
  }
}

export function sameNavigationTarget(left: string, right: string): boolean {
  const a = navigationTarget(left);
  return a !== undefined && a === navigationTarget(right);
}

export function isRestrictedUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return RESTRICTED_PROTOCOLS.has(url.protocol) || !["http:", "https:", "about:"].includes(url.protocol);
  } catch {
    return true;
  }
}

/* The blank destinations Chrome starts a tab at. A blank tab is a placeholder the connector may
   navigate; it is not a page with state to preserve. A pendingUrl covers a tab that has not
   committed yet, and an about:blank fragment is still the blank document. */
export function isBlankTabUrl(url: string | undefined, pendingUrl?: string): boolean {
  /* The destination, not the committed document: a tab navigating away from about:blank has a
     real pendingUrl and is no longer a placeholder. */
  const destination = pendingUrl ?? url;
  return destination === "about:blank"
    || destination?.startsWith("about:blank#") === true
    || destination === "chrome://newtab"
    || destination === "chrome://newtab/";
}

export function exactOrigin(value: string): string | undefined {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) ? url.origin : undefined;
  } catch {
    return undefined;
  }
}

/* A page served from this machine for development. Agents work on these all day, so they need no
   site approval; every other origin does, because the browser is signed in to real accounts. */
export function isLocalDevelopmentOrigin(origin: string): boolean {
  let host: string;
  try { host = new URL(origin).hostname.toLowerCase(); } catch { return false; }
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]"
    || host.endsWith(".localhost") || host.endsWith(".test");
}

/* Methods that run code in a page or move a file across the browser boundary. Each call is
   approved on its own, wherever it runs. */
export const APPROVAL_METHODS = new Set(["javascript_tool", "upload_file", "download_file"]);

export function methodsNeedingApproval(method: string, params: Record<string, unknown>): string[] {
  if (method !== "browser_batch") return APPROVAL_METHODS.has(method) ? [method] : [];
  const actions = Array.isArray(params.actions) ? params.actions : [];
  return actions.flatMap(action => {
    const tool = typeof action === "object" && action !== null ? (action as { tool?: unknown }).tool : undefined;
    return typeof tool === "string" && APPROVAL_METHODS.has(tool) ? [tool] : [];
  });
}

export function hostPermissionPattern(origin: string): string {
  return `${origin}/*`;
}

/* Path segments that name a capability rather than a place: a link-borne token after a
   reset/verify/invite style segment, a JWT, or a long random string. UUIDs and slugs stay,
   because they are how an agent tells pages apart. */
const TOKEN_PATH_PARENT = /^(reset|reset-password|verify|verification|confirm|invite|invitation|magic|magic-link|token|activate|unsubscribe|share|s)$/i;
/* Matched against the key's parts (split on - and _), so "keyword" and "country" stay readable while
   "api_key", "X-Amz-Signature" and "sid" do not. */
const SENSITIVE_QUERY_PART = /^(token|secret|key|code|sig|signature|auth|session|sid|pass|password|pwd|otp|jwt|state|nonce|credential|credentials|email|phone|ticket|hash|invite|magic|t|k|apikey|access|refresh|bearer)$/i;
const sensitiveQueryKey = (key: string) => key.split(/[-_.]/).some(part => SENSITIVE_QUERY_PART.test(part)) || /token|secret|password|signature|credential/i.test(key);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function secretPathSegment(segment: string, previous: string | undefined): boolean {
  if (!segment || UUID.test(segment)) return false;
  if (/^eyJ[\w-]+\.[\w-]+/.test(segment)) return true;
  if (previous && TOKEN_PATH_PARENT.test(previous) && segment.length >= 16) return true;
  return segment.length >= 32 && /^[\w-]+$/.test(segment) && /\d/.test(segment) && /[a-z]/i.test(segment);
}

export function redactUrl(value: string): string {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    /* A value is kept only when neither its name nor its shape suggests a secret or personal data:
       ?tab=transfers tells an agent where it is, ?token=… or a long opaque value does not. */
    for (const [key, value] of [...url.searchParams.entries()]) {
      const opaque = value.length >= 16 && /\d/.test(value) && /[a-z]/i.test(value);
      if (sensitiveQueryKey(key) || value.length >= 24 || opaque || value.includes("@") || /^eyJ/.test(value)) url.searchParams.set(key, "[redacted]");
    }
    const segments = url.pathname.split("/");
    url.pathname = segments.map((segment, index) => secretPathSegment(segment, segments[index - 1]) ? "[redacted]" : segment).join("/");
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
