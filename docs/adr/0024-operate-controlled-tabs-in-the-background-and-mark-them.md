# Operate Controlled Tabs in the background and mark them on their favicon

Agents worked in a foreground tab: creating a tab, reusing one and navigating all activated it, so a person using the same browser lost the tab they were on every time an agent acted. Work tabs now open and navigate without taking focus, and only `tabs_activate` brings a Controlled Tab forward. This deliberately deviates from the Claude in Chrome baseline (ADR-0002), whose work tab is the visible one.

Background tabs are throttled by Chrome and report themselves as unfocused, which stalls screenshots and changes focus-dependent page behavior. When the debugger attaches, the connector enables focus emulation and sets the page lifecycle to active, so a background tab renders and behaves as if a person were looking at it.

Working out of sight must not make control invisible. Every Controlled Tab carries a mark on its own favicon: the extension composes the page's icon with a small badge and swaps it in through its own isolated-world script, re-applies it after navigation, and restores the page's icons when the lease ends. Pages Chrome does not let extensions script (for example `chrome://` pages) keep their icon; the lease's tab group still identifies them (ADR-0017).

## Consequences

A person can keep using the browser while an agent works, and can tell at a glance which tabs it holds. Screenshots of a background tab reflect what the page renders under emulated focus, which can differ from what a person would see in a page that reacts to real visibility. Agents that need the person to watch a step call `tabs_activate` explicitly.
