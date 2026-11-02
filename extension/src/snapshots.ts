/* read_page keeps the last few snapshots of each tab, in the service worker's memory only, so a
   later read can return what changed instead of the whole tree. They are dropped with the tab and
   with the session; an unknown id simply makes the read return the full tree. */

export type PageNode = Record<string, unknown> & { ref: string };

export interface Snapshot {
  id: string;
  generation: number;
  /* The read parameters that shape the node list; a diff is only meaningful between equal keys. */
  key: string;
  /* False when the read was cut off, so a node missing from it may simply have been beyond the cut. */
  complete: boolean;
  nodes: PageNode[];
}

const SNAPSHOTS_PER_TAB = 4;

export class SnapshotStore {
  private readonly byTab = new Map<number, Snapshot[]>();
  private counter = 0;
  /* Ids from a previous service worker lifetime must not match a new snapshot by accident. */
  private readonly epoch = Math.random().toString(36).slice(2, 6);

  record(tabId: number, snapshot: Omit<Snapshot, "id">): string {
    const id = `s${this.epoch}-${++this.counter}`;
    const kept = [...(this.byTab.get(tabId) ?? []), { ...snapshot, id }].slice(-SNAPSHOTS_PER_TAB);
    this.byTab.set(tabId, kept);
    return id;
  }

  find(tabId: number, id: string): Snapshot | undefined {
    return this.byTab.get(tabId)?.find(snapshot => snapshot.id === id);
  }

  clear(tabId: number): void {
    this.byTab.delete(tabId);
  }
}

export interface FieldChange { from: unknown; to: unknown }

export interface NodeDiff {
  added: PageNode[];
  removed: Array<{ ref: string; role?: unknown; name?: unknown }>;
  changed: Array<{ ref: string; role?: unknown; name?: unknown; previousRef?: string; changes: Record<string, FieldChange> }>;
  summary: { added: number; removed: number; changed: number; rerendered: number; unchanged: number };
}

const clip = (value: unknown): unknown => typeof value === "string" && value.length > 120 ? `${value.slice(0, 120)}...` : value;

function fieldChanges(before: PageNode, after: PageNode): Record<string, FieldChange> {
  const changes: Record<string, FieldChange> = {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (key === "ref") continue;
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) changes[key] = { from: clip(before[key]), to: clip(after[key]) };
  }
  return changes;
}

/* What a person would call "the same thing" after a re-render gave it a new element. */
const identity = (node: PageNode) => JSON.stringify([node.role, node.name, node.href, node.level]);

/* Nodes are matched by ref, which is stable for an element. A framework that re-creates elements
   gives them new refs, so leftover nodes are paired by role, name and link target before they are
   called removed and added; a re-created node that looks the same counts as rerendered, not as news. */
export function diffNodes(before: PageNode[], after: PageNode[]): NodeDiff {
  const previous = new Map(before.map(node => [node.ref, node] as const));
  const matched = new Set<string>();
  const diff: NodeDiff = { added: [], removed: [], changed: [], summary: { added: 0, removed: 0, changed: 0, rerendered: 0, unchanged: 0 } };
  const unmatchedAfter: PageNode[] = [];
  for (const node of after) {
    const old = previous.get(node.ref);
    if (!old) { unmatchedAfter.push(node); continue; }
    matched.add(node.ref);
    const changes = fieldChanges(old, node);
    if (Object.keys(changes).length) diff.changed.push({ ref: node.ref, role: node.role, name: node.name, changes });
    else diff.summary.unchanged += 1;
  }
  const leftover = before.filter(node => !matched.has(node.ref));
  const byIdentity = new Map<string, PageNode[]>();
  for (const node of leftover) byIdentity.set(identity(node), [...(byIdentity.get(identity(node)) ?? []), node]);
  const paired = new Set<string>();
  for (const node of unmatchedAfter) {
    const candidate = byIdentity.get(identity(node))?.shift();
    if (!candidate) { diff.added.push(node); continue; }
    paired.add(candidate.ref);
    const changes = fieldChanges(candidate, node);
    if (Object.keys(changes).length) diff.changed.push({ ref: node.ref, previousRef: candidate.ref, role: node.role, name: node.name, changes });
    else diff.summary.rerendered += 1;
  }
  for (const node of leftover) if (!paired.has(node.ref)) diff.removed.push({ ref: node.ref, role: node.role, name: node.name });
  diff.summary.added = diff.added.length;
  diff.summary.removed = diff.removed.length;
  diff.summary.changed = diff.changed.length;
  return diff;
}
