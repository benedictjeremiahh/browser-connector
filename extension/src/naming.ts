/* Presentation of an Agent Host session in the browser's tab strip.
   Pure functions only: the tab group title is the one place a person sees which
   session is which, so it is worth testing without a browser. */

/* Chrome's tab groups have a title and a color and no icon slot, so the only way
   to put a mark on one is a character in the title. The mark names the topic: the
   color already names the session. */
export const DEFAULT_MARK = "🌐";

/* A leading emoji is an explicit choice by the agent, so it wins over keywords. */
const VS16 = String.fromCodePoint(0xfe0f);
const ZWJ = String.fromCodePoint(0x200d);
const LEADING_MARK = new RegExp(`^(\\p{Extended_Pictographic}(?:${VS16}|${ZWJ}|\\p{Extended_Pictographic})*)\\s*`, "u");

/* Order matters: put the more specific topic before the generic one. */
const TOPIC_MARKS: readonly [RegExp, string][] = [
  [/\b(test|tests|debug|bug|failing|regression)\b/, "🐛"],
  [/\b(docs?|readme|adr|spec|documentation)\b/, "📄"],
  [/\b(design|figma|ui|ux|mockup|screenshot|visual)\b/, "🎨"],
  [/\b(pay|payment|invoice|billing|bank|finance|stripe|checkout)\b/, "💳"],
  [/\b(mail|email|gmail|inbox|calendar)\b/, "✉️"],
  [/\b(video|youtube|movie|stream)\b/, "🎬"],
  [/\b(map|maps|location|route|directions)\b/, "🗺️"],
  [/\b(shop|store|cart|order|product)\b/, "🛒"],
  [/\b(data|dashboard|metric|chart|report|analytics)\b/, "📊"],
  [/\b(chat|discussion|message|slack|thread)\b/, "💬"],
  [/\b(code|repo|github|git|pr|branch|deploy|build)\b/, "🧑‍💻"]
];

/* Chrome's own set, in the order it lists them. */
export const GROUP_COLORS = [
  "grey",
  "blue",
  "red",
  "yellow",
  "green",
  "pink",
  "purple",
  "cyan",
  "orange"
] as const;

export type GroupColor = (typeof GROUP_COLORS)[number];

/* Chrome truncates a long group title, so cap it here rather than let it decide.
   Split by code point: the mark is a surrogate pair, and slicing through it would
   leave half a character in the tab strip. */
const MAX_TITLE_CODE_POINTS = 60;

/* An emoji the agent typed at the start of a label. */
export function explicitMark(label: string | undefined): string | undefined {
  return label?.trim().match(LEADING_MARK)?.[1];
}

/* The caller may name the mark itself. Require exactly one emoji grapheme, so a
   mark cannot smuggle extra text into the title. */
export function normalizeMark(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const [first] = new Intl.Segmenter().segment(trimmed);
  if (!first || [...first.segment].length !== [...trimmed].length) return undefined;
  return /^\p{Extended_Pictographic}/u.test(first.segment) ? first.segment : undefined;
}

/* One mark per session. An explicit leading emoji wins, then the label and URL
   keywords, then a neutral fallback. */
export function sessionMark(input: { label?: string; url?: string }): string {
  const label = input.label?.trim();
  const explicit = explicitMark(label);
  if (explicit) return explicit;

  const haystack = `${label ?? ""} ${input.url ?? ""}`.toLowerCase();
  for (const [pattern, mark] of TOPIC_MARKS) {
    if (pattern.test(haystack)) return mark;
  }
  return DEFAULT_MARK;
}

/* The mark is already in the title, so a label that repeats it would show twice. */
export function withoutLeadingMark(label: string): string {
  return label.replace(LEADING_MARK, "").trimStart();
}

/* Every connector group title starts with an emoji mark. The sweep uses this to
   find connector groups when their tab records do not name the group yet. */
export function isConnectorGroupTitle(title: string | undefined): boolean {
  return !!title && !!explicitMark(title);
}

export function sessionGroupLabel(session: {
  label?: string;
  leaseHostId?: string;
  sessionId?: string;
  mark?: string;
}): string {
  const label = session.label?.trim();
  const mark = session.mark ?? sessionMark({ label });
  if (label) return clamp(`${mark} ${withoutLeadingMark(label)}`);

  /* No agent-supplied label yet, so the context is who is driving: the host id is
     the one thing here a person can read. The session id is deliberately not used
     — a slice of a UUID tells nobody anything, and a title nobody can read is
     worse than the same title twice. Two sessions from one host look alike until
     the agent names them. */
  const host = session.leaseHostId?.trim();
  if (host) return clamp(`${mark} ${host}`);
  return clamp(`${mark} Browser Connector`);
}

/* The color names the session, not the host: a person runs many sessions from one host,
   and identical groups in the tab strip make concurrent work indistinguishable. The
   session id is stable for the life of the MCP process, so a rename does not change it,
   and a host with no session to name falls back to its own color. */
export function groupColor(hostId: string | undefined, sessionId?: string): GroupColor {
  const session = sessionId?.trim();
  const seed = session ? `session:${session}` : hostId?.trim() ?? "";
  if (!seed) return "green";
  let hash = 0;
  for (const character of seed) {
    hash = (hash * 31 + (character.codePointAt(0) ?? 0)) >>> 0;
  }
  return GROUP_COLORS[hash % GROUP_COLORS.length]!;
}

function clamp(value: string): string {
  const characters = [...value];
  if (characters.length <= MAX_TITLE_CODE_POINTS) return value;
  return `${characters.slice(0, MAX_TITLE_CODE_POINTS - 1).join("")}…`;
}
