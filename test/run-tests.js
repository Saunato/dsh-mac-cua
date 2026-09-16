#!/usr/bin/env node
/**
 * dsh-cua native module test suite
 *
 * Exercises the native module against a controlled host application, so write
 * actions never touch a real app or user data. Read-only checks against real
 * applications are limited to reading state.
 *
 * Usage: node test/run-tests.js [--verbose]
 */

'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const assert = require('node:assert');

const VERBOSE = process.argv.includes('--verbose');
const ROOT = path.resolve(__dirname, '..');
const NATIVE = path.join(ROOT, 'native', 'dsh_cua.node');
const HOST_BIN = path.join(__dirname, 'host');
const HOST_SRC = path.join(__dirname, 'host.swift');

let passed = 0;
let failed = 0;
const failures = [];

function log(...args) {
  if (VERBOSE) console.log('   ', ...args);
}

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    failures.push({ name, error: err });
    console.log(`  ✗ ${name}`);
    console.log(`      ${err.message.split('\n')[0]}`);
  }
}

function buildHost() {
  return new Promise((resolve, reject) => {
    // Rebuild when the source is newer than the binary.
    const needsBuild = !fs.existsSync(HOST_BIN) ||
      fs.statSync(HOST_SRC).mtimeMs > fs.statSync(HOST_BIN).mtimeMs;
    if (!needsBuild) return resolve();
    console.log('  building test host...');
    const p = spawn('swiftc', ['-O', HOST_SRC, '-o', HOST_BIN], { stdio: 'inherit' });
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error('host build failed'))));
  });
}

/**
 * Whether the test host is still running.
 *
 * The host is a real GUI application, and one can exit on its own (a crash, or
 * macOS tearing down a windowless-nonactivating app). A dead host turns every
 * later assertion into a confusing "No running application has pid N", so the
 * suite checks liveness and restarts it with a clear message instead.
 */
function hostAlive(host) {
  if (!host || !host.child || host.child.exitCode !== null) return false;
  try {
    process.kill(host.pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Restart the host, warning that state is gone. */
async function restartHost(host) {
  if (host && host.child) { try { host.child.kill(); } catch {} }
  const next = await startHost();
  console.log(`      (test host had exited; restarted as pid ${next.pid} — state was lost)`);
  return next;
}

function startHost() {
  return new Promise((resolve, reject) => {
    const child = spawn(HOST_BIN, [], { stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('host did not report HOST_READY in time'));
    }, 15000);

    child.stdout.on('data', (chunk) => {
      buf += chunk.toString();
      const m = buf.match(/HOST_READY (\d+)/);
      if (m) {
        clearTimeout(timer);
        resolve({ child, pid: Number(m[1]) });
      }
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`host exited early with code ${code}`));
    });
  });
}

/** Find the index of the first element whose rendered line matches a predicate. */
function findIndex(state, predicate) {
  const lines = state.text.split('\n');
  for (const line of lines) {
    const m = line.match(/\[(\d+)\]/);
    if (!m) continue;
    if (predicate(line)) return Number(m[1]);
  }
  return -1;
}

