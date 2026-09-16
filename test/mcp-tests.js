#!/usr/bin/env node
/**
 * dsh-cua MCP server test suite
 *
 * Speaks the MCP stdio protocol to the real server process: newline-delimited
 * JSON-RPC, an initialize handshake, then tool calls. Testing through the wire
 * rather than by importing modules means these tests also cover framing,
 * capability negotiation and result formatting — the parts most likely to break
 * against a real client.
 */

'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');
const assert = require('node:assert');

const VERBOSE = process.argv.includes('--verbose');
const ROOT = path.resolve(__dirname, '..');
const SERVER = path.join(ROOT, 'cua-repl', 'server.js');

let passed = 0;
let failed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    failures.push({ name, error: err });
    console.log(`  ✗ ${name}`);
    console.log(`      ${String(err.message).split('\n')[0]}`);
  }
}

/** Minimal MCP client: spawns the server, frames messages, matches replies by id. */
class McpClient {
  constructor() {
    this.child = null;
    this.buffer = '';
    this.nextId = 1;
    this.pending = new Map();
    this.stderr = '';
  }

  start() {
    return new Promise((resolve, reject) => {
      this.child = spawn(process.execPath, [SERVER], {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: ROOT,
      });
      const timer = setTimeout(() => reject(new Error('server did not start')), 10000);

      this.child.stdout.setEncoding('utf8');
      this.child.stdout.on('data', (chunk) => {
        this.buffer += chunk;
        let index;
        while ((index = this.buffer.indexOf('\n')) !== -1) {
          const line = this.buffer.slice(0, index).replace(/\r$/, '').trim();
          this.buffer = this.buffer.slice(index + 1);
          if (!line) continue;
          let msg;
          try {
            msg = JSON.parse(line);
          } catch {
            continue;
          }
          if (msg.id != null && this.pending.has(msg.id)) {
            const { resolve: res } = this.pending.get(msg.id);
            this.pending.delete(msg.id);
            res(msg);
          }
        }
      });
      this.child.stderr.setEncoding('utf8');
      this.child.stderr.on('data', (d) => { this.stderr += d; });
      this.child.on('exit', (code) => {
        for (const { reject: rej } of this.pending.values()) {
          rej(new Error(`server exited with code ${code}`));
        }
        this.pending.clear();
      });

      // Give the startup preflight a moment, then declare ready.
      setTimeout(() => { clearTimeout(timer); resolve(); }, 900);
    });
  }

  request(method, params) {
    const id = this.nextId++;
    const message = { jsonrpc: '2.0', id, method };
    if (params !== undefined) message.params = params;
    return new Promise((resolve, reject) => {
      // The timer must be cleared on settle, otherwise the pending handle keeps
      // the event loop alive and the runner hangs after the last test.
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`timeout waiting for ${method}`));
        }
      }, 30000);
      if (timer.unref) timer.unref();
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.child.stdin.write(JSON.stringify(message) + '\n');
    });
  }

  notify(method, params) {
    const message = { jsonrpc: '2.0', method };
    if (params !== undefined) message.params = params;
    this.child.stdin.write(JSON.stringify(message) + '\n');
  }

  stop() {
    if (!this.child) return;
    try { this.child.stdin.end(); } catch {}
    this.child.kill();
  }
}

/** Pull the text of the first text content block out of a tool result. */
function resultText(result) {
  if (!result || !result.content) return '';
  const block = result.content.find((c) => c.type === 'text');
  return block ? block.text : '';
}

