# Ask before unlisted sites, scripts and file transfer

Narrows ADR-0022, 2026-11-02.

ADR-0022 let any connected Agent Host read and act on any site without a prompt. That was
reasonable while every page an agent touched was the developer's own, but the browser it drives is
the person's everyday browser, signed in to mail, banking and work accounts, and an agent reads
untrusted pages all day. One instruction planted in a page could send it to any of those sessions,
and nothing would stop it. The friction ADR-0022 removed lives almost entirely on local development
pages, so the floor goes back everywhere else.

- **Local development origins need no Site Grant.** `localhost`, `127.0.0.1`, `[::1]`, and names
  ending in `.localhost` or `.test` are allowed without asking.
- **Every other origin waits for the Connector Panel.** The person allows it once, for the session,
  or always; "always" puts it on the Allowed sites list, where it can be removed.
- **`javascript_tool`, `upload_file` and `download_file` are approved per call, on every origin,**
  including inside a batch. These run code in a page or move a file across the browser boundary.
- **Protected and Critical classifications stay recorded, not gated.** A click on a submit button
  on a local page still runs without a prompt.
- **Host Pairing stays automatic.** A paired host reaches nothing until an origin above lets it.
- An unanswered approval returns an `approval_timeout` error after 50 seconds, below the relay's
  60 second request timeout, so the agent sees a definite failure rather than an unknown outcome.
  The toolbar badge counts what waits.

## Consequences

- The auto-approve build persisted an "always" grant for every origin it touched. Those grants
  record where agents went, not what a person allowed, so this build clears them once on install.
- Chrome host permissions stay declared statically; the gate is the extension's own, not Chrome's.
- An agent working on a hosted staging site gets one prompt per session, or none after "always".
