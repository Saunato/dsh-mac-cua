# Session state — dsh-mac-cua

Objective: build the Codex-equivalent Computer Use plugin, verify it, publish it to
the dsh market.

## Done

| Area | State |
|---|---|
| Native module (Swift AX core + C N-API) | built, 25 tests pass |
| REPL + MCP server | built, 25 tests pass |
| Setup/bundle/patch tooling | built, 23 tests pass |
| **Total** | **73 tests, 0 failures** |
| Package | `dsh-mac-cua` 1.0.0, ~138 kB, zero runtime deps, prebuilt binary |
| Git repository | initialised, 2 commits, working tree clean, 27 files |
| Fresh-clone verification | clone runs all 73 tests; source rebuild also works |
| Install path | verified via `dsh plugin add` |
| Tool binding through DSH | verified — the model used `mcp__cua_repl__js` |
| Write round-trip through DSH | verified — TextEdit `set_value` + read-back |
| Image delivery | verified — valid `image/png` content block |
| Live DSH Desktop profile | dependency installed, bundle layer active |
| Registry entry | `market/Saunato__dsh-mac-cua.yml`, YAML validated, claims checked |

## Blocked on: publish credentials

The only remaining step. Verified absent by exhaustive check — `~/.npmrc` has no
token, no `NPM_TOKEN`/`NODE_AUTH_TOKEN` in the environment, nothing in the
keychain, no `gh` CLI, no `~/.config/gh`, and the global git identity
(`Saunato <awesomeWar@163.com>`) is not an authentication for either service.

- **`dsh-mac-cua` is free on npm and GitHub.** `Saunato` exists (created 2021),
  satisfying the registry's 1-day repo-age rule.
- **npm is now optional**: the registry accepts a GitHub Release tarball, so
  publishing needs only the GitHub login required anyway to push the repo.
- `PUBLISHING.md` has the exact commands; the `tarball:` line is pre-written in
  the entry, commented, with the version-free asset-name rule explained.

## To finish

```sh
cd ~/dsh-cua && git remote add origin git@github.com:Saunato/dsh-mac-cua.git && git push -u origin main
# create the repo, add the dsh-plugin topic
npm pack && gh release create v1.0.0 <renamed-to-dsh-mac-cua.tgz>
# uncomment tarball: in market/Saunato__dsh-mac-cua.yml, then PR it to
# awesome-dsh-plugin/awesome-dsh-plugin at data/plugins/Saunato__dsh-mac-cua.yml
```

Then restart DSH Desktop so the running harness picks up the bundle layer; the
agent will see `mcp__cua_repl__js`.

## Environment facts worth keeping

- macOS 26.6.2. `CGWindowListCreateImage` is **removed**; screenshots must use
  ScreenCaptureKit, and capture fails while the screen is locked (`displays=0`,
  `CGSSessionScreenIsLocked=1`).
- Accessibility is granted to **DSH Desktop**; a bare binary inherits it through
  TCC responsible-process attribution, which is why the native module needs no
  separate grant. `osascript` is denied because it is attributed to itself.
- DSH's `node` is an Electron shim (`ELECTRON_RUN_AS_NODE=1`). The N-API addon
  loads in both it and standalone Node 24.
- Loader rules: a patch entry is an `insert:` list (a bare `- id:` row is an
  override and fails with `entry "<id>" not found`); a patch file must be a
  top-level YAML array (a comment-only file fails the boot); a package's own
  `cordis.patch.yml` loads only when declared via `dsh.bundle`; `dsh plugin add`
  reconciles `dsh.profile.bundles` from the installed state.
- Build: `swiftc` needs `-wmo`, or cross-file internal symbols do not resolve.
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
- the native test suite was flaky when the GUI test host exited mid-run; the
  harness now detects a dead host, restarts it, and says so