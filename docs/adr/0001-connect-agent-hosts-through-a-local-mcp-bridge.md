# Connect Agent Hosts through a local MCP bridge

The Browser Connector will expose browser capabilities to Agent Hosts through MCP, while a local bridge communicates with the browser extension through native messaging. This mirrors the proven Claude Code–browser integration shape, keeps browser authority and approvals local, and lets provider-specific installers reuse the same connector instead of embedding model SDKs or maintaining separate browser-control implementations.

## Consequences

The browser extension cannot be used by an Agent Host without the local bridge. Provider integrations may customize installation and activation, but they must not bypass the shared MCP capability contract or the extension's permission enforcement.
