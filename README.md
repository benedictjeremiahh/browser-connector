# Browser Connector

<img src="extension/public/icons/128.png" alt="" width="72" height="72" align="right">

A local bridge that lets an external AI agent drive a browser you are already signed
into. It is a Manifest V3 Chrome extension plus a Rust MCP server that speaks STDIO, so
any agent host that can launch a local MCP server can use it — Codex, Claude, or your own.
Nothing leaves the machine and no account exists.

**This is a development tool, and it asks only where it matters.** Pages served from this
machine (`localhost`, `127.0.0.1`, `[::1]`, `*.localhost`, `*.test`) need no approval. Any other
site waits for you in the Connector Panel, once, for the session, or always, and every
`javascript_tool`, `upload_file` and `download_file` call is approved on its own.
[ADR-0029](docs/adr/0029-ask-before-unlisted-sites-scripts-and-file-transfer.md) records this
floor, which narrows the auto-approve posture of
[ADR-0022](docs/adr/0022-auto-approve-for-a-local-development-tool.md). The panel records every
call in an audit log.

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
| `tabs_context` | Read-only list of this session's Controlled Tabs (id, window, title, URL, active). Call it first; it never opens a tab. |
| `tabs_create` | Get a tab for a URL in this session's group: reuse a Controlled Tab at that URL, else a Controlled background blank tab, else a released tab this Agent Host opened earlier, else adopt an already-open tab at that URL (including one the person opened), else create a background tab. Call it once per URL. |
| `tabs_activate` | Bring a controlled tab to the front. |
| `tabs_close` | Close a controlled tab. |
| `label_session` | Replace this session's automatic tab-group label with a better description of the work. |
| `navigate` | Go to a URL, back, forward, or reload. |
| `read_page` / `get_page_text` | Accessibility snapshot with refs / bounded visible text. Both can scope to one element's subtree. `read_page` returns a `snapshotId`; pass it back as `diffFrom` to get only what was added, removed or changed. |
| `find` | Elements by visible text or semantics, as refs. |
| `assert` | Check several expectations in one call (text shown or gone, URL, title, an element's state or value, a count) and get pass or fail for each, without a screenshot. |
| `form_input` | Set a form control's value. Password fields are never read back. |
| `javascript_tool` | Run JavaScript in the page. Each call waits for approval in the Connector Panel, which shows its full source; an Agent Host may apply its own policy gate too. |
| `read_console_messages` / `read_network_requests` | Bounded, filterable console and network records. |
| `computer` | Visible mouse, keyboard, scroll, drag, wait, and **screenshot**, with a zoom crop. |
| `upload_file` / `download_file` | Send host-provided bytes to a file input / fetch bounded response bytes through a tab. Each call waits for approval in the Connector Panel. |
| `browser_batch` | Sequential, non-atomic, fail-fast batch of the above. JavaScript is excluded. |
| `resize_window` | Emulate a viewport size (mobile, tablet, desktop, or explicit width and height) in this session's tabs; the person's window is never resized. |

A few behaviours worth knowing:

- **Open shadow roots and same-origin iframes are part of the page.** `read_page`, `find`,
  `assert`, and Page References for `computer` and `form_input` see into them, to a bounded
  depth, and clicks inside a frame are translated to the top-level viewport. A cross-origin
  frame or a closed shadow root appears as a node marked `opaque` that says it was not
  inspected; it is never an error.
- **Verify with `assert` or `diffFrom`, not a screenshot.** One `assert` call checks several
  expectations and says which failed and what was observed; values of password and other
  sensitive fields are never compared or echoed. After an action, `read_page` with the
  previous `snapshotId` as `diffFrom` returns just the change. Snapshots live in the
  extension's memory only (the last few per tab) and an unknown one returns the full tree.

- **Screenshots come back as images.** `computer` with `action: "screenshot"` returns an
  MCP image content block, so a client renders the pixels rather than a link to them.
  `zoom` crops to a region given in CSS pixels, and the image that comes back is that
  region at the display's device pixel ratio, so it is larger than the numbers you passed.
- **The cursor is visible.** Pointer and keyboard actions draw a shadow-DOM overlay at the
  exact point — an arrow that glides in, a trail, a click ripple, and a label naming the
  action — so you can see where the agent is acting and what it is doing, and it appears in
  a screenshot taken after the action. `prefers-reduced-motion` turns the animation off and
  leaves a static mark.
- **`key` modifiers reach the page, and the macOS editing shortcuts are executed as
  commands.** `{ key: "ArrowLeft", modifiers: "shift" }` selects through the renderer like a
  real keystroke. Cmd+A/C/V/X/Z do not: macOS resolves those in its menu bar, which a
  synthetic event never passes through, so the connector sends the corresponding editor
  command alongside the event.

Chrome gives a tab group a title and a color, not an icon, so every group title starts with
the same `🔌` mark. The rest is the session label: `BROWSER_CONNECTOR_SESSION_LABEL` when
the Agent Host sets it, otherwise the MCP server's working-directory basename, otherwise
the host id — never an opaque id. Each session gets its own color from Chrome's nine-color
palette, so concurrent sessions are distinguishable before you read their titles; two
sessions can still land on the same color, and the title remains the stronger identifier.

- **`tabs_create` reuses before it opens.** For a URL it takes, in order: a Controlled Tab
  already at that URL, a Controlled background blank tab, a released tab this Agent Host
  opened earlier, an already-open tab at that URL (including one the person opened, which
  moves into the session's group), and only then creates a background tab. Call it once per
  URL and use the returned `tabId`; do not keep opening blank tabs between navigations. An
  adopted tab from outside the session was not created by the agent, so it is not closed
  unless the person asks. See
  [ADR-0031](docs/adr/0031-adopt-an-open-tab-instead-of-opening-a-duplicate.md) and
  [ADR-0032](docs/adr/0032-never-create-a-tab-from-a-read-and-sweep-orphan-blanks.md).

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
