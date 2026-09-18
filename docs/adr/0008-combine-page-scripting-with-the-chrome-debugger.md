# Combine page scripting with the Chrome debugger

The extension will use page scripting for semantic reading and search, and attach `chrome.debugger` to Controlled Tabs for input, screenshots, navigation lifecycle, console, and network capabilities. This follows the permission and capability shape documented for Claude in Chrome and avoids relying solely on synthetic DOM events for browser automation.

## Consequences

Debugger attachment must be limited to Controlled Tabs, visibly indicated in the Connector Panel, and released with the Control Lease. Conflicts with DevTools or other debuggers must fail explicitly and require user resolution rather than silently switching to weaker behavior.
