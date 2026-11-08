# Distribution packaging

Free channels only: npm, a Homebrew formula in a private tap, and MCP directory listings.
No Apple Developer Program, no notarization, no `.pkg`.

## Publish order

1. Build and pack the npm package:

   ```sh
   node scripts/package-npm.mjs
   ```

   It lipo-merges both architectures, ad-hoc signs the universal binary, verifies
   `--version`, and prints the tarball path and SHA-256.

2. Publish to npm (requires `npm login`):

   ```sh
   npm publish packaging/npm
   ```

3. Put the tarball SHA-256 into `packaging/homebrew/browser-connector.rb`, then copy the
   formula to `Formula/browser-connector.rb` in `benedictjeremiahh/homebrew-tap`.

4. Publish the MCP Registry entry from `packaging/mcp/server.json` after the npm package
   exists. Use the listing copy in `packaging/marketplace/README.md` for mcp.so, Glama and
   Smithery.

## Why a formula, not a cask

A Homebrew cask is quarantined and audited for notarization; this free build has neither.
A formula in a private tap installs the same universal binary without quarantine. The
formula's caveat passes the linked `bin` path, so the native-messaging manifest never
points into a versioned Cellar directory.

## Why no postinstall

npm install scripts are skipped by `--ignore-scripts`, gated by npm 11's allow-scripts,
and rejected by pnpm's strict dependency builds. Registration is an explicit
`browser-connector install`, which also copies the binary out of the npx cache to
`~/.local/bin`.
