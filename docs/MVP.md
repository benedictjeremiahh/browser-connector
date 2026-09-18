# Browser Connector MVP

## Outcome

An Agent Host can use MCP tools to observe and operate explicitly controlled tabs in the user's visible, authenticated Chrome profile. The connector does not run an agent loop, select a model, own conversations, or require a cloud account.

Claude Code with Claude in Chrome is the behavioral baseline. Claude Code itself is not an installation target because it already has a first-party browser connector.

## Architecture

```text
Codex plugin / generic Agent Host
              ↕ MCP over STDIO
     on-demand MCP bridge(s)
              ↕ owner-only local socket
 Chrome-owned Native Broker
              ↕ Chrome native messaging
   Manifest V3 extension + side panel
              ↕ scripting and CDP
          Controlled Tabs
```

The MCP bridge and Native Broker are subcommands of one standalone binary. Chrome keeps the broker alive through its native-messaging port, while Agent Host processes may start, stop, or overlap without severing the browser connection. There is no login daemon, cloud relay, connector account, or direct dependency on an AI provider SDK.

## MCP v1 tools

- Context: `tabs_context`, `tabs_create`
- Navigation and input: `navigate`, `computer`, `form_input`, `resize_window`
- Observation: `read_page`, `get_page_text`, `find`, `read_console_messages`, `read_network_requests`
- Advanced: `javascript_tool`, `browser_batch`
- Files: `upload_file`, `download_file`

All observations are bounded and pageable. Page, console, and network output is Untrusted Browser Content. Element Page References are opaque and become stale when their tab or document generation changes.

## Permissions and safety

- Only paired hosts can request a Control Lease.
- Only one Agent Host controls a Browser Session at a time.
- Existing tabs require explicit user opt-in; agent-created tabs join an ephemeral visible tab group.
- Manual mode approves every browser mutation. Auto mode allows routine mutations covered by a Site Grant.
- Protected Actions always require approval. Critical Actions additionally show a consequence-specific warning and cannot be persistently approved.
- Financial and irreversible actions are possible only as Critical Actions; they are not silently blocked or silently executed.
- Critical Actions cannot be batched; each receives a consequence-specific, one-time approval.
- `javascript_tool` is always protected, displays its full source, and cannot be batched.
- Login, CAPTCHA, passkeys, biometrics, password-manager UI, browser permission dialogs, and privileged browser pages are User-only Steps.
- Cookies, authorization headers, password fields, request bodies, and raw credentials are never returned as tool data.
- Cross-origin writes require a source/destination/data-category preview.
- The MVP does not claim parity with Anthropic's proprietary prompt-injection classifiers.

## Local storage

- Site Grants, Host Pairings, settings, and Audit Events are local.
- Audit Events contain metadata only and expire after seven days.
- Screenshots and downloads are returned as explicit artifacts, not retained in the audit log.
- No telemetry is sent by the MVP.

## Acceptance scenario

1. Install the Codex plugin, Chrome extension, and local bridge.
2. Pair Codex and acquire a Control Lease.
3. Open a local web application in a new controlled tab.
4. Read its semantic page state and take a screenshot.
5. Fill and submit a form.
6. Inspect the resulting DOM, console errors, and failed network requests.
7. Let Codex modify source code using its normal coding tools.
8. Reload the browser and verify the fix.
9. Observe requests, approvals, and results in the Connector Panel.

## Explicitly deferred

- Claude Code adapter
- Remote or headless browsers
- Windows, Linux, WSL, and non-Chromium browsers
- Chat UI, conversation history, and model selection
- Scheduled tasks, shortcuts, GIF recording, and cloud sync
- A skip-all-approvals mode
- Request-body and binary-response inspection
