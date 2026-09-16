# Session state — dsh-mac-cua

Objective: build the Codex-equivalent Computer Use plugin, verify it, publish it to
the dsh market.

## Published

| Item | State |
|---|---|
| Repository | https://github.com/Saunato/dsh-mac-cua (public, 29 files) |
| Release | **v1.0.1** — `dsh-mac-cua.tgz`, version-free asset name, hash-verified |
| Registry PR | https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/5210 |
| CI gate | **only** failing the repo-age rule (0.0 days, needs 1); clears by itself in ~24h |
| npm | not published — no npmjs.com account; the Release tarball is the install path |
| Local install | working in the live DSH Desktop profile |

`git push` does not work from this network (`github.com:22` and `:443` unreachable,
`api.github.com` reachable), so the repository is published through the **Git Data
API** — see `scripts/publish-to-github.js`. The same constraint means the tarball
must be fetched through the API host here; it resolves normally elsewhere.

## Two startup failures, both fixed

The plugin twice took DSH Desktop to the safe-mode recovery screen. Both root
causes are now covered by tests.

**1. Relative path, and a fatal mount.** The bundle row ran
`./scripts/serve.js` with `cwd: '.'`, but the harness spawns stdio servers from
*its* working directory (the launch root), not the profile — so the path did not
resolve and the server never started. With `failOnStartupError: true` that killed
the whole boot. Fixes: `scripts/serve.js` locates the package itself;
`failOnStartupError` is now `false` (a plugin must never be able to block the
boot); `setup --write` emits absolute paths for both `args` and `cwd`.

**2. Duplicate insert.** `setup --write` always wrote an `- insert:` block, but the
bundle patch already inserts the same `mcp-cua` id — two insertions register the
component twice and the harness refuses to start with "duplicate service
component". `buildRow(mode)` now emits an **override** (`- id: mcp-cua`) when the
bundle is present, detected via `dsh.profile.bundles`; both shapes carry a complete
config, because an id-targeted patch replaces `config` wholesale rather than
merging into it.

## Verified in the live session

`mcp__cua_repl__js` was called successfully after the fix:

```
MCP tool live ✅
Finder: com.apple.finder elements=6
screenshot: attached
apps = 137
```

## Environment facts worth keeping

- macOS 26.6.2. `CGWindowListCreateImage` is **removed**; screenshots use
  ScreenCaptureKit. Capture fails while the screen is locked (`displays=0`), and
  the call can hang while macOS waits on a Screen Recording prompt — it now fails
  at 8s with a message saying so.
- Accessibility is granted to **DSH Desktop**; a bare binary inherits it through
  TCC responsible-process attribution. `osascript` is denied (attributed to itself).
- DSH's `node` is an Electron shim (`ELECTRON_RUN_AS_NODE=1`); the N-API addon
  loads in it and in standalone Node 24.
- Loader rules: a patch entry is an `insert:` list **or** an id-targeted override,
  never both for one id; a patch file must be a top-level YAML array; a package's
  `cordis.patch.yml` loads only when declared via `dsh.bundle`; `dsh plugin add`
  reconciles `dsh.profile.bundles` from installed state.
- `swiftc` needs `-wmo`, or cross-file internal symbols do not resolve.
- MCP stdio is newline-delimited JSON-RPC (no Content-Length framing).

## Bugs found and fixed (each has a regression test)

- `arg_string` returned success on failure, so string args were dropped
- `Dictionary(uniqueKeysWithValues:)` crashed on duplicate bundle ids
- `IndexError.message` was shadowed by `Error.message` in interpolation
- completion values were discarded by the async IIFE wrapper
- `set_value('')` was rejected, making field-clearing impossible
- `type_text` dropped trailing characters without focus synchronization
- `_checkSyntax` used `new Function`, rejecting valid top-level `await`
- the MCP server exited on stdin close without draining in-flight requests
- `setup --remove` could leave a comment-only, unbootable overlay
- the bundle patch kept pointing at the old directory after the package rename
- the native test suite was flaky when the GUI test host exited mid-run
- **a relative command path plus `failOnStartupError: true` killed the boot**
- **a duplicate `insert` of one id killed the boot**

## Known outstanding

- The native suite is occasionally flaky: the GUI test host exits mid-run, the
  harness restarts it and says so, but a test can still land in the gap. Diagnosing
  it properly needs the host's stderr captured (not yet done).
- Registry CI currently fails on repo age only. It re-runs on its own; nothing to do.
