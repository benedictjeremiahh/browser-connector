# Bound and page all browser observations

Every observation tool will return bounded, filterable results with explicit truncation and pagination metadata, reflecting Claude Code's warnings about browser-tool context and verbose console output. Text snapshots default to 64 KiB, `find` to 50 matches, console and network readers to the newest 100 records, and screenshots to the visible viewport unless a bounded full-page capture is explicitly requested.

## Consequences

Responses must include `truncated`, a continuation cursor, and original size when known. Large binary output is exposed as an MCP resource or artifact reference rather than embedded as base64 in model context, and Agent Hosts may lower but not exceed connector hard limits.
