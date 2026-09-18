# Expose a compact Claude-shaped MCP v1

The first public MCP contract will expose `tabs_context`, `tabs_create`, `navigate`, `computer`, `read_page`, `get_page_text`, `find`, `form_input`, `javascript_tool`, `read_console_messages`, `read_network_requests`, `resize_window`, `upload_file`, `download_file`, and `browser_batch`. The surface follows Claude in Chrome's documented and observed browser tools while removing legacy `_mcp` suffixes, generalizing upload beyond images, and adding explicit byte-returning download support.

## Consequences

Pairing, browser selection, Control Leases, Site Grants, approval, and audit management remain control-plane operations rather than agent tools. GIF recording, shortcuts, scheduling, and planning tools are deferred; incompatible future contract changes require a new major tool-contract version.
