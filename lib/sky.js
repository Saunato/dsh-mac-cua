/**
 * dsh-cua — the `sky` API
 *
 * Mirrors the reference Computer Use API surface one-for-one: the same method
 * names, the same snake_case parameter names, the same return shapes. Prompts and
 * instincts written against that API transfer to this module unchanged.
 *
 * Everything is backed by the native accessibility module; nothing here uses
 * AppleScript, osascript, JXA or System Events.
 */

'use strict';

const path = require('node:path');
const fs = require('node:fs');

let native = null;

/**
 * Load the compiled native module.
 *
 * The candidate list covers both layouts this package runs in, because they
 * differ:
 *   - source tree:   lib/sky.js   + native/dsh_cua.node
 *   - npm install:   lib/sky.js   + lib/dsh_cua.node   (npm flattens bins and
 *                    native dirs are not guaranteed to survive bundling)
 *
 * The error message names the fix, because a failed native load otherwise
 * surfaces as a bare "module not found".
 */
function loadNative() {
  if (native) return native;
  const candidates = [
    process.env.DSH_CUA_NATIVE,
    path.join(__dirname, 'dsh_cua.node'),
    path.join(__dirname, '..', 'native', 'dsh_cua.node'),
    path.join(__dirname, '..', '..', 'native', 'dsh_cua.node'),
  ].filter(Boolean);

  const tried = [];
  for (const candidate of candidates) {
    tried.push(candidate);
    if (!fs.existsSync(candidate)) continue;
    try {
      native = require(candidate);
      resolvedPath = candidate;
      return native;
    } catch (err) {
      throw new Error(
        `Found the dsh-cua native module at ${candidate} but could not load it: ${err.message}\n` +
        `Rebuild it with: node ${path.join(__dirname, '..', 'scripts', 'build-native.js')}`
      );
    }
  }
  throw new Error(
    'The dsh-cua native module is not built, or was built for a different platform.\n' +
    `Looked in:\n  ${tried.join('\n  ')}\n` +
    `Build it with: node ${path.join(__dirname, '..', 'scripts', 'build-native.js')}`
  );
}

/** Where the native module was loaded from, for diagnostics. */
let resolvedPath = null;
function nativePath() {
  loadNative();
  return resolvedPath;
}

/** Normalise errors so callers get a single readable message. */
function fail(result) {
  const message = result && result.error ? result.error : 'dsh-cua operation failed';
  const err = new Error(message);
  err.code = result && result.code ? result.code : 'DSH_CUA_ERROR';
  throw err;
}

const ACTIONS = new Set([
  'click', 'drag', 'scroll', 'press_key', 'type_text', 'paste',
  'set_value', 'select_text', 'perform_secondary_action', 'screenshot',
]);

async function call(name, params) {
  const mod = loadNative();
  const payload = params == null ? {} : params;
  const result = await mod.action(name, JSON.stringify(payload));
  if (!result || !result.ok) fail(result);
  return result;
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

const sky = {
  target: 'mac',

  /**
   * Read an application's accessibility tree, and optionally a screenshot.
   *
   * Every call publishes a fresh element index map. Indices from an earlier call
   * are invalid afterwards, which is why the workflow is always
   * act → get_app_state → act.
   */
  async get_app_state({ app, disableDiff, screenshot } = {}) {
    if (app == null) throw new Error('get_app_state requires { app }');
    const mod = loadNative();
    const params = { app: String(app) };
    if (disableDiff === true) params.disableDiff = true;
    if (screenshot === false) params.screenshot = false;
    const result = await mod.getAppState(params);
    if (!result || !result.ok) fail(result);
    return result;
  },

  /** Enumerate launchable applications. */
  async list_apps() {
    const mod = loadNative();
    const result = await mod.listApps();
    if (!result || !result.ok) fail(result);
    return result.apps;
  },

  /** Click an accessibility element, or a coordinate when no element exists. */
  async click({ app, element_index, x, y, mouse_button, click_count } = {}) {
    if (app == null) throw new Error('click requires { app }');
    const params = { app: String(app) };
    if (element_index != null) params.element_index = element_index;
    if (x != null) params.x = x;
    if (y != null) params.y = y;
    if (mouse_button != null) params.mouse_button = mouse_button;
    if (click_count != null) params.click_count = click_count;
    return (await call('click', params)).message;
  },

  async drag({ app, from_x, from_y, to_x, to_y } = {}) {
    if (app == null) throw new Error('drag requires { app }');
    return (await call('drag', { app: String(app), from_x, from_y, to_x, to_y })).message;
  },

  async scroll({ app, element_index, x, y, direction, pages } = {}) {
    if (app == null) throw new Error('scroll requires { app }');
    const params = { app: String(app), direction: direction || 'down' };
    if (element_index != null) params.element_index = element_index;
    if (x != null) params.x = x;
    if (y != null) params.y = y;
    if (pages != null) params.pages = pages;
    return (await call('scroll', params)).message;
  },

  /** Press a key or chord: "a", "Return", "Tab", "super+c", "Up", "KP_0". */
  async press_key({ app, key } = {}) {
    if (app == null) throw new Error('press_key requires { app }');
    if (!key) throw new Error('press_key requires { key }');
    return (await call('press_key', { app: String(app), key })).message;
  },

  async type_text({ app, text } = {}) {
    if (app == null) throw new Error('type_text requires { app }');
    return (await call('type_text', { app: String(app), text: text == null ? '' : String(text) })).message;
  },

  /** Paste via the clipboard, restoring the user's previous clipboard contents. */
  async paste({ app, text, format } = {}) {
    if (app == null) throw new Error('paste requires { app }');
    const params = { app: String(app), text: text == null ? '' : String(text), format: format || 'text' };
    return (await call('paste', params)).message;
  },

  async set_value({ app, element_index, value } = {}) {
    if (app == null) throw new Error('set_value requires { app }');
    if (element_index == null) throw new Error('set_value requires { element_index }');
    return (await call('set_value', {
      app: String(app), element_index, value: value == null ? '' : String(value),
    })).message;
  },

  async select_text({ app, element_index, text, prefix, suffix, selection_type } = {}) {
    if (app == null) throw new Error('select_text requires { app }');
    if (element_index == null) throw new Error('select_text requires { element_index }');
    const params = { app: String(app), element_index, text };
    if (prefix != null) params.prefix = prefix;
    if (suffix != null) params.suffix = suffix;
    if (selection_type != null) params.selection_type = selection_type;
    return (await call('select_text', params)).message;
  },

  /** Invoke an accessibility action the element actually exposes. */
  async perform_secondary_action({ app, element_index, action } = {}) {
    if (app == null) throw new Error('perform_secondary_action requires { app }');
    if (element_index == null) throw new Error('perform_secondary_action requires { element_index }');
    if (!action) throw new Error('perform_secondary_action requires { action }');
    return (await call('perform_secondary_action', {
      app: String(app), element_index, action,
    })).message;
  },

  /** Capture the full desktop. */
  async get_screenshot() {
    const result = await call('screenshot', {});
    return { url: result.url, note: result.note || null };
  },
};

/** Permission self-check. */
async function preflight() {
  const mod = loadNative();
  const result = await mod.preflight();
  if (!result || !result.ok) fail(result);
  return result;
}

/** Whether accessibility access is granted. */
function isTrusted() {
  return loadNative().isTrusted();
}

module.exports = { sky, preflight, isTrusted, nativePath, ACTIONS };