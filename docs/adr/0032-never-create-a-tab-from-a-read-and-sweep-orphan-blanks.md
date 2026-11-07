# Never create a tab from a read, and sweep orphan blanks

`tabs_context` could create an `about:blank` tab when called with `createIfEmpty`. A blank tab is not a useful place to start work — the next step is a URL — and the tab it created was never recorded as an agent-created tab, so [ADR-0027](0027-close-released-agent-tabs-after-ten-minutes.md)'s ten-minute sweep could not close it. Agents that then asked for the page they wanted with `tabs_create` got a second tab, and the blank stayed in the group. Repeating that across prompts left a row of blank tabs and identical groups in the person's tab strip.

`tabs_context` is now strictly read-only. `tabs_create(url)` reuses a controlled background blank tab before it creates another, and a blank created by `tabs_create` is recorded like any other agent tab. Called without a URL, `tabs_create` reuses a controlled blank or opens one. A browser alarm also closes orphan `about:blank` and `chrome://newtab` tabs that sit in a connector group, that are recorded as agent-created, that no live session controls, that are not pinned, and that the person is not looking at. A one-time migration on install clears the unrecorded blanks an earlier build left behind; after it has run, the periodic sweep only ever closes a tab the connector knows it created.

## Consequences

An agent asked for a fresh tab must name the URL it wants; the connector no longer supplies a blank page as a default. A blank tab an earlier build left behind is closed on the next sweep. A person's own blank tab is never closed while they are looking at it, a pinned blank is left alone, and a blank tab outside a connector group is never touched. This revises ADR-0017's statement that ending a lease never closes tabs, for orphan blanks only.
