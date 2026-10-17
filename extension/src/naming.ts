/* Presentation of an Agent Host session in the browser's tab strip.
   Pure functions only: the tab group title is the one place a person sees which
   session is which, so it is worth testing without a browser. */

/* Chrome's tab groups have a title and a color and no icon slot, so the only way
   to put a mark on one is a character in the title. */
export const GROUP_MARK = "🔌";

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

export function sessionGroupLabel(session: {
  label?: string;
  leaseHostId?: string;
  sessionId?: string;
}): string {
  const label = session.label?.trim();
  if (label) return clamp(`${GROUP_MARK} ${label}`);

  /* No agent-supplied label yet, so the context is who is driving: the host id is
     the one thing here a person can read. The session id is deliberately not used
     — a slice of a UUID tells nobody anything, and a title nobody can read is
     worse than the same title twice. Two sessions from one host look alike until
     the agent names them. */
  const host = session.leaseHostId?.trim();
  if (host) return clamp(`${GROUP_MARK} ${host}`);
  return clamp(`${GROUP_MARK} Browser Connector`);
}

/* Same host, same color, every time and across restarts — a person learns the
   color once and then reads the tab strip instead of the titles. */
export function groupColor(hostId: string | undefined): GroupColor {
  const host = hostId?.trim();
  if (!host) return "green";
  let hash = 0;
  for (const character of host) {
    hash = (hash * 31 + (character.codePointAt(0) ?? 0)) >>> 0;
  }
  return GROUP_COLORS[hash % GROUP_COLORS.length]!;
}

function clamp(value: string): string {
  const characters = [...value];
  if (characters.length <= MAX_TITLE_CODE_POINTS) return value;
  return `${characters.slice(0, MAX_TITLE_CODE_POINTS - 1).join("")}…`;
}
