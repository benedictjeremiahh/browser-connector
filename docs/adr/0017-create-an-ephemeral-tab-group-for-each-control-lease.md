# Create an ephemeral tab group for each Control Lease

Revised by ADR-0030, ADR-0031 and ADR-0032, 2026-11-07: the group color is per session,
`tabs_create` can adopt an already-open tab at the requested URL, and an orphan blank in a
connector group is swept.

At session startup the agent must fetch current tab context, then by default create new work tabs in a visible group associated with its Control Lease, following Claude Code's guidance to avoid reusing user tabs unless explicitly requested. Existing tabs become Controlled Tabs only through explicit user action, and the group is not saved across browser restarts.

## Consequences

Agent-created tabs automatically join the lease group. Ending or losing the lease removes connector authority but does not close tabs, preserving user work and making disconnect recovery non-destructive.

Revised by ADR-0027: tabs the agent itself opened are closed ten minutes after their session ends, unless taken again or kept by the person.
