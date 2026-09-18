# Redact network data before it leaves the extension

Network inspection will return metadata by default: method, redacted URL, status, resource type, timing, initiator, and safe header names. Unlike an unrestricted debugger trace, query values, credentials, cookies, request bodies, and response bodies are removed in the extension before data reaches the native bridge; a same-origin textual or JSON response body up to 256 KiB may be requested only as a Protected Action.

## Consequences

Request bodies and binary or media response bodies are unavailable in the MVP. Sensitive redaction cannot be delegated to an Agent Host, because raw values must not cross the connector trust boundary.
