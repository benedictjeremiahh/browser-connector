/* A tab the agent opened outlives the session that opened it (ADR-0017 never closes tabs), and a
   new session is a new MCP process with a new id. When that new session names itself with the
   same label from the same Agent Host, it is the same work resuming, so it takes back the tabs
   that work opened instead of opening a second copy beside them (ADR-0025). Only tabs the agent
   created are ever recorded, so a tab the person opened is never handed over this way. */

export interface AgentTabRecord {
  hostId: string;
  label?: string;
}

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
