# Create an ephemeral tab group for each Control Lease

At session startup the agent must fetch current tab context, then by default create new work tabs in a visible group associated with its Control Lease, following Claude Code's guidance to avoid reusing user tabs unless explicitly requested. Existing tabs become Controlled Tabs only through explicit user action, and the group is not saved across browser restarts.

## Consequences

Agent-created tabs automatically join the lease group. Ending or losing the lease removes connector authority but does not close tabs, preserving user work and making disconnect recovery non-destructive.
