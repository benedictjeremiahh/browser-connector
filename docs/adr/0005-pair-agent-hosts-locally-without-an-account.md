# Pair Agent Hosts locally without an account

Superseded for the user-approval step by [ADR-0022](0022-auto-approve-for-a-local-development-tool.md), 2026-09-17. Pairing still exchanges and stores the local secret; it is established without a prompt. The rest still stands.

The Browser Connector will use explicit local Host Pairing and will not require its own cloud account or backend for the MVP. Unlike Claude in Chrome's first-party account requirement, this keeps the connector independent of model-provider identity while ensuring that discovery alone does not grant access to the browser.

## Consequences

The native bridge and extension must establish and store a local secret after user approval, authenticate subsequent sessions, and support revocation. Browser traffic, telemetry, and pairing data will not pass through a connector-operated cloud service; data leaves the browser only in responses to the paired Agent Host holding the Control Lease.
