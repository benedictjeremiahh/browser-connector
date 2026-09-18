# Let Chrome own the Native Broker lifetime

The Native Broker will bind one owner-restricted local socket and remain alive for the lifetime of Chrome's native-messaging port. On-demand MCP bridges connect to that stable broker as clients. The broker multiplexes overlapping Agent Host processes and rewrites transport request IDs so process restarts and colliding per-client IDs cannot detach or confuse the browser channel.

This matches the user-visible continuity expected from Claude in Chrome: opening a new Claude Code session does not require manually reconnecting the extension. It corrects ADR 0013's original ownership direction, where Chrome's helper attached to one temporary MCP session and exited or became stranded when that session changed.

## Consequences

Chrome, rather than an Agent Host, owns connection continuity. The broker is not an agent daemon and grants no browser authority: Host Pairing, Site Grants, approvals, and the exclusive Control Lease remain in the extension. Multiple MCP transports may be connected, but only the host and session holding the Control Lease can operate the Browser Session.
