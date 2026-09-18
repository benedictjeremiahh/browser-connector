# Browser Connector

<img src="extension/public/icons/128.png" alt="" width="72" height="72" align="right">

A local bridge that lets an external AI agent drive a browser you are already signed
into. It is a Manifest V3 Chrome extension plus a Rust MCP server that speaks STDIO, so
any agent host that can launch a local MCP server can use it — Codex, Claude, or your own.
Nothing leaves the machine and no account exists.

**This is a development tool, and it auto-approves.** Any connected agent host can read
and act on any site the browser can reach, without a prompt, including wherever you are
signed in. That is the point — it removes the approval friction from a build–test–debug
loop — but it is a real posture, not a no-op, and it is recorded in
[ADR-0022](docs/adr/0022-auto-approve-for-a-local-development-tool.md), which supersedes
the stricter decisions this project started with (ADR-0003, ADR-0011). The Connector Panel
still records every call in an audit log; it is a status view, not a consent surface.

## How it works

```
agent host ──STDIO──▶ browser-connector mcp ──unix socket──▶ native broker ──▶ extension ──▶ Chrome
```

- **`browser-connector`** (Rust) is the MCP server. `mcp` runs it over STDIO; `install`
  writes Chrome's native-messaging manifest; `status` reports local pairing state.
- The **native broker** is held open by Chrome through native messaging, so the browser
  stays connected while agent-host processes come and go.
- The **extension** owns site access, the Control Lease, and the controlled-tab boundary.
  It performs actions through the Chrome DevTools Protocol and `chrome.scripting`.

## Install

macOS and Google Chrome. Requires Rust and Node to build from source.

```sh
./scripts/install-local.sh
```

That builds `browser-connector` into `~/.local/bin`, builds the unpacked extension into
`extension/dist`, and prints the two manual steps: load `extension/dist` from
`chrome://extensions` with Developer mode on, then register native messaging.

```sh
~/.local/bin/browser-connector install --extension-id <id> --host-id <your-host-id>
```

Restart Chrome afterwards, then add the MCP server to your agent host:

```json
{
  "mcpServers": {
    "browser-connector": {
      "command": "browser-connector",
      "args": ["mcp", "--host-id", "my-agent-host"]
    }
  }
}
```

Use a stable, readable `host-id`; the Connector Panel shows it. `--host-id opencode`,
`--host-id codex`, and `--host-id generic-mcp` are all just names for the same server, and
each keeps its own local config.

See [docs/INSTALL.md](docs/INSTALL.md) for the Codex plugin route and troubleshooting.

## Tools

All tools return JSON. Page References (`read_page`, `find`) are opaque, document-scoped
handles that go stale when the tab or document changes; call `tabs_context` first in every
session.

| Tool | What it does |
| --- | --- |
| `tabs_context` | Controlled tabs. Call this first. |
| `tabs_create` | Open a tab inside the Control Lease's tab group. |
| `tabs_close` | Close a controlled tab. |
| `navigate` | Go to a URL, back, forward, or reload. |
| `read_page` / `get_page_text` | Accessibility snapshot with refs / bounded visible text. |
| `find` | Elements by visible text or semantics, as refs. |
| `form_input` | Set a form control's value. Password fields are never read back. |
| `javascript_tool` | Run JavaScript in the page, shown in full for approval. |
| `read_console_messages` / `read_network_requests` | Bounded, filterable console and network records. |
| `computer` | Visible mouse, keyboard, scroll, wait, and **screenshot**. |
| `upload_file` / `download_file` | Host-provided bytes to a file input / a file through a tab. |
| `browser_batch` | Sequential, non-atomic, fail-fast batch of the above. JavaScript is excluded. |
| `resize_window` | Resize the window holding a controlled tab. |

Two behaviours worth knowing:

- **Screenshots come back as images.** `computer` with `action: "screenshot"` returns an
  MCP image content block, so a client renders the pixels rather than a link to them.
- **The cursor is visible.** Pointer actions draw a shadow-DOM overlay at the exact point
  — an arrow, and a ring that pings on click — so you can see where the agent is acting,
  and it appears in a screenshot taken after the action.

## Repository layout

- `crates/browser-connector` — the Rust MCP server, native host, and relay
- `extension` — the Manifest V3 extension and side panel
- `plugins/browser-connector` — a Codex plugin bundle
- `docs/MVP.md` — product boundary and acceptance scenario
- `docs/adr` — architecture decisions

## Development

```sh
source "$HOME/.cargo/env"
cargo test --workspace

cd extension
npm install
npm test
npm run build
```

## Licence

Apache-2.0. See [LICENSE](LICENSE).
