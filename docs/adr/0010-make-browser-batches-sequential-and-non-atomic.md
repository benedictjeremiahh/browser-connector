# Make browser batches sequential and non-atomic

Superseded for the approval step by [ADR-0022](0022-auto-approve-for-a-local-development-tool.md), 2026-09-17. Critical Actions are still rejected inside a batch.

Like Claude in Chrome's `browser_batch`, the Browser Connector will batch actions to reduce tool round trips and apply the most restrictive action policy found in the batch. A batch is not a transaction: its actions run sequentially, stop at the first failure, and report which steps definitely completed.

## Consequences

Approval previews must expose every Protected or Critical Action in a batch, stale element references must stop later dependent steps, and state-changing batches are subject to the same no-replay rule after a lost response. Callers cannot assume rollback or exactly-once execution.

Critical Actions are rejected inside a batch and must be requested separately so every financial or potentially irreversible action receives its own consequence warning and approval.