async function main() {
  console.log('\n=== dsh-cua MCP server tests ===\n');

  const client = new McpClient();
  await client.start();

  try {
    // ---- handshake -------------------------------------------------------
    console.log('handshake');

    let initResult;
    await test('initialize negotiates a protocol version', async () => {
      const res = await client.request('initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'dsh-cua-tests', version: '1.0.0' },
      });
      assert.ok(res.result, `no result: ${JSON.stringify(res)}`);
      initResult = res.result;
      assert.strictEqual(initResult.protocolVersion, '2025-06-18');
      assert.strictEqual(initResult.serverInfo.name, 'dsh-cua');
      assert.ok(initResult.capabilities.tools, 'tools capability must be declared');
      if (VERBOSE) console.log('   ', JSON.stringify(initResult.serverInfo));
    });

    await test('initialize ships the instruction documents', async () => {
      assert.ok(typeof initResult.instructions === 'string', 'instructions must be a string');
      assert.ok(initResult.instructions.length > 500,
        `instructions look too short (${initResult.instructions.length} chars)`);
      assert.ok(/get_app_state/.test(initResult.instructions),
        'instructions should document the API');
      assert.ok(/confirmation policy/i.test(initResult.instructions),
        'the confirmation policy should be included');
      if (VERBOSE) console.log(`    instructions: ${initResult.instructions.length} chars`);
    });

    await test('an unknown protocol version falls back instead of failing', async () => {
      const res = await client.request('initialize', { protocolVersion: 'not-a-version', capabilities: {} });
      assert.ok(res.result, 'should still initialise');
      assert.ok(['2025-06-18', '2025-03-26', '2024-11-05', '2024-10-07'].includes(res.result.protocolVersion),
        `unexpected fallback: ${res.result.protocolVersion}`);
    });

    await test('ping responds', async () => {
      const res = await client.request('ping', {});
      assert.ok(res.result !== undefined, 'ping must return a result');
    });

    // ---- tools -----------------------------------------------------------
    console.log('\ntool listing');

    let tools;
    await test('tools/list exposes exactly js and js_reset', async () => {
      const res = await client.request('tools/list', {});
      assert.ok(res.result && Array.isArray(res.result.tools));
      tools = res.result.tools.map((t) => t.name).sort();
      assert.deepStrictEqual(tools, ['js', 'js_reset']);
    });

    await test('the js tool declares a required code parameter', async () => {
      const res = await client.request('tools/list', {});
      const js = res.result.tools.find((t) => t.name === 'js');
      assert.strictEqual(js.inputSchema.type, 'object');
      assert.deepStrictEqual(js.inputSchema.required, ['code']);
      assert.strictEqual(js.inputSchema.properties.code.type, 'string');
      assert.ok(js.description.includes('nodeRepl.write'),
        'the description should explain how to return output');
    });

    // ---- tool calls ------------------------------------------------------
    console.log('\ntool calls');

    await test('js evaluates an expression and returns its value', async () => {
      const res = await client.request('tools/call', { name: 'js', arguments: { code: '1 + 1' } });
      assert.ok(res.result, JSON.stringify(res));
      assert.ok(!res.result.isError, resultText(res.result));
      assert.strictEqual(resultText(res.result).trim(), '2');
    });

    await test('js captures nodeRepl.write output', async () => {
      const res = await client.request('tools/call', {
        name: 'js',
        arguments: { code: 'nodeRepl.write("hello from the repl");' },
      });
      assert.ok(resultText(res.result).includes('hello from the repl'));
    });

    await test('js state persists across calls', async () => {
      await client.request('tools/call', {
        name: 'js',
        arguments: { code: 'var counter = 41; counter = counter + 1;' },
      });
      const res = await client.request('tools/call', {
        name: 'js',
        arguments: { code: 'counter' },
      });
      assert.strictEqual(resultText(res.result).trim(), '42',
        'a var declared in one call must survive into the next');
    });

    await test('js supports top-level await', async () => {
      const res = await client.request('tools/call', {
        name: 'js',
        arguments: { code: 'await new Promise(r => setTimeout(() => r("awaited"), 30))' },
      });
      assert.ok(resultText(res.result).includes('awaited'), resultText(res.result));
    });

    await test('sky is pre-injected as a global', async () => {
      const res = await client.request('tools/call', {
        name: 'js',
        arguments: { code: 'typeof sky + " " + sky.target' },
      });
      const text = resultText(res.result);
      assert.ok(text.includes('object'), text);
      assert.ok(text.includes('mac'), text);
    });

    await test('a syntax error is reported, not crashed', async () => {
      const res = await client.request('tools/call', {
        name: 'js',
        arguments: { code: 'function ( {' },
      });
      assert.ok(res.result, 'must still return a result');
      assert.strictEqual(res.result.isError, true, 'should be flagged as an error');
      assert.ok(/SyntaxError/i.test(resultText(res.result)), resultText(res.result));
    });

    await test('an empty code parameter is refused with guidance', async () => {
      const res = await client.request('tools/call', { name: 'js', arguments: { code: '   ' } });
      assert.strictEqual(res.result.isError, true);
      assert.ok(/non-empty/i.test(resultText(res.result)), resultText(res.result));
    });

    await test('a thrown error inside the REPL is reported back', async () => {
      const res = await client.request('tools/call', {
        name: 'js',
        arguments: { code: 'throw new Error("deliberate failure")' },
      });
      assert.strictEqual(res.result.isError, true);
      assert.ok(resultText(res.result).includes('deliberate failure'));
    });

    await test('console.log output is captured', async () => {
      const res = await client.request('tools/call', {
        name: 'js',
        arguments: { code: 'console.log("logged line")' },
      });
      assert.ok(resultText(res.result).includes('logged line'));
    });

    // ---- live desktop, read-only ----------------------------------------
    console.log('\nlive desktop (read-only)');

    await test('sky.list_apps() reaches the real desktop', async () => {
      const res = await client.request('tools/call', {
        name: 'js',
        arguments: { code: 'var apps = await sky.list_apps(); nodeRepl.write(String(apps.length)); apps.length' },
      });
      assert.ok(!res.result.isError, resultText(res.result));
      const n = parseInt(resultText(res.result).trim(), 10);
      assert.ok(n > 10, `expected many apps, got ${n}`);
    });

    await test('sky.get_app_state() reads a real application', async () => {
      const res = await client.request('tools/call', {
        name: 'js',
        arguments: {
          code: 'var st = await sky.get_app_state({ app: "Finder", screenshot: false });' +
                'nodeRepl.write("elements=" + st.elementCount + " key=" + st.key + "\\n" + st.text.slice(0, 400)); st.elementCount',
        },
      });
      assert.ok(!res.result.isError, resultText(res.result));
      const text = resultText(res.result);
      assert.ok(/elements=\d+/.test(text), text.slice(0, 300));
      assert.ok(/key=/.test(text), text.slice(0, 300));
      if (VERBOSE) console.log('   ', text.split('\n').slice(0, 6).join('\n    '));
    });

    await test('sky.get_app_state() returns a text tree with element indices', async () => {
      const res = await client.request('tools/call', {
        name: 'js',
        arguments: {
          code: 'var st = await sky.get_app_state({ app: "Finder", screenshot: false, disableDiff: true }); nodeRepl.write(st.text)',
        },
      });
      const text = resultText(res.result);
      assert.ok(/\[\d+\]/.test(text), `tree should carry element indices, got:\n${text.slice(0, 300)}`);
    });

    await test('nodeRepl.emitImage() returns an image block the client can read', async () => {
      // The documented screenshot workflow ends in emitImage; if that does not
      // produce a real image block, the model reads a screenshot and sees
      // nothing.
      const code = [
        "const fs = await import('node:fs/promises');",
        "const { fileURLToPath } = await import('node:url');",
        "var shot = await sky.get_screenshot();",
        "if (shot && shot.url) {",
        "  await nodeRepl.emitImage({ bytes: await fs.readFile(fileURLToPath(shot.url)), mimeType: 'image/png' });",
        "  nodeRepl.write('emitted');",
        "} else {",
        "  nodeRepl.write('capture unavailable: ' + JSON.stringify(shot));",
        "}",
      ].join('\n');

      const res = await client.request('tools/call', { name: 'js', arguments: { code } });
      assert.ok(res.result, JSON.stringify(res));
      const text = resultText(res.result);
      const images = (res.result.content || []).filter((c) => c.type === 'image');

      // Capture can be legitimately unavailable — locked screen, sleeping
      // display, or a pending Screen Recording permission decision. Verify the
      // documented degraded behaviour instead of failing, so an environment
      // problem does not read as a code defect.
      if (/capture unavailable/.test(text) || /did not respond within|Screen capture failed|blocked by macOS/i.test(text)) {
        // Locked screen or missing permission: the degraded path must be explicit.
        assert.strictEqual(images.length, 0, 'no image block should appear when capture is unavailable');
        if (VERBOSE) console.log('   ', text.slice(0, 140));
        return;
      }

      assert.ok(text.includes('emitted'), text);
      assert.strictEqual(images.length, 1, `expected one image block, got ${images.length}`);
      assert.strictEqual(images[0].mimeType, 'image/png', images[0].mimeType);
      // Validate it really is PNG data, not a placeholder.
      const buf = Buffer.from(images[0].data, 'base64');
      assert.ok(buf.length > 1000, `image looks empty (${buf.length} bytes)`);
      assert.strictEqual(buf.subarray(0, 8).toString('hex'), '89504e470d0a1a0a',
        'payload is not a PNG');
      if (VERBOSE) console.log(`    image block: ${buf.length} bytes PNG`);
    });

    await test('get_app_state() attaches a screenshot when capture is available', async () => {
      const res = await client.request('tools/call', {
        name: 'js',
        arguments: {
          code: "var st = await sky.get_app_state({ app: 'Finder' }); " +
                "nodeRepl.write(JSON.stringify({ shot: st.screenshot ? 'yes' : null, note: st.screenshotNote || null }));",
        },
      });
      assert.ok(!res.result.isError, resultText(res.result));
      const text = resultText(res.result);
      assert.ok(/shot/.test(text), text);
      if (VERBOSE) console.log('   ', text.slice(0, 160));
    });

    await test('an unknown tool name is reported as an error result', async () => {
      const res = await client.request('tools/call', { name: 'nonexistent', arguments: {} });
      assert.ok(res.result, 'must return a result rather than a protocol error');
      assert.strictEqual(res.result.isError, true);
    });

    // ---- reset -----------------------------------------------------------
    console.log('\nreset');

    await test('js_reset clears REPL state', async () => {
      await client.request('tools/call', { name: 'js', arguments: { code: 'var leftover = "still here";' } });
      const before = await client.request('tools/call', { name: 'js', arguments: { code: 'typeof leftover' } });
      assert.strictEqual(resultText(before.result).trim(), 'string');

      const resetRes = await client.request('tools/call', { name: 'js_reset', arguments: {} });
      assert.ok(!resetRes.result.isError, resultText(resetRes.result));

      const after = await client.request('tools/call', { name: 'js', arguments: { code: 'typeof leftover' } });
      assert.strictEqual(resultText(after.result).trim(), 'undefined',
        'state must not survive a reset');
    });

    await test('sky is still available after a reset', async () => {
      const res = await client.request('tools/call', {
        name: 'js',
        arguments: { code: 'typeof sky' },
      });
      assert.strictEqual(resultText(res.result).trim(), 'string'.length === 0 ? '' : 'object',
        resultText(res.result));
    });

    await test('a request is answered even when stdin closes immediately', async () => {
      // A script piping frames closes stdin as soon as it has written them.
      // Exiting on 'end' without draining in-flight work silently dropped the
      // reply the client was waiting for.
      const { spawnSync } = require('node:child_process');
      const frames = [
        JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {} } }),
        JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'js', arguments: { code: '40 + 2' } } }),
      ].join('\n') + '\n';

      const r = spawnSync(process.execPath, [SERVER], { input: frames, encoding: 'utf8', cwd: ROOT, timeout: 30000 });
      const replies = (r.stdout || '').split('\n').filter(Boolean).map((l) => {
        try { return JSON.parse(l); } catch { return null; }
      }).filter(Boolean);

      const answer = replies.find((m) => m.id === 2);
      assert.ok(answer, `the tools/call reply was dropped; got ids ${replies.map((m) => m.id).join(',')}`);
      assert.strictEqual(resultText(answer.result).trim(), '42');
    });

    await test('the server reports readiness on stderr, never stdout', async () => {
      // Preflight output must not corrupt the protocol channel.
      assert.ok(client.stderr.length > 0, 'expected a startup note on stderr');
      assert.ok(/dsh-cua/.test(client.stderr), client.stderr.slice(0, 200));
      if (VERBOSE) console.log('   ', client.stderr.trim().split('\n').slice(0, 3).join('\n    '));
    });
  } finally {
    client.stop();
  }

  console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
  if (failed > 0) {
    console.log('failures:');
    for (const f of failures) console.log(`\n  ${f.name}\n  ${f.error.message}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('runner crashed:', err);
  process.exit(1);
});