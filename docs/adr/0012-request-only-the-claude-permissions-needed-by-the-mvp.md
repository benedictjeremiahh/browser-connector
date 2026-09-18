# Request only the Claude permissions needed by the MVP

Superseded for host access by [ADR-0022](0022-auto-approve-for-a-local-development-tool.md), 2026-09-17: HTTP and HTTPS host permissions are declared statically rather than requested per origin. The permission list still stands.

The extension will use the subset of Claude in Chrome's permissions required for the connector MVP: `sidePanel`, `storage`, `scripting`, `debugger`, `tabs`, `tabGroups`, `webNavigation`, and `nativeMessaging`, with HTTP and HTTPS host access requested per origin when a Site Grant is created. Permissions for scheduling, direct downloads, notifications, display information, request rewriting, offscreen documents, and unlimited storage will be omitted until a concrete capability requires them.

## Consequences

Saved browser artifacts remain the Agent Host's filesystem responsibility. Any future manifest-permission expansion must name the enabling capability and document its user-visible risk before adoption.
