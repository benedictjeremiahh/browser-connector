# Give each Agent Host session its own tab-group color

Every Control Lease already gets an ephemeral tab group ([ADR-0017](0017-create-an-ephemeral-tab-group-for-each-control-lease.md)), and the title carries the agent's label or, before it names one, the host id. The color was derived from the host id so a person would learn one host's color once. In practice a person runs many sessions from one host — several Codex or cc-go tasks a day — and every group appeared with the same `🔌` title and the same color. With the work happening in background tabs ([ADR-0024](0024-operate-controlled-tabs-in-the-background-and-mark-them.md)), the tab strip is the only place control is visible, so an identical mark makes concurrent work indistinguishable exactly where it must be legible.

A group's color is now a stable hash of the session id, not the host id. The title is the agent's `label_session` value when it gives one; otherwise the default label the MCP relay supplies (`BROWSER_CONNECTOR_SESSION_LABEL`, or the basename of its working directory), and finally the host id. The `🔌` mark stays because Chrome tab groups have a title and a color but no icon slot.

## Consequences

The same session keeps one color across renames; a new MCP process usually gets a new one, which is the point. Chrome offers nine colors, so two live sessions can collide; the title and the label remain the stronger identifier. A session that adopts an earlier session's tabs ([ADR-0025](0025-resume-a-labelled-sessions-tabs-in-a-new-session.md)) takes the new session's color, because color names the session, not the work. The host is no longer encoded in the color; the default title carries it when no workspace name is available.

A workspace default label also names the group before the agent has said anything, so an invocation in the same workspace reuses the same label and can adopt the tabs a released session left behind. Two different pieces of work in one workspace should call `label_session` with distinct labels rather than rely on the workspace name.
