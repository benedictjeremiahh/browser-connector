# Never take the person's screen

ADR-0024 moved work tabs into the background, but two tools could still take the person's screen. `tabs_activate` brought the tab forward and focused its window, which raised Chrome over whatever the person was doing; agents called it out of habit before clicks and screenshots. `resize_window` resized the person's real window, so a phone-width check shrank their browser.

`tabs_activate` now changes what the person sees only inside a window that holds nothing but this session's tabs, and it never focuses or raises a window. Anywhere else it returns `deferred: true`, because the tab already renders and receives input in the background. `resize_window` no longer touches the window: it emulates the requested viewport inside this session's tabs in that window, and narrow widths also emulate a touch device. Screenshots, clicks and layout follow the emulated size, and the emulation ends with the tab or the lease.

This supersedes ADR-0024's statement that an agent that needs the person to watch calls `tabs_activate`.

## Consequences

An agent cannot pull the person into its tab; the person opens the tab from the marked group when they want to watch. A phone-width check no longer disturbs the window, and it measures the same layout a phone would, since the emulated viewport sets the CSS width the page sees. The tool names keep their old spelling for compatibility, so their descriptions carry the new meaning.
