# Install the MVP locally

The MVP supports macOS and Google Chrome. It is local-only and does not require a connector account.

## 1. Build and install the local binary

Rust and Node are required to build from source. Run:

```sh
./scripts/install-local.sh
```

This installs `browser-connector` into `~/.local/bin` by default and builds the unpacked extension at `extension/dist`.

## 2. Load the Chrome extension

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Select **Load unpacked** and choose `extension/dist`.
4. Confirm Chrome shows the pinned MVP development ID `kppdjhnonomijdjifhobgeaipejojbho`.

## 3. Register native messaging

```sh
~/.local/bin/browser-connector install --extension-id kppdjhnonomijdjifhobgeaipejojbho --host-id codex
```

Restart Chrome so it discovers the native-messaging manifest. Open the Browser Connector side panel from the toolbar.

## 4. Connect an Agent Host

### Codex plugin

The repo contains the plugin bundle at `plugins/browser-connector`. Its `.mcp.json` launches:

```sh
browser-connector mcp --host-id codex
```

This repository exposes the bundle through its repo marketplace. If **Browser Connector Development** is not listed yet, register the repository root once:

```sh
codex plugin marketplace add /absolute/path/to/chrome-controller-extension
```

Restart the ChatGPT desktop app, open the Plugins Directory, choose **Browser Connector Development**, and install **Browser Connector**. Codex CLI users can run the command below or open `/plugins`; start a new session after installation.

```sh
codex plugin add browser-connector@browser-connector-dev
```

The plugin launches `~/.local/bin/browser-connector` by default. Set `BROWSER_CONNECTOR_BIN` for Codex if you installed the binary elsewhere.

### Generic MCP host

Configure a local STDIO server equivalent to:

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

Use a stable, human-readable `host-id`; the Connector Panel displays it during pairing and while it holds the Control Lease.

## 5. First request

Ask the Agent Host to call `tabs_context`. The Connector Panel will request Host Pairing. Site access and consequential actions are approved independently in the panel.

## Troubleshooting

```sh
~/.local/bin/browser-connector status --host-id codex
```

The extension should stay connected whenever Chrome is running, even when no MCP server is active. If it shows disconnected, restart Chrome after native-manifest or binary changes and inspect Chrome's extension errors. Opening the side panel is needed for pairing and approvals, not for routine reconnection. If Chrome reports a debugger conflict, close DevTools or the other debugger before continuing.
