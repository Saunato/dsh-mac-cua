#!/usr/bin/env node
/**
 * dsh-cua setup and diagnostics
 *
 * Normally nothing needs configuring: the package declares `dsh.bundle`, so
 * `dsh plugin add dsh-cua` mounts the MCP server from the bundle's own
 * `cordis.patch.yml` automatically.
 *
 * This command exists for the two cases that still need a hand:
 *   - a manual install (no bundle layer), where the profile needs an explicit
 *     row with this checkout's absolute paths;
 *   - diagnosis, when the tools do not appear and the reason is not obvious.
 *
 * Usage:
 *   dsh-cua-setup                 # check the install and report what is missing
 *   dsh-cua-setup --write         # add an explicit row (manual installs only)
 *   dsh-cua-setup --print         # show that row without writing it
 *   dsh-cua-setup --remove        # take an explicit row back out
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SERVER_ID = 'mcp-cua';
const SERVER_NAME = 'cua_repl';
// The launcher, not the server: it resolves the package itself, so the row works
// regardless of which directory the harness spawns from.
const LAUNCHER_REL = 'scripts/serve.js';

const PKG_ROOT = path.resolve(__dirname, '..');
const PKG_NAME = require('../package.json').name;

const OUR_BANNER_PREFIX = '# ─ dsh-cua:';
// Install replaces an empty top-level list with the new row, which loses the
// fact that a list was there. Removal needs it to reconstruct the profile, so
// the install records it in the banner.
const REPLACED_EMPTY_LIST = '# note: replaced an empty [] list';
const BLOCK_HEADER = '# ─ dsh-cua: Computer Use for macOS ──';
const SERVER_JS = path.join(PKG_ROOT, 'cua-repl', 'server.js');

function parseArgs(argv) {
  const out = { profile: 'web', home: null, print: false, remove: false, write: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--profile') out.profile = argv[++i];
    else if (a === '--home') out.home = argv[++i];
    else if (a === '--print') out.print = true;
    else if (a === '--write') out.write = true;
    else if (a === '--remove') out.remove = true;
    else if (a === '--status') out.status = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else {
      console.error(`dsh-cua-setup: unknown argument "${a}"`);
      process.exit(2);
    }
  }
  return out;
}

const HELP = `dsh-cua setup and diagnostics

Usage:
  dsh-cua-setup [options]

With no options this checks the installation and reports what is missing.

Options:
  --profile <name>   profile to inspect or patch (default: web)
  --home <dir>       DSH home directory (default: $DSH_HOME, then the
                     DSH Desktop location)
  --status           check the install and report (this is the default)
  --write            add an explicit profile row, for installs that have no
                     bundle layer. Not needed after \`dsh plugin add dsh-cua\`.
  --print            print that row and exit, changing nothing
  --remove           remove an explicit row
  -h, --help         show this help

The package mounts its own MCP server through \`dsh.bundle\`, so a normal
install needs no configuration at all.
`;

/** Locate the DSH home directory. */
function findDshHome(explicit) {
  const candidates = [
    explicit,
    process.env.DSH_HOME,
    path.join(os.homedir(), 'Library', 'Application Support', 'dsh-desktop', 'harness'),
    path.join(os.homedir(), '.dsh'),
  ].filter(Boolean);

  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'profiles'))) return dir;
  }
  return null;
}

/**
 * The row this installer writes.
 *
 * Both paths are absolute, and both have to be. The harness spawns stdio servers
 * from its own working directory (the launch root), so `cwd: '.'` and a relative
 * argument do not resolve there: the server dies instantly. An earlier version of
 * this command wrote relative paths on the assumption that the working directory
 * was the profile, which produced a plugin that killed the harness on startup.
 *
 * `failOnStartupError` is false so that a failure here degrades to "the tool is
 * missing" instead of "the product will not boot".
 */
function buildRow() {
  return [
    `- insert:`,
    `    - id: ${SERVER_ID}`,
    `      name: '@deepseek-ai/dsh-mcp-client'`,
    `      config:`,
    `        serverName: ${SERVER_NAME}`,
    `        transport: stdio`,
    `        command: node`,
    `        args:`,
    `          - '${path.join(PKG_ROOT, LAUNCHER_REL)}'`,
    `        cwd: '${PKG_ROOT}'`,
    `        env:`,
    `          DSH_CUA_NATIVE: '${path.join(PKG_ROOT, 'native', 'dsh_cua.node')}'`,
    `        toolCallTimeoutMs: 180000`,
    `        failOnStartupError: false`,
  ].join('\n');
}

