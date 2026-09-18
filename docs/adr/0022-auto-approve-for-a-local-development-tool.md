# Auto-approve, for a local development tool

Supersedes the approval requirements of ADR-0003, ADR-0005, ADR-0006, ADR-0010,
ADR-0011, ADR-0012 and ADR-0015, 2026-09-17.

Everything those decisions describe is still implemented — the host-policy
classification, the Site Grant, the Protected and Critical Action checks, the Control
Lease — but the extension no longer waits for a person to answer any of them.
`askApproval` resolves to approval, Chrome host permissions are declared statically so no
per-origin prompt is raised, and the Connector Panel is a status and audit view rather
than a consent surface.

That reverses both decisions deliberately, and it is a scope decision rather than a
security improvement. ADR-0011 refused a skip-all-approvals mode because Protected and
Critical Actions must receive explicit, consequence-specific approval. That reasoning
holds for a connector handed to someone who did not choose to run an agent against their
own browser. It does not describe this build: a local development tool that a developer
installs on purpose, points at a browser they own, and routes agent traffic through while
building. There the approvals were friction on every step of a build–test–debug loop, and
the person clicking them already owned both ends of it.

The consequence, plainly: any connected Agent Host can read and act on any site the
browser can reach, without a prompt, including wherever the user is signed in. The
classification code still runs and still labels every call, so a build that wants the
floor back changes one function and one manifest key.

## Consequences

- ADR-0003's "host approval never substitutes for a Session Grant" no longer binds,
  because no Session Grant is asked for. The Agent Host's own policy is the only gate.
- ADR-0011's invariant safety floor is not present. Restoring it means making
  `askApproval` wait for the Panel again and moving `host_permissions` back to
  `optional_host_permissions`.
- The Panel still records every call in its audit log. Nothing is hidden; it is simply
  not gated.
