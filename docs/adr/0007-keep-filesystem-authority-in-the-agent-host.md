# Keep filesystem authority in the Agent Host

File uploads and saved browser artifacts will cross the Browser Connector as bytes rather than filesystem paths the connector may open or write itself. This follows Claude Code with Chrome, where the host's file-read permission gates uploads, while preserving a clean authority split: the Agent Host owns filesystem access and the extension owns browser-site approval.

## Consequences

Uploads are capped at 10 MB and require a preview of file metadata and destination origin. Downloads and explicitly saved screenshots return bytes to the Agent Host, which must separately authorize and perform any filesystem write; GIF recording is deferred beyond the MVP.
