#!/usr/bin/env node
/**
 * dsh-cua native module builder.
 *
 * The package ships a prebuilt `native/dsh_cua.node`, so a normal install needs
 * no toolchain at all — which matters because pnpm blocks lifecycle scripts by
 * default in the plugin market, and because most users have no Swift compiler
 * configured for this.
 *
 * Run this when the prebuilt binary is missing, was built for a different
 * architecture, or when you are working on the Swift sources:
 *
 *   node scripts/build-native.js
 *
 * Requirements: Xcode Command Line Tools (for swiftc) and Node headers matching
 * the Node that will load the module. Set NODE_INCLUDE to point at them.
 */

'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const ROOT = path.resolve(__dirname, '..');
const NATIVE = path.join(ROOT, 'native');

function fail(message) {
  console.error(`\ndsh-cua: ${message}\n`);
  process.exit(1);
}

function which(cmd) {
  const r = spawnSync('which', [cmd], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

/** Find a directory containing node_api.h. */
function findNodeInclude() {
  const candidates = [];

  if (process.env.NODE_INCLUDE) candidates.push(process.env.NODE_INCLUDE);

  // Headers installed next to the running Node, which is the common case for a
  // version manager or an official tarball install.
  const execDir = path.dirname(process.execPath);
  candidates.push(path.join(execDir, '..', 'include', 'node'));

  // nvm keeps one headers directory per version.
  const nvmRoot = path.join(os.homedir(), '.nvm', 'versions', 'node');
  if (fs.existsSync(nvmRoot)) {
    for (const version of fs.readdirSync(nvmRoot).sort().reverse()) {
      candidates.push(path.join(nvmRoot, version, 'include', 'node'));
    }
  }

  // Homebrew and system locations.
  candidates.push('/opt/homebrew/include/node', '/usr/local/include/node');

  for (const dir of candidates) {
    if (dir && fs.existsSync(path.join(dir, 'node_api.h'))) return dir;
  }
  return null;
}

function main() {
  if (process.platform !== 'darwin') {
    fail('Computer Use is macOS-only; this package cannot be built on ' + process.platform);
  }

  if (!which('swiftc')) fail('swiftc was not found. Install the Xcode Command Line Tools with: xcode-select --install');

  const include = findNodeInclude();
  if (!include) {
    fail(
      'Could not find node_api.h (the Node development headers).\n' +
      '  Install them, or point at an existing copy:\n' +
      '    NODE_INCLUDE=/path/to/include/node node scripts/build-native.js\n' +
      '  A matching set ships with every official Node tarball and with nvm.'
    );
  }

  console.log(`dsh-cua: building native module`);
  console.log(`  node headers : ${include}`);
  console.log(`  platform     : ${process.platform} ${process.arch}`);

  const r = spawnSync('bash', [path.join(NATIVE, 'build.sh')], {
    stdio: 'inherit',
    cwd: NATIVE,
    env: { ...process.env, NODE_INCLUDE: include },
  });

  if (r.status !== 0) fail(`native build failed (exit ${r.status})`);

  const out = path.join(NATIVE, 'dsh_cua.node');
  if (!fs.existsSync(out)) fail('the build reported success but dsh_cua.node is missing');
  console.log(`dsh-cua: built ${out} (${fs.statSync(out).size} bytes)`);
}

main();