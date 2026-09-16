#!/usr/bin/env node
/**
 * dsh-cua launcher
 *
 * Starts the MCP server with no dependency on the working directory the harness
 * happens to spawn from, and no absolute path baked into configuration.
 *
 * Why this exists
 * ---------------
 * The harness spawns stdio servers from *its* working directory (the launch
 * root), not from the profile directory. A command like
 * `node node_modules/dsh-mac-cua/cua-repl/server.js` therefore does not resolve:
 * there is no `node_modules` in the launch root, the server dies immediately,
 * and with `failOnStartupError: true` that took the whole harness down to the
 * safe-mode recovery screen.
 *
 * So the launcher finds the package itself:
 *
 *   1. Sibling path — correct whenever this file lives inside the installed
 *      package, which is the normal case.
 *   2. Otherwise `require.resolve` from the working directory and its ancestors,
 *      letting Node do the resolution rather than building paths by hand.
 *
 * Once found, the server is `require`d in this process: an extra spawn would
 * cost a process for nothing and would swallow the server's exit status.
 */

'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { createRequire } = require('node:module');

const PACKAGE = 'dsh-mac-cua';
const SERVER_REL = 'cua-repl/server.js';

/** Roots to try, most specific first. */
function candidateRoots() {
  const roots = [__dirname, path.join(__dirname, '..'), process.cwd()];

  // Walk up from the working directory. The harness runs from the launch root
  // and the profile's node_modules sits elsewhere, so ancestors are worth
  // trying, not just the directory itself.
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    roots.push(dir, path.join(dir, 'node_modules'));
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return roots;
}

/** Locate the MCP server, or null when the package cannot be found. */
function resolveServer() {
  // Fast path: this launcher sits inside the installed package.
  const sibling = path.join(__dirname, '..', SERVER_REL);
  if (fs.existsSync(sibling)) return sibling;

  // Slow path: let Node resolve the package from each candidate root.
  const req = createRequire(__filename);
  for (const root of candidateRoots()) {
    try {
      return req.resolve(`${PACKAGE}/${SERVER_REL}`, { paths: [root] });
    } catch {
      // Try the next root.
    }
  }
  return null;
}

const server = resolveServer();

if (!server) {
  process.stderr.write(
    `[dsh-cua] could not locate the ${PACKAGE} package from ${__filename}\n` +
    `[dsh-cua] working directory: ${process.cwd()}\n` +
    '[dsh-cua] the install looks incomplete. Reinstall with:\n' +
    `[dsh-cua]   dsh plugin --profile web add ${PACKAGE}\n`
  );
  process.exit(1);
}

require(server);