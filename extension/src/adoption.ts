import { isBlankTabUrl } from "./policy";

/* A tab the agent opened outlives the session that opened it (ADR-0017 never closes tabs), and a
   new session is a new MCP process with a new id. When that new session names itself with the
   same label from the same Agent Host, it is the same work resuming, so it takes back the tabs
   that work opened instead of opening a second copy beside them (ADR-0025). Only tabs the agent
   created are ever recorded, so a tab the person opened is never handed over this way. */

export interface AgentTabRecord {
  hostId: string;
  label?: string;
  /** When the session that held it ended; cleared when a session takes the tab again (ADR-0027). */
  releasedAt?: number;
  /** Where the tab was when it was released; the sweep closes it only while it is still there. */
  groupId?: number;
  windowId?: number;
}

/* An agent tab outlives its session for ten minutes, long enough for the person to look at what the
   agent left on screen or for the same work to resume, and is then closed (ADR-0027). */
export const RELEASED_TAB_TTL_MS = 10 * 60 * 1000;

export type AgentTabRecords = Record<string, AgentTabRecord>;

export function adoptableTabs(
  records: AgentTabRecords,
  owner: { hostId?: string; label?: string },
  liveControlled: ReadonlySet<number>,
  openTabs: ReadonlySet<number>
): number[] {
  if (!owner.hostId || !owner.label) return [];
  return Object.entries(records)
    .filter(([, record]) => record.hostId === owner.hostId && record.label === owner.label)
    .map(([tabId]) => Number(tabId))
    .filter((tabId) => openTabs.has(tabId) && !liveControlled.has(tabId));
}

/* A new session asking for a URL takes a released agent tab of the same Agent Host that already shows
   it, instead of opening another copy beside it. Tabs a live session holds are never taken. */
export function reusableReleasedTab(
  records: AgentTabRecords,
  hostId: string | undefined,
  liveControlled: ReadonlySet<number>,
  openTabs: ReadonlyArray<{ id: number; url?: string; pinned?: boolean; incognito?: boolean }>,
  matches: (tabUrl: string) => boolean
): number | undefined {
  if (!hostId) return undefined;
  return openTabs.find((tab) => {
    const record = records[tab.id];
    return record?.hostId === hostId && !liveControlled.has(tab.id) && !tab.pinned && !tab.incognito && !!tab.url && matches(tab.url);
  })?.id;
}

/* A tab the connector has never recorded is the person's, not an agent's. When an agent asks for
   a URL one of those tabs already shows, taking that tab into the session is better than opening a
   duplicate beside it (ADR-0031). The tab must be unpinned, in the session's window when the
   session already works in one, and not held by another live session or recorded to another host.
   Ranking prefers the active tab of the focused window, then the most recently used tab. */
export interface OpenTab {
  id?: number;
  url?: string;
  windowId?: number;
  active?: boolean;
  pinned?: boolean;
  incognito?: boolean;
  lastAccessed?: number;
}

export function adoptableOpenTab(
  tabs: ReadonlyArray<OpenTab>,
  options: {
    records: AgentTabRecords;
    liveControlled: ReadonlySet<number>;
    sessionControlled: ReadonlySet<number>;
    windowIds?: ReadonlySet<number>;
    focusedWindowId?: number;
    matches: (url: string) => boolean;
  }
): number | undefined {
  const candidates = tabs.filter((tab): tab is OpenTab & { id: number } =>
    typeof tab.id === "number"
    && Number.isInteger(tab.id)
    && tab.url !== undefined
    && options.matches(tab.url)
    && !tab.pinned
    && !tab.incognito
    && !options.liveControlled.has(tab.id)
    && !options.sessionControlled.has(tab.id)
    && options.records[tab.id] === undefined
    && (!options.windowIds || options.windowIds.size === 0 || (tab.windowId !== undefined && options.windowIds.has(tab.windowId)))
  );
  const rank = (tab: OpenTab): number =>
    tab.windowId === options.focusedWindowId && tab.active === true ? 1 : 0;
  return candidates
    .slice()
    .sort((left, right) =>
      rank(right) - rank(left)
      || (right.lastAccessed ?? 0) - (left.lastAccessed ?? 0)
      || left.id - right.id)
    [0]?.id;
}

/* Only a tab the agent itself opened is recorded, so ADR-0027's sweep can close it later. An
   adopted tab belongs to the person and must never enter that record. */
export function shouldRecordAgentTab(result: unknown): result is { tabId: number; reused: false } {
  return typeof result === "object" && result !== null
    && (result as { reused?: unknown }).reused === false
    && typeof (result as { tabId?: unknown }).tabId === "number";
}

/* Blank tabs sitting in a connector-owned group, that no live session holds, that the person is not
   looking at, and that are not pinned. The sweep closes these without touching any other tab. */
export interface SweepTab {
  id?: number;
  url?: string;
  pendingUrl?: string;
  pinned?: boolean;
  incognito?: boolean;
  active?: boolean;
  windowId?: number;
  groupTitle?: string;
}

export function orphanBlankTabsToClose(
  tabs: ReadonlyArray<SweepTab>,
  options: {
    liveControlled: ReadonlySet<number>;
    focusedWindowIds: ReadonlySet<number>;
    /* Omitted when the caller already selected the connector groups by id. */
    connectorTitlePrefix?: string;
    /* Omitted only by the one-time migration for blanks an older build did not record. */
    agentCreated?: ReadonlySet<number>;
  }
): number[] {
  return tabs.filter((tab): tab is SweepTab & { id: number } =>
    typeof tab.id === "number"
    && (options.agentCreated === undefined || options.agentCreated.has(tab.id))
    && (options.connectorTitlePrefix === undefined || (tab.groupTitle ?? "").startsWith(options.connectorTitlePrefix))
    && !tab.pinned
    && !tab.incognito
    && !options.liveControlled.has(tab.id)
    && !(tab.active === true && tab.windowId !== undefined && options.focusedWindowIds.has(tab.windowId))
    && isBlankTabUrl(tab.url, tab.pendingUrl)
  ).map((tab) => tab.id);
}

/* Released agent tabs past their time. A tab the person is looking at, has moved out of the
   agent's group, pinned, or is playing audio is theirs now and is left alone. The released record
   carries the group the tab was in, so moving it out is enough to keep it. */
export interface ReleasedTabView {
  id: number;
  groupId?: number;
  active?: boolean;
  pinned?: boolean;
  audible?: boolean;
  incognito?: boolean;
}

export function releasedTabsToClose(
  records: AgentTabRecords,
  now: number,
  liveControlled: ReadonlySet<number>,
  openTabs: ReadonlyArray<ReleasedTabView>
): number[] {
  return openTabs
    .filter((tab) => {
      const record = records[tab.id];
      return record?.releasedAt !== undefined
        && now - record.releasedAt >= RELEASED_TAB_TTL_MS
        && !liveControlled.has(tab.id)
        && !tab.active
        && !tab.pinned
        && !tab.audible
        && !tab.incognito
        && record.groupId !== undefined
        && tab.groupId === record.groupId;
    })
    .map((tab) => tab.id);
}
