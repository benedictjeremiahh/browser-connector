# Marketplace listing copy

These directories list the MCP server; none of them installs Chrome's native host. A
listing must say that the companion is installed with one command and the extension
separately.

## Listing fields

**Name**: Browser Connector

**Summary**: Drive the browser you are already signed into from a local AI agent. No
account, no server, no telemetry.

**Launch command**:

```sh
npx -y browser-connector mcp --host-id <your-host-id>
```

**One-time companion install** (after installing the Chrome extension):

```sh
npx browser-connector install
```

**Repository**: https://github.com/benedictjeremiahh/browser-connector

**License**: Apache-2.0

## Where to list

- Official MCP Registry: publish `packaging/mcp/server.json` with `mcp-publisher` after
  the npm package exists. The registry stores metadata only.
- mcp.so, Glama, Smithery: directory metadata and the launch command above. Smithery's
  current CLI has no native-binary install path; do not present it as the companion
  installer.

Do not claim that a listing installs the Chrome host. It cannot write
`NativeMessagingHosts`; the user runs `browser-connector install` once.
