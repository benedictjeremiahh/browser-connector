# Use Claude in Chrome as the behavioral baseline

The Browser Connector's initial tool surface will follow the publicly documented behavior of [Claude Code with Chrome](https://code.claude.com/docs/en/chrome): structured page reading and search, screenshots, clicking and typing, navigation, tab and window management, console and network inspection, and batched browser actions. Compatibility means equivalent observable capabilities and safety semantics; undocumented Anthropic schemas, identifiers, and transport details are not assumed or copied. Claude Code is a reference rather than an installation target because it already has Claude in Chrome.

## Consequences

Every proposed browser capability must be compared with the current Claude in Chrome behavior before it enters the public contract. Any deliberate deviation must be identified explicitly and justified rather than presented as parity. Distribution will initially target Codex through a first-class plugin and other Agent Hosts through generic MCP installation.