/**
 * Split a patch file into insert blocks.
 *
 * A block starts at a top-level `- insert:` line and runs until the next
 * top-level entry (a line with no leading whitespace that is not part of this
 * block). Returns each block with its line range so callers can remove exactly
 * one of them, without touching neighbouring rows — a plain line scan kept
 * getting that wrong, and truncating someone else's plugin config is not an
 * acceptable failure mode.
 */
function extractInsertBlocks(text) {
  const lines = text.split('\n');
  const blocks = [];

  for (let i = 0; i < lines.length; i++) {
    if (!/^- insert:\s*$/.test(lines[i])) continue;
    let end = i + 1;
    while (end < lines.length) {
      const line = lines[end];
      // A new top-level entry ends the block. Blank lines inside it are kept.
      if (line.trim() !== '' && !/^\s/.test(line)) break;
      end++;
    }
    const body = lines.slice(i, end).join('\n');
    const idMatch = body.match(/^\s+- id:\s*(\S+)\s*$/m);

    // A banner comment our installer wrote above the row belongs to the block,
    // so removal takes it too. Only our own marker qualifies — a comment the
    // user wrote before installing must survive.
    //
    // The banner runs over several comment lines and only its FIRST line
    // carries the marker, so the scan has to walk the whole contiguous comment
    // run upward and then test the top of it. Testing the line adjacent to the
    // row instead would never match, and the banner would be left behind.
    let start = i;
    let probe = i - 1;
    if (probe >= 0 && lines[probe].trim() === '') probe--;
    if (probe >= 0 && lines[probe].startsWith('#')) {
      let bannerStart = probe;
      while (bannerStart > 0 && lines[bannerStart - 1].startsWith('#')) bannerStart--;
      if (lines[bannerStart].startsWith(OUR_BANNER_PREFIX)) {
        start = bannerStart;
        // Claim the blank separator the writer placed above the banner, so
        // removal takes it too and leaves no stray blank line behind. Only when
        // something actually precedes it.
        if (start > 0 && lines[start - 1].trim() === '') start--;
      }
    }

    blocks.push({ start, insertStart: i, end, id: idMatch ? idMatch[1] : null, body });
  }
  return blocks;
}

/** Does the profile already carry our row? */
function hasOurRow(text) {
  return extractInsertBlocks(text).some((b) => b.id === SERVER_ID);
}

/** Remove our insert block, leaving every other row untouched. */
function stripOurBlock(text) {
  const blocks = extractInsertBlocks(text);
  const ours = blocks.find((b) => b.id === SERVER_ID);
  if (!ours) return text;

  const lines = text.split('\n');
  // `ours.start` already includes our banner comment when one is present.
  const removedLines = lines.slice(ours.start, ours.end);
  const kept = [...lines.slice(0, ours.start), ...lines.slice(ours.end)];

  // If the install replaced an empty list, put it back so the file is exactly
  // as it was found.
  const replacedEmptyList = removedLines.some((l) => l.trim() === REPLACED_EMPTY_LIST);
  if (replacedEmptyList) {
    // The install consumed an empty top-level list. Put the surviving text back
    // and re-add `[]` at the end of it.
    //
    // This is reconstruction, not byte-exact restoration, and it is honest
    // about its limit: an input that was *only* `[]` comes back as `[]` plus the
    // trailing newline, and a file that never ended in a newline gains one.
    // Both are YAML-equivalent — an empty document and `[]` parse the same — so
    // the outcome is a valid profile either way. Every case with real content
    // round-trips exactly, which is what protects a user's other plugins.
    const body = kept.join('\n').replace(/\n+$/, '');
    return (body === '' ? '[]' : body + '\n[]') + '\n';
  }

  // Removing the last entry can leave a file with nothing but comments, and the
  // loader rejects that: an overlay must be a top-level YAML array. A profile
  // that boots is worth more than one that is merely tidy, so restore the empty
  // list whenever no entry survives.
  const hasEntry = kept.some((l) => /^- /.test(l));
  const out = kept.join('\n');
  if (hasEntry) return out;
  const body = out.replace(/\n+$/, '');
  return (body === '' ? '[]' : body + '\n[]') + '\n';
}

/** Load the native module, to report whether it actually works. */
function nativeStatus() {
  try {
    // Required lazily: a broken native build must be reportable, not fatal.
    const { isTrusted, nativePath } = require('../lib/sky.js');
    // Force the module load now so a broken build is reported here, not later.
    const trusted = isTrusted();
    return { ok: true, path: nativePath(), isTrusted: () => trusted, error: null };
  } catch (err) {
    return { ok: false, path: null, isTrusted: null, error: err.message };
  }
}

