#!/usr/bin/env node
/**
 * Build the extension and pack exactly what the Chrome Web Store receives: the
 * contents of `extension/dist` at the root of the archive, no build directory
 * and no sourcemaps.
 *
 * The manifest `key` is removed from the packaged copy. It exists so an
 * unpacked or self-hosted install keeps a stable id — that is what
 * `allowed_origins` in the native-messaging manifest names — but the Web Store
 * rejects an upload whose manifest carries a `key` ("Bidang key tidak
 * diperbolehkan dalam manifes") and assigns its own id instead.
 *
 * So the store id is not the development id. After the first upload, read the
 * id the console shows and register the bridge against it:
 *
 *   browser-connector install --extension-id <store-id> --host-id codex
 *
 * `extension/dist` keeps its key, because the unpacked install still needs it.
 *
 *   node scripts/package-extension.mjs            -> browser-connector.zip
 *   BROWSER_CONNECTOR_ZIP=/tmp/x.zip node ...
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const extension = join(root, 'extension');
const dist = join(extension, 'dist');
const archive = process.env.BROWSER_CONNECTOR_ZIP ?? join(root, 'browser-connector.zip');

execFileSync('npm', ['run', 'build'], { cwd: extension, stdio: 'inherit' });
if (!existsSync(join(dist, 'manifest.json'))) {
  console.error(`no manifest in ${dist}; the build did not produce a package`);
  process.exit(1);
}

const staging = mkdtempSync(join(tmpdir(), 'browser-connector-store-'));
try {
  cpSync(dist, staging, { recursive: true });

  const manifestPath = join(staging, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const devKey = manifest.key;
  delete manifest.key;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  rmSync(archive, { force: true });
  execFileSync('zip', ['-r', '-q', archive, '.', '-x', '*.map'], { cwd: staging, stdio: 'inherit' });

  const kb = Math.round(statSync(archive).size / 1024);
  console.log(`\n${archive}`);
  console.log(`  ${manifest.name} ${manifest.version} · manifest v${manifest.manifest_version} · ${kb} KB`);
  console.log(`  key: removed${devKey ? ' (extension/dist keeps it for the unpacked install)' : ' (was already absent)'}`);
  console.log('  the store assigns the id; register the bridge against it after the first upload');
} finally {
  rmSync(staging, { recursive: true, force: true });
}
