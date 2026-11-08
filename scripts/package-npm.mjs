#!/usr/bin/env node
/**
 * Build the npm package the Store companion is installed from:
 *
 *   node scripts/package-npm.mjs          -> packaging/npm/browser-connector-<version>.tgz
 *
 * It lipo-merges the arm64 and x64 binaries into one universal Mach-O, ad-hoc signs
 * the merged file (the arm64 linker signs its slice, the x64 one does not, and lipo
 * invalidates both), and runs `npm pack`. It never publishes.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const packageDirectory = join(root, 'packaging/npm');
const output = join(packageDirectory, 'bin/browser-connector');
const targets = ['aarch64-apple-darwin', 'x86_64-apple-darwin'];

for (const target of targets) {
  if (!existsSync(join(root, 'target', target, 'release/browser-connector'))) {
    console.log(`building ${target}`);
    execFileSync('cargo', ['build', '--release', '--locked', '--target', target], { cwd: root, stdio: 'inherit' });
  }
}

mkdirSync(join(packageDirectory, 'bin'), { recursive: true });
rmSync(output, { force: true });
execFileSync('lipo', ['-create',
  join(root, 'target/aarch64-apple-darwin/release/browser-connector'),
  join(root, 'target/x86_64-apple-darwin/release/browser-connector'),
  '-output', output
], { stdio: 'inherit' });
execFileSync('codesign', ['--force', '--sign', '-', output], { stdio: 'inherit' });
chmodSync(output, 0o755);
execFileSync(output, ['--version'], { stdio: 'inherit' });

const packed = execFileSync('npm', ['pack', '--silent'], { cwd: packageDirectory, encoding: 'utf8' }).trim().split('\n').at(-1);
const archive = join(packageDirectory, packed);
const bytes = readFileSync(archive);
const sha256 = createHash('sha256').update(bytes).digest('hex');
const version = JSON.parse(readFileSync(join(packageDirectory, 'package.json'), 'utf8')).version;

console.log(`\n${archive}`);
console.log(`  browser-connector ${version} · ${Math.round(statSync(archive).size / 1024)} KB`);
console.log(`  sha256 ${sha256}`);
console.log('  not published. After `npm login`: npm publish packaging/npm');
console.log(`  put sha256 ${sha256} into packaging/homebrew/browser-connector.rb before publishing the tap`);
