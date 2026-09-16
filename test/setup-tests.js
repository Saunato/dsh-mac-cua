#!/usr/bin/env node
/**
 * dsh-cua setup-script tests
 *
 * The setup command edits a user's profile patch file, which is shared with
 * every other plugin they have installed. A bug here silently damages someone
 * else's configuration, so these tests focus on one property above all:
 * installing and then removing leaves the file byte-for-byte as it was found.
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const assert = require('node:assert');

const SETUP = path.resolve(__dirname, '..', 'scripts', 'setup.js');
const S = require(SETUP);

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    failures.push({ name, error: err });
    console.log(`  ✗ ${name}`);
    console.log(`      ${String(err.message).split('\n')[0]}`);
  }
}

let tmpRoot = null;

/** Create a throwaway DSH home with a web profile carrying `content`. */
function makeHome(content) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-cua-setup-'));
  const profile = path.join(home, 'profiles', 'web');
  fs.mkdirSync(profile, { recursive: true });
  const patch = path.join(profile, 'cordis.patch.yml');
  fs.writeFileSync(patch, content);
  return { home, patch };
}

function runSetup(args) {
  const r = spawnSync(process.execPath, [SETUP, ...args], { encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

/**
 * Run the explicit-write path.
 *
 * Writing a profile row is deliberately not the default any more: the package
 * mounts its own MCP server through `dsh.bundle`, so an install needs no
 * configuration and a bare `dsh-cua-setup` now reports status instead of
 * editing files. These tests cover the explicit path, which still exists for
 * manual installs.
 */
function runWrite(args) {
  return runSetup(['--write', ...args]);
}

function roundtrip(original) {
  const { home, patch } = makeHome(original);
  runWrite(['--home', home]);
  const afterInstall = fs.readFileSync(patch, 'utf8');
  runSetup(['--home', home, '--remove']);
  const afterRemove = fs.readFileSync(patch, 'utf8');
  return { afterInstall, afterRemove, patch };
}

function main() {
  console.log('\n=== dsh-cua setup script tests ===\n');

  console.log('patch editing');

  test('install adds the row', () => {
    const { afterInstall } = roundtrip('[]\n');
    assert.ok(afterInstall.includes('- id: mcp-cua'), afterInstall);
    assert.ok(afterInstall.includes('serverName: cua_repl'), afterInstall);
  });

  test('install then remove restores files with real content byte-for-byte', () => {
    // This is the property that protects a user's other plugins.
    for (const original of [
      '# a comment\n- insert:\n    - id: other\n      name: x\n',
      '- insert:\n    - id: other\n      name: x\n',
    ]) {
      const { afterRemove } = roundtrip(original);
      assert.strictEqual(afterRemove, original,
        `roundtrip changed the file.\n  was: ${JSON.stringify(original)}\n  now: ${JSON.stringify(afterRemove)}`);
    }
  });

  test('a comment-only overlay gains a list, because it was not loadable', () => {
    // A file containing only comments fails the boot outright: the loader
    // requires a top-level YAML array. Removal restores `[]` rather than the
    // original text, which turns an unbootable profile into a valid one.
    const { afterRemove } = roundtrip('# only a comment, no list\n');
    assert.ok(afterRemove.includes('# only a comment, no list'), afterRemove);
    assert.deepStrictEqual(
      afterRemove.split('\n').filter((l) => l.trim() !== '' && !l.trim().startsWith('#')),
      ['[]'],
      afterRemove);
  });

  test('an empty-list profile round-trips to an equivalent profile', () => {
    // An install replaces `[]` with the row, so removal reconstructs the empty
    // list rather than restoring it byte-for-byte. Both forms parse identically,
    // so the profile stays valid; assert equivalence rather than exact bytes.
    for (const original of ['[]\n', '# a comment\n[]\n', '# a comment\n\n[]\n']) {
      const { afterRemove } = roundtrip(original);
      const meaningful = afterRemove.split('\n').filter((l) => l.trim() !== '' && !l.trim().startsWith('#'));
      assert.deepStrictEqual(meaningful, ['[]'],
        `expected a lone empty list, got ${JSON.stringify(afterRemove)}`);
      if (original.includes('#')) {
        assert.ok(afterRemove.includes('# a comment'),
          `the comment was lost: ${JSON.stringify(afterRemove)}`);
      }
    }
  });

  test('an existing plugin row survives install and removal', () => {
    const original = [
      '# my profile',
      '- insert:',
      "    - id: another-plugin",
      "      name: 'other'",
      '      config:',
      '        keep: me',
      '',
    ].join('\n');
    const { afterInstall, afterRemove } = roundtrip(original);

    assert.ok(afterInstall.includes('keep: me'), 'the other plugin was damaged by install');
    assert.ok(afterInstall.includes('- id: mcp-cua'), 'our row was not added');
    assert.strictEqual(afterRemove, original,
      `removal damaged the file:\n${afterRemove}`);
  });

  test('a comment the user wrote above the list is preserved', () => {
    const { afterRemove } = roundtrip('# important note\n[]\n');
    assert.ok(afterRemove.includes('# important note'), afterRemove);
  });

  test('install is idempotent', () => {
    const { home, patch } = makeHome('[]\n');
    runWrite(['--home', home]);
    const first = fs.readFileSync(patch, 'utf8');
    const second = runWrite(['--home', home]);
    const after = fs.readFileSync(patch, 'utf8');

    assert.strictEqual(after, first, 'a second install changed the file');
    assert.ok(/already present/i.test(second.stdout), second.stdout);
    assert.strictEqual((after.match(/- id: mcp-cua/g) || []).length, 1,
      'the row was duplicated');
  });

  test('removal on a clean profile reports nothing to do', () => {
    const { home, patch } = makeHome('# nothing here\n[]\n');
    const before = fs.readFileSync(patch, 'utf8');
    const r = runSetup(['--home', home, '--remove']);
    assert.strictEqual(fs.readFileSync(patch, 'utf8'), before, 'the file changed');
    assert.ok(/nothing to remove/i.test(r.stdout), r.stdout);
  });

  test('removal never leaves a comment-only file the loader would reject', () => {
    // The loader requires a top-level YAML array; a file with only comments
    // fails the boot with "must be a top-level YAML array of loader patch
    // entries".
    const { home, patch } = makeHome('# a comment\n[]\n');
    runWrite(['--home', home]);
    runSetup(['--home', home, '--remove']);
    const after = fs.readFileSync(patch, 'utf8');
    const entries = after.split('\n').filter((l) => l.trim() !== '' && !l.trim().startsWith('#'));
    assert.deepStrictEqual(entries, ['[]'],
      `expected a lone empty list, got ${JSON.stringify(after)}`);
  });

  test('a second removal does not damage the file', () => {
    const { home, patch } = makeHome('[]\n');
    runWrite(['--home', home]);
    runSetup(['--home', home, '--remove']);
    const afterFirst = fs.readFileSync(patch, 'utf8');
    runSetup(['--home', home, '--remove']);
    assert.strictEqual(fs.readFileSync(patch, 'utf8'), afterFirst,
      'a repeated removal changed the file');
  });

  console.log('\ndetection and parsing');

  test('extractInsertBlocks finds rows and attributes ids', () => {
    const text = [
      '- insert:',
      '    - id: alpha',
      '      name: a',
      '- insert:',
      '    - id: beta',
      '      name: b',
    ].join('\n');
    const blocks = S.extractInsertBlocks(text);
    assert.deepStrictEqual(blocks.map((b) => b.id), ['alpha', 'beta']);
  });

  test('a bare id row is not mistaken for an insert block', () => {
    // A top-level `- id:` row is an override, not an insertion.
    const text = '- id: some-plugin\n  disabled: true\n';
    assert.deepStrictEqual(S.extractInsertBlocks(text), []);
    assert.strictEqual(S.hasOurRow(text), false);
  });

  test('hasOurRow ignores the id appearing only in a comment', () => {
    const text = '# mentions mcp-cua in prose\n[]\n';
    assert.strictEqual(S.hasOurRow(text), false);
  });

  test('the generated row nests under insert, as the loader requires', () => {
    const row = S.buildRow();
    assert.ok(row.startsWith('- insert:'), 'a bare - id: row would be rejected as an override');
    assert.ok(row.includes(`- id: ${S.SERVER_ID}`), row);
    assert.ok(row.includes('transport: stdio'), row);
    assert.ok(row.includes('failOnStartupError: false'), row);
  });

  test('the bundle patch never enables failOnStartupError', () => {
    // The bundle patch ships to every user, so this is the most important
    // assertion in the file: that setting is what turned a bad path into a
    // product-wide startup failure.
    const fs2 = require('node:fs');
    const path2 = require('node:path');
    const patch = fs2.readFileSync(path2.join(__dirname, '..', 'cordis.patch.yml'), 'utf8');
    const live = patch.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
    assert.ok(/failOnStartupError:\s*false/.test(live),
      'the bundle row must set failOnStartupError: false');
    assert.ok(!/failOnStartupError:\s*true/.test(live),
      'failOnStartupError: true lets the plugin kill the harness boot');
  });

  test('the bundle patch launches via the launcher script', () => {
    const fs2 = require('node:fs');
    const path2 = require('node:path');
    const patch = fs2.readFileSync(path2.join(__dirname, '..', 'cordis.patch.yml'), 'utf8');
    assert.ok(/serve\.js/.test(patch), patch);
  });

  test('the bundle patch is a loadable overlay', () => {
    const fs2 = require('node:fs');
    const path2 = require('node:path');
    const patch = fs2.readFileSync(path2.join(__dirname, '..', 'cordis.patch.yml'), 'utf8');
    // Must contain at least one top-level entry, or the loader rejects it.
    assert.ok(/^- insert:/m.test(patch), patch);
    assert.ok(/serverName:\s*cua_repl/.test(patch), patch);
  });

  test('the generated row sets failOnStartupError to false', () => {
    // Regression: with this true, a bad path took the whole harness down to the
    // safe-mode recovery screen. A plugin must not be able to block the boot.
    const row = S.buildRow();
    assert.ok(/failOnStartupError:\s*false/.test(row), row);
    assert.ok(!/failOnStartupError:\s*true/.test(row),
      'failOnStartupError must never be true: it lets a plugin kill the boot');
  });

  test('the generated row uses absolute paths for both command and cwd', () => {
    // Regression: relative paths do not resolve, because the harness spawns
    // stdio servers from the launch root rather than the profile directory.
    const row = S.buildRow();
    const args = row.match(/^\s+- '([^']+)'\s*$/m);
    const cwd = row.match(/^\s+cwd: '([^']+)'\s*$/m);
    assert.ok(args, `no args path in row:\n${row}`);
    assert.ok(cwd, `no cwd in row:\n${row}`);
    assert.ok(path.isAbsolute(args[1]), `args path must be absolute: ${args[1]}`);
    assert.ok(path.isAbsolute(cwd[1]), `cwd must be absolute: ${cwd[1]}`);
  });

  test('the generated row launches the launcher, not the server directly', () => {
    // The launcher resolves the package itself; pointing straight at server.js
    // was what broke when the working directory was not the package.
    const row = S.buildRow();
    assert.ok(/scripts\/serve\.js/.test(row), row);
  });

  test('the generated row declares the native module path explicitly', () => {
    // stdio children get a scrubbed environment, so anything the server needs
    // must be declared in `env`.
    const row = S.buildRow();
    assert.ok(/env:\s*\n\s+DSH_CUA_NATIVE:/.test(row), row);
  });

  console.log('\ncli behaviour');

  test('--status reports the install without changing anything', () => {
    const { home, patch } = makeHome('[]\n');
    const before = fs.readFileSync(patch, 'utf8');
    const r = runSetup(['--status', '--home', home]);
    const out = r.stdout + r.stderr;
    assert.ok(/accessibility/i.test(out), out);
    assert.ok(/profile/i.test(out), out);
    assert.ok(/dependency installed/i.test(out), out);
    assert.ok(/bundle layer/i.test(out), out);
    assert.strictEqual(fs.readFileSync(patch, 'utf8'), before, '--status modified the file');
  });

  test('--status says the server is not mounted when nothing installed it', () => {
    const { home } = makeHome('[]\n');
    const r = runSetup(['--status', '--home', home]);
    const out = r.stdout + r.stderr;
    assert.ok(/not installed|not mounted/i.test(out), out);
    assert.notStrictEqual(r.status, 0, 'a missing install should be a non-zero exit');
  });

  test('--status recognises an explicit row as mounted', () => {
    const { home } = makeHome('[]\n');
    runWrite(['--home', home]);
    const r = runSetup(['--status', '--home', home]);
    assert.ok(/explicit patch row\s*:\s*yes/i.test(r.stdout), r.stdout);
    assert.ok(/mounted/i.test(r.stdout), r.stdout);
  });

  test('the default action is status, not a write', () => {
    // Installing should not require configuring anything, so a bare invocation
    // must never edit the profile.
    const { home, patch } = makeHome('[]\n');
    const before = fs.readFileSync(patch, 'utf8');
    runSetup(['--home', home]);
    assert.strictEqual(fs.readFileSync(patch, 'utf8'), before,
      'a bare invocation modified the profile');
  });

  test('--print writes the row and changes nothing', () => {
    const { home, patch } = makeHome('[]\n');
    const before = fs.readFileSync(patch, 'utf8');
    const r = runSetup(['--home', home, '--print']);
    assert.strictEqual(r.status, 0);
    assert.ok(r.stdout.includes('- id: mcp-cua'), r.stdout);
    assert.strictEqual(fs.readFileSync(patch, 'utf8'), before, '--print modified the file');
  });

  test('a missing profile is reported without touching anything', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-cua-setup-'));
    fs.mkdirSync(path.join(home, 'profiles'), { recursive: true });
    const r = runWrite(['--home', home, '--profile', 'nope']);
    assert.notStrictEqual(r.status, 0, 'should fail');
    assert.ok(/not found/i.test(r.stderr + r.stdout), r.stderr + r.stdout);
  });

  console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
  if (failed > 0) {
    for (const f of failures) console.log(`\n  ${f.name}\n  ${f.error.message}`);
    process.exit(1);
  }
}

main();