# Close released agent tabs after ten minutes

Revised by ADR-0031, 2026-11-07: a tab adopted from outside the session is never recorded, so this
ten-minute close never applies to it.

ADR-0017 kept every tab after its lease ended, and ADR-0025 let a later session with the same label take them back. In practice an orchestrator labels each piece of work differently, so nothing ever took them back: every session left its tabs behind, and a person running several agent checks a day ended up with a row of identical pages they had to close by hand.

Two changes, both limited to tabs the agent itself opened through `tabs_create`, which are the only tabs the extension records:

- A session that asks `tabs_create` for a URL takes a released tab of the same Agent Host that already shows that URL, instead of opening another copy. A tab a live session holds is never taken, and one host never takes another's.
- When a session ends, its agent tabs are marked released. Ten minutes later they are closed, unless a session took them again, the person is looking at the tab, or the person moved it out of the agent's group. A browser alarm sweeps once a minute, because the service worker may be asleep when the time comes.

## Consequences

Ten minutes is long enough to look at what an agent left on screen and short enough that a working day does not fill the tab strip. A person who wants to keep an agent's tab drags it out of the group. Tabs the person opened, or handed over through the panel, are never recorded and so never closed. The release records live in session storage, so tabs left from before an extension reload are not swept and stay until closed by hand.

This revises ADR-0017's rule that ending a lease never closes tabs, for agent-created tabs only.
