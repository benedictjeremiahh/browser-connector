# Run an on-demand local STDIO bridge

Superseded in part by ADR 0021: the MCP side remains on demand, but the native helper now owns the stable local socket for the lifetime of Chrome's native-messaging port.

Each Agent Host will launch the MCP bridge over STDIO, while Chrome's native-messaging helper connects the extension to that active bridge through an authenticated local socket. This follows Claude Code with Chrome's local process and named-pipe shape without introducing an always-running daemon or cloud relay.

## Consequences

Control Lease arbitration must select among concurrently running bridges. Socket endpoints must be local-only, owner-restricted, authenticated, and cleaned up when their process exits; Streamable HTTP and remote browser access are outside the MVP.
