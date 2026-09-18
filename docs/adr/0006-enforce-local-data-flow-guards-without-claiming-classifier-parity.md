# Enforce local data-flow guards without claiming classifier parity

Superseded for the pre-cross-origin approval step by [ADR-0022](0022-auto-approve-for-a-local-development-tool.md), 2026-09-17. The data-flow screening, the no-credential rule, and the prompt-injection disclosure still stand.

All page, console, and network output will be treated as Untrusted Browser Content, and the Browser Connector will structurally screen requested data flows before execution. Unlike Claude in Chrome, the accountless local MVP cannot rely on Anthropic's proprietary content and action classifiers, so it will not claim equivalent prompt-injection detection; it will instead prevent browser content from granting permissions, never expose credentials, and require explicit approval before data crosses into a new origin.

## Consequences

Cross-origin writes must identify the source, destination, and data category in an approval preview. Provider-specific or local classifiers may add protection but cannot weaken the connector's deterministic policy, and product documentation must disclose the remaining prompt-injection risk.
