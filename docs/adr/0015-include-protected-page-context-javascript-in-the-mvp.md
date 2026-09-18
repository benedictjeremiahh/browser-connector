# Include protected page-context JavaScript in the MVP

Superseded for the approval step by [ADR-0022](0022-auto-approve-for-a-local-development-tool.md), 2026-09-17. javascript_tool is still a Protected Action and still cannot be placed in a batch.

The MVP will include a `javascript_tool`, matching an observed Claude in Chrome capability needed for advanced browser debugging. Because arbitrary page-context code can read or mutate application data and its effects cannot be reliably classified, every invocation is a Protected Action even in Auto mode and requires approval showing the complete source, target origin, and risk warning.

## Consequences

JavaScript executes without extension or native-bridge APIs, returns size-limited Untrusted Browser Content, and cannot be placed inside `browser_batch`. The connector must disclose that it cannot reliably identify Critical behavior hidden in arbitrary code; users must judge the displayed source before approval.