/**
 * Report whether the plugin is installed and usable.
 *
 * The common failure is not a broken build but a missing permission, and the
 * two look identical from the outside: the tools either do not appear or every
 * call fails. So the check separates install, native module, permissions, and
 * profile composition, and names the fix for whichever one is wrong.
 */
function runStatus(args) {
  const home = findDshHome(args.home);
  const pkgVersion = require('../package.json').version;

  console.log(`${PKG_NAME} ${pkgVersion}`);
  console.log(`  package : ${PKG_ROOT}`);
  console.log(`  platform: ${process.platform} ${process.arch}`);

  if (process.platform !== 'darwin') {
    console.log('\n  ✗ Computer Use is macOS-only.');
    process.exitCode = 1;
    return;
  }

  // Native module
  const native = nativeStatus();
  if (native.ok) {
    console.log(`  native  : ok (${native.path})`);
  } else {
    console.log('  native  : FAILED');
    console.log('');
    for (const line of String(native.error).split('\n')) console.log(`    ${line}`);
    console.log('');
    console.log('  Fix: node ' + path.join(PKG_ROOT, 'scripts', 'build-native.js'));
    process.exitCode = 1;
  }

  // Permissions. `isTrusted()` is synchronous on the native module, which is
  // all that is needed here; the full preflight (which captures a screenshot)
  // stays in the server, where being slow does not matter.
  let trusted = null;
  if (native.ok) {
    try {
      trusted = native.isTrusted();
      console.log(`  accessibility : ${trusted ? 'ok' : 'NOT GRANTED'}`);
      if (!trusted) {
        console.log('    Fix: System Settings > Privacy & Security > Accessibility');
        console.log('         add and enable DSH Desktop, then restart it.');
        process.exitCode = 1;
      }
    } catch (err) {
      console.log(`  accessibility : could not be determined (${err.message})`);
    }
  }

  // Profile composition
  if (!home) {
    console.log('  profile : could not locate a DSH home; pass --home <dir>');
    process.exitCode = 1;
    return;
  }
  const profileDir = path.join(home, 'profiles', args.profile);
  const patchFile = path.join(profileDir, 'cordis.patch.yml');
  const manifestFile = path.join(profileDir, 'package.json');

  let bundled = false;
  let listed = false;
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    const deps = manifest.dependencies || {};
    listed = Object.prototype.hasOwnProperty.call(deps, PKG_NAME);
    bundled = (manifest.dsh?.profile?.bundles || []).includes(PKG_NAME);
  } catch { /* profile not initialised */ }

  let explicitRow = false;
  if (fs.existsSync(patchFile)) {
    explicitRow = hasOurRow(fs.readFileSync(patchFile, 'utf8'));
  }

  console.log(`  profile : ${profileDir}`);
  console.log(`    dependency installed : ${listed ? 'yes' : 'no'}`);
  console.log(`    bundle layer active  : ${bundled ? 'yes' : 'no'}`);
  console.log(`    explicit patch row   : ${explicitRow ? 'yes (override)' : 'no'}`);

  const mounted = bundled || explicitRow;
  console.log('');
  if (mounted) {
    if (bundled && !explicitRow) {
      // The bundle's own row uses a relative path, which does not resolve from
      // the launch root. Say so rather than claiming a working install.
      console.log('  ⚠ The bundle layer is mounted, but its row uses a relative path that');
      console.log('    does not resolve from the harness working directory. Run this');
      console.log('    command with --write to add an absolute-path row.');
      process.exitCode = 1;
      return;
    }
    console.log('  ✓ The MCP server is mounted. After a harness reload the agent sees');
    console.log('    mcp__cua_repl__js and mcp__cua_repl__js_reset.');
    if (!native.ok) {
      console.log('  ✗ but the native module must build before any call will work.');
    }
  } else if (listed) {
    console.log('  ✗ Installed, but no bundle layer and no patch row: the server is not mounted.');
    console.log('    Run `dsh plugin --profile ' + args.profile + ' add ' + PKG_NAME + '` to let the bundle register,');
    console.log('    or add an explicit row with: dsh-cua-setup --write');
    process.exitCode = 1;
  } else {
    console.log(`  ✗ ${PKG_NAME} is not installed into this profile.`);
    console.log('    Run: dsh plugin --profile ' + args.profile + ' add ' + PKG_NAME);
    process.exitCode = 1;
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { process.stdout.write(HELP); return; }

  if (process.platform !== 'darwin') {
    console.error('dsh-cua: Computer Use is macOS-only.');
    process.exit(1);
  }

  const row = buildRow();

  if (args.print) {
    process.stdout.write(row + '\n');
    return;
  }

  if (args.status || (!args.write && !args.remove)) {
    runStatus(args);
    return;
  }

  const home = findDshHome(args.home);
  if (!home) {
    console.error(
      'dsh-cua-setup: could not find a DSH home directory.\n' +
      '  Pass one explicitly:  dsh-cua-setup --home /path/to/harness\n' +
      '  Or set DSH_HOME.'
    );
    process.exit(1);
  }

  const profileDir = path.join(home, 'profiles', args.profile);
  if (!fs.existsSync(profileDir)) {
    console.error(
      `dsh-cua-setup: profile "${args.profile}" not found at ${profileDir}\n` +
      '  Available profiles: ' +
      (fs.existsSync(path.join(home, 'profiles'))
        ? fs.readdirSync(path.join(home, 'profiles')).filter((d) =>
            fs.statSync(path.join(home, 'profiles', d)).isDirectory() && d !== 'node_modules').join(', ')
        : '(none)')
    );
    process.exit(1);
  }

  const patchFile = path.join(profileDir, 'cordis.patch.yml');
  let text = fs.existsSync(patchFile) ? fs.readFileSync(patchFile, 'utf8') : '[]\n';

  if (args.remove) {
    if (!hasOurRow(text)) {
      console.log(`dsh-cua-setup: nothing to remove from ${patchFile}`);
      return;
    }
    const stripped = stripOurBlock(text);
    fs.writeFileSync(patchFile, stripped.endsWith('\n') ? stripped : stripped + '\n');
    console.log(`dsh-cua-setup: removed the ${SERVER_ID} row from ${patchFile}`);
    console.log('Restart or reload the harness for it to take effect.');
    return;
  }

  if (hasOurRow(text)) {
    console.log(`dsh-cua-setup: the ${SERVER_ID} row is already present in ${patchFile}`);
    console.log('Nothing to do. Use --remove to take it out.');
    return;
  }

  // Replace an empty top-level list with our block; otherwise append.
  // An empty top-level list carries no meaning, so replace it instead of
  // leaving a stray `[]` above the new row. Every comment is preserved.
  const replacedEmptyList = /^\s*\[\s*\]\s*$/m.test(text);

  const blockLines = [
    BLOCK_HEADER,
    '# Mounts the dsh-cua MCP server: a persistent JavaScript REPL that drives',
    '# desktop applications through the Accessibility API. Registers as',
    `# \`${SERVER_NAME}\`, so the tools appear as mcp__${SERVER_NAME}__js and`,
    `# mcp__${SERVER_NAME}__js_reset.`,
  ];
  if (replacedEmptyList) blockLines.push(REPLACED_EMPTY_LIST);
  blockLines.push(row);
  const block = blockLines.join('\n') + '\n';

  // The separator between any pre-existing content and our block is written as
  // part of the block, so removing the block takes the separator with it and
  // leaves the original content untouched.
  const strippedText = replacedEmptyList
    ? text.replace(/^\s*\[\s*\]\s*$/m, '').replace(/[ \t]+$/, '').replace(/\n+$/, '')
    : text.replace(/[ \t]+$/, '').replace(/\n+$/, '');
  const next = (strippedText ? strippedText + '\n\n' : '') + block;

  fs.writeFileSync(patchFile, next);
  console.log(`dsh-cua-setup: wrote the ${SERVER_ID} row to ${patchFile}`);
  console.log(`  server : ${SERVER_JS}`);
  console.log(`  cwd    : ${PKG_ROOT}`);
  console.log('');
  console.log('Next steps:');
  console.log('  1. Grant Accessibility: System Settings > Privacy & Security > Accessibility');
  console.log('     -> add and enable DSH Desktop');
  console.log('  2. Restart or reload the harness');
  console.log(`  3. The agent should now see mcp__${SERVER_NAME}__js`);
}

if (require.main === module) {
  main();
}

// Exported so the patch-editing logic can be tested directly rather than only
// through its side effects on a profile file.
module.exports = {
  extractInsertBlocks,
  hasOurRow,
  stripOurBlock,
  buildRow,
  findDshHome,
  SERVER_ID,
  SERVER_NAME,
  OUR_BANNER_PREFIX,
  BLOCK_HEADER,
};