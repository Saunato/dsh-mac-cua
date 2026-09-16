#!/usr/bin/env node
/**
 * Publish the local repository to GitHub over the API.
 *
 * `github.com:22` and `github.com:443` are both unreachable from this network
 * (the git protocol has no route), while `api.github.com` works. So instead of
 * `git push`, this recreates the repository contents through the Git Data API:
 * one blob per file, one tree, one commit, then move the branch ref.
 *
 * Only files git tracks are uploaded, so the result matches the local commit
 * exactly — no build intermediates, no node_modules.
 *
 * The token is read from the environment and never written anywhere.
 *
 * Usage: GH_TOKEN=... node scripts/publish-to-github.js [--dry-run]
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const OWNER = 'Saunato';
const REPO = 'dsh-mac-cua';
const BRANCH = 'main';
const ROOT = path.resolve(__dirname, '..');
const DRY = process.argv.includes('--dry-run');

const token = process.env.GH_TOKEN;
if (!token) {
  console.error('publish-to-github: GH_TOKEN is not set');
  process.exit(1);
}

const API = 'https://api.github.com';

async function api(method, endpoint, body) {
  const res = await fetch(`${API}${endpoint}`, {
    method,
    headers: {
      Authorization: `token ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'dsh-mac-cua-publish',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON error page */ }
  if (!res.ok) {
    const detail = json ? (json.message || JSON.stringify(json)) : text.slice(0, 300);
    throw new Error(`${method} ${endpoint} → ${res.status} ${detail}`);
  }
  return json;
}

/** Files git tracks, with their contents. */
function trackedFiles() {
  const r = spawnSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ls-files failed: ${r.stderr}`);
  const names = r.stdout.split('\0').filter(Boolean);

  return names.map((name) => {
    const abs = path.join(ROOT, name);
    return { path: name, bytes: fs.readFileSync(abs) };
  });
}

function commitMessage() {
  // Reuse the local commit message so the published history says the same thing.
  const r = spawnSync('git', ['log', '-1', '--format=%B'], { cwd: ROOT, encoding: 'utf8' });
  const local = r.status === 0 ? r.stdout.trim() : '';
  return local || 'dsh-mac-cua 1.0.0';
}

async function main() {
  const files = trackedFiles();
  const totalBytes = files.reduce((n, f) => n + f.bytes.length, 0);
  console.log(`publishing ${files.length} files (${(totalBytes / 1024).toFixed(0)} kB) to ${OWNER}/${REPO}`);

  if (DRY) {
    for (const f of files) console.log(`  ${String(f.bytes.length).padStart(8)}  ${f.path}`);
    console.log('dry run — nothing uploaded');
    return;
  }

  // 1. Blobs. Uploaded concurrently: there are a few dozen and the API allows it.
  console.log('uploading blobs...');
  const queue = [...files];
  const tree = [];
  const CONCURRENCY = 6;

  async function worker() {
    for (;;) {
      const file = queue.shift();
      if (!file) return;
      const blob = await api('POST', `/repos/${OWNER}/${REPO}/git/blobs`, {
        content: file.bytes.toString('base64'),
        encoding: 'base64',
      });
      tree.push({ path: file.path, mode: '100644', type: 'blob', sha: blob.sha });
      process.stdout.write('.');
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  console.log(` ${tree.length} blobs`);

  // Keep the tree ordering deterministic so a re-run is comparable.
  tree.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  // 2. Tree, commit, ref.
  console.log('creating tree...');
  const newTree = await api('POST', `/repos/${OWNER}/${REPO}/git/trees`, { tree });

  console.log('creating commit...');
  const message = commitMessage();
  const commit = await api('POST', `/repos/${OWNER}/${REPO}/git/commits`, {
    message,
    tree: newTree.sha,
    parents: [],
  });

  console.log(`moving refs/heads/${BRANCH}...`);
  try {
    await api('POST', `/repos/${OWNER}/${REPO}/git/refs`, {
      ref: `refs/heads/${BRANCH}`,
      sha: commit.sha,
    });
  } catch (err) {
    // The ref may already exist from a partial run; update it instead.
    if (!/already exists|Reference already exists/i.test(err.message)) throw err;
    await api('PATCH', `/repos/${OWNER}/${REPO}/git/refs/heads/${BRANCH}`, { sha: commit.sha, force: true });
  }

  console.log('');
  console.log(`✓ published ${tree.length} files`);
  console.log(`  commit: ${commit.sha}`);
  console.log(`  url   : https://github.com/${OWNER}/${REPO}`);
}

main().catch((err) => {
  console.error(`\npublish-to-github: ${err.message}`);
  process.exit(1);
});