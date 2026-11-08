# browser-connector

The companion program for the [Browser Connector](https://github.com/benedictjeremiahh/browser-connector)
Chrome extension: a local MCP server plus Chrome's native-messaging host.

Install the extension from the Chrome Web Store first, then register the companion:

```sh
npx browser-connector install
```

That copies the binary to `~/.local/bin/browser-connector` (not into the npx cache),
registers the published Store extension id, and writes Chrome's native-messaging
manifest. Restart Chrome and approve Host Pairing in the Connector side panel.

Run the MCP server from your agent host:

```sh
npx browser-connector mcp --host-id codex
# or, after install:
~/.local/bin/browser-connector mcp --host-id codex
```

Remove the manifest and the copied binary:

```sh
npx browser-connector uninstall
```

The package is macOS-only and carries both arm64 and x64 slices. The binary is
ad-hoc signed, not notarized; it installs without macOS quarantine because npm does
not set the quarantine attribute.

Source and the extension: <https://github.com/benedictjeremiahh/browser-connector>.
