# Require both host and extension authorization

Superseded by [ADR-0022](0022-auto-approve-for-a-local-development-tool.md), 2026-09-17.

A browser action will run only when both the Agent Host's tool policy and the Browser Connector's own permission policy allow it. This follows Claude Code with Chrome, where host modes classify read-only versus state-changing tool calls while site permissions remain owned by the extension; accepting occasional duplicate prompts is preferable to bypassing either security boundary.

## Consequences

MCP tools must accurately declare read-only and state-changing behavior so each Agent Host can apply its own policy. Host approval never substitutes for a Session Grant or Protected Action approval, and extension approval never overrides a host denial.
