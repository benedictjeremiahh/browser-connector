# Install Browser Connector

The MVP supports macOS and Google Chrome. It is local-only and does not require a
connector account.

There are two parts: the Chrome extension, and a companion program that provides the MCP
server and Chrome's native-messaging host. The Web Store cannot install or run the
companion; install it with one of the commands below.

## 1. Install the extension

From the Chrome Web Store, install **Browser Connector**.

For development, build and load the unpacked extension:

```sh
(cd extension && npm install && npm run build)
```

Open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select
`extension/dist`. The development id is `kppdjhnonomijdjifhobgeaipejojbho`; the Store
assigns a different id.

## 2. Install the companion

### npm (no Rust; Node 18 or newer)

```sh
npx @ceebee/browser-connector install
```

The installer copies the binary to `~/.local/bin/browser-connector`, registers the
published Store extension id, and writes Chrome's native-messaging manifest. It never
points Chrome at the npx cache.

Use `--install-dir <dir>` to choose another stable directory, or `--extension-id <id>` to
add the development id alongside the Store id.

### Homebrew (no Node)

```sh
brew tap benedictjeremiahh/browser-connector https://github.com/benedictjeremiahh/browser-connector
brew install benedictjeremiahh/browser-connector/browser-connector
browser-connector install --executable "$(brew --prefix)/bin/browser-connector"
```

The formula ships the same universal binary. Passing the linked `bin` path keeps Chrome's
manifest pointing at a stable symlink across upgrades.

### From source (Rust and Node)

```sh
./scripts/install-local.sh
~/.local/bin/browser-connector install --extension-id kppdjhnonomijdjifhobgeaipejojbho
```

That builds `browser-connector` into `~/.local/bin` and the unpacked extension into
`extension/dist`.

## 3. Pair and connect

Restart Chrome so it discovers the native-messaging manifest. Open the Browser Connector
side panel and approve Host Pairing.

### Codex plugin

The repo contains the plugin bundle at `plugins/browser-connector`. Its `.mcp.json` launches:

```sh
browser-connector mcp --host-id codex
```

This repository exposes the bundle through its repo marketplace. If **Browser Connector
Development** is not listed yet, register the repository root once:

```sh
codex plugin marketplace add /path/to/browser-connector
```

The repository is at <https://github.com/benedictjeremiahh/browser-connector> if you would
rather register it from its Git URL.

Restart the ChatGPT desktop app, open the Plugins Directory, choose **Browser Connector
Development**, and install **Browser Connector**. Codex CLI users can run the command below
or open `/plugins`; start a new session after installation.

```sh
codex plugin add browser-connector@browser-connector-dev
```

The plugin launches `~/.local/bin/browser-connector` by default. Set
`BROWSER_CONNECTOR_BIN` for Codex if you installed the binary elsewhere.

### Generic MCP host

Configure a local STDIO server equivalent to:

```json
{
  "mcpServers": {
    "browser-connector": {
      "command": "~/.local/bin/browser-connector",
      "args": ["mcp", "--host-id", "my-agent-host"]
    }
  }
}
```

Use a stable, human-readable `host-id`; the Connector Panel displays it during pairing and
while it holds the Control Lease.

## 4. First request

Ask the Agent Host to call `tabs_context`. The Connector Panel will request Host Pairing.
Site access and consequential actions are approved independently in the panel.

## Troubleshooting

```sh
~/.local/bin/browser-connector status --host-id codex
```

The extension should stay connected whenever Chrome is running, even when no MCP server is
active. If it shows disconnected, restart Chrome after native-manifest or binary changes
and inspect Chrome's extension errors. Opening the side panel is needed for pairing and
approvals, not for routine reconnection. If Chrome reports a debugger conflict, close
DevTools or the other debugger before continuing.

`browser-connector uninstall` removes the native-messaging manifest and the copied binary.
