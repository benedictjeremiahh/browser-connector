# Target elements through document-scoped Page References

Following the accessibility-tree and element-reference behavior observed in Claude in Chrome, `read_page` and `find` will expose opaque Page References for interaction tools, with screen coordinates available as a visual fallback. References are scoped to a tab and document generation rather than treated as durable selectors.

## Consequences

Navigation, reload, tab closure, or document replacement invalidates affected references and returns a stale-reference error; the connector must never guess a similar target. Tab identifiers are session-scoped and likewise cannot be persisted or reused across sessions.
