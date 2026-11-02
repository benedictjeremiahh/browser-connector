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
  openTabs: ReadonlyArray<{ id: number; url?: string }>,
  matches: (tabUrl: string) => boolean
): number | undefined {
  if (!hostId) return undefined;
  return openTabs.find((tab) => {
    const record = records[tab.id];
    return record?.hostId === hostId && !liveControlled.has(tab.id) && !!tab.url && matches(tab.url);
  })?.id;
}

/* Released agent tabs past their time. A tab the person is looking at, or has moved out of the
   agent's group, is theirs now and is left alone. */
export function releasedTabsToClose(
  records: AgentTabRecords,
  now: number,
  liveControlled: ReadonlySet<number>,
  openTabs: ReadonlyArray<{ id: number; grouped: boolean; inView: boolean }>
): number[] {
  return openTabs
    .filter((tab) => {
      const releasedAt = records[tab.id]?.releasedAt;
      return releasedAt !== undefined && now - releasedAt >= RELEASED_TAB_TTL_MS && !liveControlled.has(tab.id) && tab.grouped && !tab.inView;
    })
    .map((tab) => tab.id);
}
