# Reconnect without replaying state-changing actions

The bridge and extension will reconnect automatically after the Manifest V3 service worker or native connection goes idle, improving on the manual reconnect path documented for Claude Code with Chrome. Read-only requests may be retried, but a state-changing request whose response was lost will return `outcome_unknown` and must never be replayed automatically because the original action may already have succeeded.

## Consequences

Agent Host guidance must require re-reading browser state after `outcome_unknown`. A Control Lease may resume only when the paired host and session identity still match, while blocking JavaScript dialogs pause execution for explicit user intervention.
