#!/usr/bin/env node
/**
 * Build the extension and pack exactly what a browser store receives: the
 * contents of `extension/dist` at the root of the archive, with no build
 * directory or sourcemaps inside.
 *
 * The manifest keeps its `key`, so the packed extension keeps the id
 * `kppdjhnonomijdjifhobgeaipejojbho` the native-messaging manifest already
 * lists in `allowed_origins`. Removing it would hand the store a different id
 * and silently break every installed bridge.
 *
 *   node scripts/package-extension.mjs            -> browser-connector.zip
 *   BROWSER_CONNECTOR_ZIP=/tmp/x.zip node ...
 */
import { execFileSync } from 'node:child_process';
import { existsSync, rmSync, statSync } from 'node:fs';
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

rmSync(archive, { force: true });
execFileSync('zip', ['-r', '-q', archive, '.', '-x', '*.map'], { cwd: dist, stdio: 'inherit' });

const manifest = JSON.parse(execFileSync('unzip', ['-p', archive, 'manifest.json'], { encoding: 'utf8' }));
const kb = Math.round(statSync(archive).size / 1024);
console.log(`\n${archive}`);
console.log(`  name ${manifest.name} ${manifest.version} · manifest v${manifest.manifest_version}`);
console.log(`  key ${manifest.key ? 'present (id stays kppdjhnonomijdjifhobgeaipejojbho)' : 'ABSENT — the store id will differ'}`);
console.log(`  ${kb} KB`);