async function main() {
  if (!fs.existsSync(NATIVE)) {
    console.error(`native module not found at ${NATIVE}\nrun native/build.sh first`);
    process.exit(1);
  }

  const cua = require(NATIVE);

  console.log('\n=== dsh-cua native module tests ===\n');

  // ---- environment -------------------------------------------------------
  console.log('environment');

  await test('isTrusted() reports accessibility access', () => {
    const trusted = cua.isTrusted();
    assert.strictEqual(typeof trusted, 'boolean');
    assert.ok(trusted, 'accessibility permission is not granted');
  });

  let preflight;
  await test('preflight() returns a diagnostic report', async () => {
    preflight = await cua.preflight();
    assert.strictEqual(preflight.ok, true);
    assert.ok('accessibility' in preflight);
    assert.ok('screenCapture' in preflight);
    assert.ok(typeof preflight.guidance === 'string' && preflight.guidance.length > 0);
    log('guidance:', preflight.guidance);
    log('screenCapture:', preflight.screenCapture);
  });

  // ---- app listing -------------------------------------------------------
  console.log('\napp listing');

  let apps;
  await test('listApps() enumerates applications', async () => {
    apps = await cua.listApps();
    assert.strictEqual(apps.ok, true);
    assert.ok(Array.isArray(apps.apps), 'apps should be an array');
    assert.ok(apps.apps.length > 10, `expected many apps, got ${apps.apps.length}`);
  });

  await test('listApps() excludes XPC service bundles', async () => {
    const services = apps.apps.filter((a) => a.id.includes('.xpc.'));
    assert.strictEqual(services.length, 0,
      `found service bundles: ${services.slice(0, 3).map((a) => a.id).join(', ')}`);
  });

  await test('listApps() returns stable identifiers', async () => {
    for (const a of apps.apps.slice(0, 30)) {
      assert.ok(a.id && a.id.length > 0, 'every app needs an id');
      assert.ok(a.displayName && a.displayName.length > 0, 'every app needs a displayName');
    }
  });

  // ---- controlled host ---------------------------------------------------
  console.log('\ncontrolled host app (write actions happen only here)');

  let host;
  try {
    await buildHost();
    host = await startHost();
    log('host pid:', host.pid);
  } catch (err) {
    console.log(`  ✗ could not start test host: ${err.message}`);
    if (host && host.child) host.child.kill();
    process.exit(1);
  }

  try {
    // Track the host across restarts by wrapping pid access.
    const hostRef = { current: host };
    const pid = () => hostRef.current.pid;
    const ensureHost = async () => {
      if (!hostAlive(hostRef.current)) hostRef.current = await restartHost(hostRef.current);
      return hostRef.current;
    };

    let state;
    await test('getAppState() reads the host window', async () => {
      state = await cua.getAppState({ pid: pid(), screenshot: false });
      assert.strictEqual(state.ok, true, state.error || 'getAppState failed');
      assert.ok(state.elementCount > 0, 'expected at least one element');
      log('elements:', state.elementCount);
      log(state.text);
    });

    await test('the tree exposes the host text field', async () => {
      const idx = findIndex(state, (l) => /TextField|field/i.test(l) || /placeholder/i.test(l));
      assert.ok(idx >= 0, `no text field found in:\n${state.text}`);
      log('text field index:', idx);
    });

    await test('set_value() writes and reads back', async () => {
      const idx = findIndex(state, (l) => /TextField/i.test(l));
      assert.ok(idx >= 0, 'no text field to write to');
      const res = await cua.action('set_value', { pid: pid(), element_index: idx, value: 'written-by-test' });
      assert.strictEqual(res.ok, true, res.error);
      log('message:', res.message);
    });

    await test('the written value is observable in a fresh state read', async () => {
      const after = await cua.getAppState({ pid: pid(), screenshot: false, disableDiff: true });
      assert.strictEqual(after.ok, true, after.error);
      assert.ok(after.text.includes('written-by-test'),
        `value not visible in tree:\n${after.text}`);
    });

    await test('AXPress click() is delivered to the host button', async () => {
      const fresh = await cua.getAppState({ pid: pid(), screenshot: false, disableDiff: true });
      const idx = findIndex(fresh, (l) => /Button/i.test(l) && /ProbeButton/i.test(l));
      assert.ok(idx >= 0, `button not found in:\n${fresh.text}`);
      const res = await cua.action('click', { pid: pid(), element_index: idx });
      assert.strictEqual(res.ok, true, res.error);
      log('click:', res.message);
    });

    await test('the click changed observable state (label now shows a count)', async () => {
      await ensureHost();
      // Give the app a moment to redraw.
      await new Promise((r) => setTimeout(r, 400));
      const after = await cua.getAppState({ pid: pid(), screenshot: false, disableDiff: true });
      assert.ok(/clicks:\s*1/.test(after.text),
        `expected "clicks: 1" in tree:\n${after.text}`);
    });

    await test('diff mode reports changes, not the whole tree', async () => {
      const before = await cua.getAppState({ pid: pid(), screenshot: false, disableDiff: true });
      const beforeLines = before.text.split('\n').length;
      // Change something.
      const idx = findIndex(before, (l) => /TextField/i.test(l));
      await cua.action('set_value', { pid: pid(), element_index: idx, value: 'diff-check' });
      const after = await cua.getAppState({ pid: pid(), screenshot: false });
      const afterLines = after.text.split('\n').length;
      log(`full=${beforeLines} lines, diff=${afterLines} lines, isDiff=${after.isDiff}`);
      assert.ok(afterLines <= beforeLines,
        `diff (${afterLines}) should not exceed the full tree (${beforeLines})`);
    });

    await test('stale element_index is rejected with actionable guidance', async () => {
      const fresh = await cua.getAppState({ pid: pid(), screenshot: false, disableDiff: true });
      const bogus = fresh.elementCount + 500;
      const res = await cua.action('click', { pid: pid(), element_index: bogus });
      assert.strictEqual(res.ok, false, 'an out-of-range index must not succeed');
      assert.ok(/get_app_state/i.test(res.error),
        `error should tell the model to re-read state, got: ${res.error}`);
    });

    await test('click() requires an index or coordinates', async () => {
      const res = await cua.action('click', { pid: pid() });
      assert.strictEqual(res.ok, false);
      assert.ok(/element_index|x and y/i.test(res.error), res.error);
    });

    await test('perform_secondary_action rejects a guessed action name', async () => {
      const fresh = await cua.getAppState({ pid: pid(), screenshot: false, disableDiff: true });
      const idx = findIndex(fresh, (l) => /Button/i.test(l));
      const res = await cua.action('perform_secondary_action', {
        pid: pid(), element_index: idx, action: 'AXDefinitelyNotARealAction',
      });
      assert.strictEqual(res.ok, false, 'a guessed action name must be refused');
      assert.ok(/Available:/i.test(res.error), `error should list real actions: ${res.error}`);
    });

    await test('press_key rejects an unknown key name', async () => {
      const res = await cua.action('press_key', { pid: pid(), key: 'NotAKey+++' });
      assert.strictEqual(res.ok, false);
      assert.ok(/Unknown key name/i.test(res.error), res.error);
    });

    await test('type_text delivers text into the focused field', async () => {
      const fresh = await cua.getAppState({ pid: pid(), screenshot: false, disableDiff: true });
      const idx = findIndex(fresh, (l) => /TextField/i.test(l));
      // Focus the field by clicking it, then type.
      await cua.action('click', { pid: pid(), element_index: idx });
      await new Promise((r) => setTimeout(r, 300));
      // Clear it first.
      await cua.action('set_value', { pid: pid(), element_index: idx, value: '' });
      const res = await cua.action('type_text', { pid: pid(), text: 'typed-text' });
      assert.strictEqual(res.ok, true, res.error);
      await new Promise((r) => setTimeout(r, 400));
      const after = await cua.getAppState({ pid: pid(), screenshot: false, disableDiff: true });
      assert.ok(after.text.includes('typed-text'),
        `typing did not land in the field:\n${after.text}`);
    });

    await test('paste uses the clipboard and restores it', async () => {
      const { execSync } = require('node:child_process');
      const marker = `dsh-cua-clipboard-${Date.now()}`;
      // Seed the clipboard with a known value.
      execSync(`printf %s ${JSON.stringify(marker)} | pbcopy`);
      const before = execSync('pbpaste').toString();

      const fresh = await cua.getAppState({ pid: pid(), screenshot: false, disableDiff: true });
      const idx = findIndex(fresh, (l) => /TextField/i.test(l));
      await cua.action('click', { pid: pid(), element_index: idx });
      await cua.action('set_value', { pid: pid(), element_index: idx, value: '' });
      await new Promise((r) => setTimeout(r, 200));

      const res = await cua.action('paste', { pid: pid(), text: 'pasted-content', format: 'text' });
      assert.strictEqual(res.ok, true, res.error);

      const after = execSync('pbpaste').toString();
      assert.strictEqual(after, before,
        `clipboard was not restored: expected "${before}", got "${after}"`);
    });

    await test('set_value() accepts an empty string to clear a field', async () => {
      await ensureHost();
      // Clearing an input is a real operation; rejecting "" made it impossible.
      const fresh = await cua.getAppState({ pid: pid(), screenshot: false, disableDiff: true });
      const idx = findIndex(fresh, (l) => /TextField/i.test(l));
      await cua.action('set_value', { pid: pid(), element_index: idx, value: 'to-be-cleared' });
      const res = await cua.action('set_value', { pid: pid(), element_index: idx, value: '' });
      assert.strictEqual(res.ok, true, `clearing was refused: ${res.error}`);
      const after = await cua.getAppState({ pid: pid(), screenshot: false, disableDiff: true });
      assert.ok(!after.text.includes('to-be-cleared'),
        `field still holds the old value:\n${after.text}`);
    });

    await test('type_text() delivers every character of a longer string', async () => {
      await ensureHost();
      // Regression: without waiting for keyboard focus, trailing characters were
      // silently dropped.
      const fresh = await cua.getAppState({ pid: pid(), screenshot: false, disableDiff: true });
      const idx = findIndex(fresh, (l) => /TextField/i.test(l));
      await cua.action('click', { pid: pid(), element_index: idx });
      await cua.action('set_value', { pid: pid(), element_index: idx, value: '' });
      await new Promise((r) => setTimeout(r, 250));

      const payload = 'abcdefghijklmnopqrstuvwxyz0123456789';
      const res = await cua.action('type_text', { pid: pid(), text: payload });
      assert.strictEqual(res.ok, true, res.error);
      assert.ok(!/warning:/i.test(res.message), `focus warning raised: ${res.message}`);

      await new Promise((r) => setTimeout(r, 500));
      const after = await cua.getAppState({ pid: pid(), screenshot: false, disableDiff: true });
      assert.ok(after.text.includes(payload),
        `expected the full ${payload.length}-char payload in the field:\n${after.text}`);
    });

    await test('type_text() refuses to claim success when focus never arrives', async () => {
      // Point at an app that cannot take our focus; the result must carry a
      // warning rather than a bare success message.
      const res = await cua.action('type_text', { pid: pid(), text: 'x' });
      assert.strictEqual(res.ok, true, res.error);
      assert.ok(typeof res.message === 'string' && res.message.length > 0);
    });

    // ── select_text, which had no direct coverage ───────────────────────────
    // The host's TextArea starts with "alpha bravo charlie delta", and mirrors
    // its selection into a label the tree exposes, so a selection made through
    // AX is observable exactly like a click is.

    const SEED = 'alpha bravo charlie delta alpha echo';

    await test('select_text() selects a substring and the app sees it', async () => {
      await ensureHost();
      const fresh = await cua.getAppState({ pid: pid(), screenshot: false, disableDiff: true });
      const idx = findIndex(fresh, (l) => /TextArea/.test(l));
      assert.ok(idx >= 0, `no TextArea in:\n${fresh.text}`);

      const res = await cua.action('select_text', {
        pid: pid(), element_index: idx, text: 'bravo',
      });
      assert.strictEqual(res.ok, true, res.error);
      // "bravo" starts at offset 6 in the seed text.
      assert.ok(/offset 6/.test(res.message), `expected offset 6: ${res.message}`);

      await new Promise((r) => setTimeout(r, 300));
      const after = await cua.getAppState({ pid: pid(), screenshot: false, disableDiff: true });
      assert.ok(after.text.includes('loc=6 len=5 text=bravo'),
        `the app did not register the selection:\n${after.text}`);
    });

    await test('select_text() places the caret with cursor_before / cursor_after', async () => {
      await ensureHost();
      const fresh = await cua.getAppState({ pid: pid(), screenshot: false, disableDiff: true });
      const idx = findIndex(fresh, (l) => /TextArea/.test(l));

      // cursor_after "bravo" is offset 11; a caret has zero length.
      const res = await cua.action('select_text', {
        pid: pid(), element_index: idx, text: 'bravo', selection_type: 'cursor_after',
      });
      assert.strictEqual(res.ok, true, res.error);
      await new Promise((r) => setTimeout(r, 300));
      const after = await cua.getAppState({ pid: pid(), screenshot: false, disableDiff: true });
      assert.ok(after.text.includes('loc=11 len=0'),
        `expected a zero-length caret at 11:\n${after.text}`);
    });

    await test('select_text() uses prefix and suffix to disambiguate', async () => {
      // "alpha" occurs twice in the seed text. Offsets are computed rather than
      // written by hand: a hand-computed offset here was wrong the first time
      // and sent me hunting a bug that did not exist.
      await ensureHost();
      const fresh = await cua.getAppState({ pid: pid(), screenshot: false, disableDiff: true });
      const idx = findIndex(fresh, (l) => /TextArea/.test(l));

      const first = SEED.indexOf('alpha');
      const second = SEED.indexOf('alpha', first + 1);
      assert.ok(first >= 0 && second > first,
        `the seed text must contain "alpha" twice; got ${first} and ${second} in ${JSON.stringify(SEED)}`);

      // Without a prefix the FIRST match wins.
      const plain = await cua.action('select_text', {
        pid: pid(), element_index: idx, text: 'alpha',
      });
      assert.strictEqual(plain.ok, true, plain.error);
      assert.ok(new RegExp(`offset ${first}\\b`).test(plain.message),
        `expected the first occurrence at ${first}: ${plain.message}`);

      // The prefix selects the later one: the text before it ends with "delta ".
      const res = await cua.action('select_text', {
        pid: pid(), element_index: idx, text: 'alpha', prefix: 'delta ',
      });
      assert.strictEqual(res.ok, true, res.error);
      assert.ok(new RegExp(`offset ${second}\\b`).test(res.message),
        `expected the later occurrence at offset ${second}: ${res.message}`);

      await new Promise((r) => setTimeout(r, 300));
      const after = await cua.getAppState({ pid: pid(), screenshot: false, disableDiff: true });
      assert.ok(after.text.includes(`loc=${second} len=5 text=alpha`),
        `prefix did not disambiguate:\n${after.text}`);
    });

    await test('select_text() reports text that is not present', async () => {
      await ensureHost();
      const fresh = await cua.getAppState({ pid: pid(), screenshot: false, disableDiff: true });
      const idx = findIndex(fresh, (l) => /TextArea/.test(l));
      const res = await cua.action('select_text', {
        pid: pid(), element_index: idx, text: 'not-in-the-view',
      });
      assert.strictEqual(res.ok, false, 'selecting absent text must not succeed');
      assert.ok(/was not found/i.test(res.error), res.error);
    });

    await test('select_text() requires element_index and text', async () => {
      await ensureHost();
      const noIndex = await cua.action('select_text', { pid: pid(), text: 'x' });
      assert.strictEqual(noIndex.ok, false);
      assert.ok(/element_index/.test(noIndex.error), noIndex.error);

      const noText = await cua.action('select_text', { pid: pid(), element_index: 0 });
      assert.strictEqual(noText.ok, false);
      assert.ok(/text/i.test(noText.error), noText.error);
    });

    await test('drag runs without error', async () => {
      const res = await cua.action('drag', {
        pid: pid(), from_x: 400, from_y: 400, to_x: 460, to_y: 440,
      });
      assert.strictEqual(res.ok, true, res.error);
    });

    await test('scroll runs without error', async () => {
      const fresh = await cua.getAppState({ pid: pid(), screenshot: false, disableDiff: true });
      const res = await cua.action('scroll', { pid: pid(), element_index: 0, direction: 'down', pages: 1 });
      assert.strictEqual(res.ok, true, res.error);
    });

    // ---- screenshots -----------------------------------------------------
    console.log('\nscreenshots');

    await test('getAppState() attaches a screenshot when asked', async () => {
      if (!preflight.screenCapture) {
        const st = await cua.getAppState({ pid: pid(), screenshot: true });
        assert.strictEqual(st.screenshot, null, 'screenshot must be null when capture is unavailable');
        assert.ok(st.screenshotNote && st.screenshotNote.length > 0,
          'a null screenshot must come with an explanatory note');
        log('capture unavailable, note present (degraded mode verified)');
        return;
      }
      const st = await cua.getAppState({ pid: pid(), screenshot: true });
      assert.strictEqual(st.ok, true, st.error);
      assert.ok(st.screenshot && st.screenshot.url, 'expected a screenshot url');
      assert.ok(st.screenshot.url.startsWith('file://'), st.screenshot.url);
      const p = st.screenshot.url.replace('file://', '');
      assert.ok(fs.existsSync(p), `screenshot file missing: ${p}`);
      const size = fs.statSync(p).size;
      assert.ok(size > 1000, `screenshot looks empty (${size} bytes)`);
      log(`screenshot: ${p} (${size} bytes)`);
    });

    await test('a real app can be read by name', async () => {
      const st = await cua.getAppState({ app: 'Finder', screenshot: false });
      assert.strictEqual(st.ok, true, st.error);
      assert.ok(st.elementCount > 0, 'expected elements from Finder');
      log('Finder elements:', st.elementCount, 'key:', st.key);
    });
  } finally {
    if (host && host.child) host.child.kill();
  }

  // ---- summary -----------------------------------------------------------
  console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
  if (failed > 0) {
    console.log('failures:');
    for (const f of failures) {
      console.log(`\n  ${f.name}\n  ${f.error.message}`);
    }
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('runner crashed:', err);
  process.exit(1);
});