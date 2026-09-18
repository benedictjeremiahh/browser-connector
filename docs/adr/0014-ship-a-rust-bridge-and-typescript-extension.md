# Ship a Rust bridge and TypeScript extension

The MCP bridge and native-messaging helper will be implemented in Rust and distributed as standalone OS-specific binaries, while the Manifest V3 extension will use TypeScript. Like Claude Code's bundled browser integration, end users should not need a language runtime or development toolchain to connect their Agent Host to Chrome.

## Consequences

Wire schemas must be generated or validated from one shared contract so Rust, the extension, and plugin metadata cannot drift. Provider adapters contain installation and guidance only; browser behavior remains in the shared bridge and extension.
