# Reuse a Controlled Tab before creating one

`tabs_create` searches this session's own Controlled Tabs for one already at the requested URL before it opens a new tab, and returns `reused: true` when it finds one. Matching ignores the URL fragment, because a fragment is a position inside a document rather than a different document. When no controlled tab matches and a new one is opened, the result also reports how many tabs outside the control boundary hold the same URL — as a count, never as an id, title, or URL.

Claude in Chrome, the behavioral baseline, always opens a new tab and asks the user to drag existing tabs into Claude's group. This deviates from that, and is recorded here because [ADR-0002](0002-use-claude-in-chrome-as-the-behavioral-baseline.md) requires a deliberate deviation to be justified rather than presented as parity. An agent that reopens the page it is already working on duplicates its own state, and a second controlled copy of one document makes every Page Reference, console record, and network record ambiguous by forcing the agent to remember which copy it meant.

The control boundary itself is unchanged. A tab outside this session's Controlled Tabs stays invisible: `tabs_context` reports no id, title, or URL for it. The count in `tabs_create` is not the tab, so it does not hand the agent a handle on anything the user did not hand over.

## Consequences

Reuse only ever reaches tabs this session already controls, so [ADR-0017](0017-create-an-ephemeral-tab-group-for-each-control-lease.md)'s opt-in rule stands unchanged. An agent that genuinely wants a second, independent copy of a page navigates a new tab to it explicitly, which is what it would have done before. The count is advisory: no tool acts on it, and no tool can address the tabs it counts.
