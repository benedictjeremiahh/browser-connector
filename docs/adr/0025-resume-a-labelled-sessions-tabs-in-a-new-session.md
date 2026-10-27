# Resume a labelled session's tabs in a new session

Every MCP process is a new session with a new id, so an agent that stops and starts again (a paused task, a crashed runner, a new conversation on the same work) lost its group and opened a second copy of the page it was already working on, beside the first. The tabs were still open, because ending a lease never closes them (ADR-0017), but nothing connected them to the session that came next.

When a session names itself with `label_session`, the extension now hands it the tabs that an earlier session from the same Agent Host opened under the same label, provided no live session still controls them. The session continues in the group those tabs already live in, and `tabs_create` reuses them under ADR-0023. The label is the agent's statement that this is the same work; the host id keeps one agent from claiming another's tabs.

Only tabs the agent itself opened through `tabs_create` are recorded for adoption. A tab the person opened, or handed over through the panel, is never adopted this way, so ADR-0017's opt-in rule for the person's own tabs stands. The record lives in session storage and disappears with the browser session, as the tab groups themselves do.

## Consequences

An agent that wants its earlier tabs back must label its session with the same, stable name, before it opens new ones. Two different pieces of work under one label from one host will share tabs; callers that run several such pieces of work, such as an orchestrator running tasks, put a work identifier into the label. A host that never labels its sessions behaves exactly as before.
