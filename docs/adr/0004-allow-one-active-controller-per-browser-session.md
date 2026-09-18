# Allow one active controller per Browser Session

Only one Agent Host may hold a Control Lease for a Browser Session at a time. This makes the single-controller behavior and connection conflicts seen in Claude Code with Chrome explicit, preventing multiple installed hosts from racing over page state while still allowing parallel control of separate Browser Sessions.

## Consequences

The extension must identify the current controller and let the user revoke or hand off its lease. Competing hosts receive a busy response rather than partial or read-only access, and abandoned leases expire after disconnection or timeout.
