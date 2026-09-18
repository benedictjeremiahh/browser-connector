# Do not offer a skip-all-approvals mode

Superseded by [ADR-0022](0022-auto-approve-for-a-local-development-tool.md), 2026-09-17.

The Connector Panel will offer Manual and Auto Permission Modes but not Claude in Chrome's Skip all approvals mode. Removing all checks would conflict with the requirement that Protected and Critical Actions always receive explicit, consequence-specific approval, so this connector deliberately favors an invariant safety floor over complete permission-mode parity.
