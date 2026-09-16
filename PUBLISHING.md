# Publishing dsh-cua

**Published 2026-09-16.** This file is kept as the record of how, and as the
procedure for shipping the next version.

| Item | State |
|---|---|
| Repository | https://github.com/Saunato/dsh-mac-cua (public) |
| Release | v1.0.0, asset `dsh-mac-cua.tgz` (version-free name) |
| Registry PR | https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/5210 |
| npm | not published — no npmjs.com account was available |
| Topic | `dsh-plugin` (required by the registry's CI) |

## A note on the transport

`git push` does not work from this network: `github.com:22` and `github.com:443`
are both unreachable while `api.github.com` resolves and responds. The repository
was therefore published through the **Git Data API** — one blob per file, one
tree, one commit, then the branch ref. That is what `scripts/publish-to-github.js`
does, and it uploads exactly the files git tracks, so the result matches a
`git push` of the local commit.

The same constraint applies to installs: the `tarball:` URL resolves to
`github.com` and is unreachable here, though it works from networks that can reach
GitHub. The asset can be fetched through the reachable host instead, by querying
the releases API for the asset URL and downloading it with an authenticated
request — `api.github.com/repos/Saunato/dsh-mac-cua/releases/389602151/assets`
returns it, and the download returns an identical 138,325-byte tarball (verified
byte-for-byte).

## Next version

1. Bump `version` in `package.json`, rebuild if the Swift sources changed
   (`node scripts/build-native.js`), run the suites.
2. `npm pack`, rename the asset to the version-free `dsh-mac-cua.tgz`, and upload
   it to a new release:
   ```sh
   GH_TOKEN=... node scripts/publish-to-github.js    # publishes the code
   ```
   then create the release and upload the asset via the API, keeping the asset
   name version-free so `latest/download/` keeps resolving.
3. The registry entry needs no change for a patch release — it points at
   `latest/download/`.

---

## Original procedure (kept for reference)


Everything here is ready. What remains needs credentials this machine does not
have: an npm token to publish the package, and a GitHub login to push the repo and
open the registry pull request.

Current state:

| Item | Status |
|---|---|
| Code, tests, packaging | done — 71 tests pass |
| Install + tool binding verified through DSH | done |
| Package name | already set to **`dsh-mac-cua`**; free on npm and GitHub |
| npm account on this machine | none (`npm whoami` → `need auth`) |
| npm account needed at all? | **no** — a GitHub Release tarball is accepted instead |
| GitHub token / `gh` CLI | none (SSH key present) |
| Git identity | `Saunato <awesomeWar@163.com>` |

## Why the published name is not `dsh-cua`

The local working copy is called `dsh-cua`, and for a local install the name does
not matter. For a market listing it does, because the registry requires the entry
name to match the repository, and the registry ties a plugin to its owner:

- `dsh-cua` is **free on npm**, but it would be claimed by an account that is not
  the repo owner, so the registry entry could not point at a matching repo.
- `dsh-cua-pre` already exists in the registry (a Windows plugin by `Aik358`).
  A near-identical name invites confusion about which is which.
- The listing only means something if the repo URL in it resolves to a real
  repository that the entrant controls.

So the published identity is **`Saunato/dsh-mac-cua`**, which is free on both
registries and says what the plugin is: Computer Use for macOS.

## Steps

### 1. Create the repository and push

The package name and repository fields already say `dsh-mac-cua`, and
`cordis.patch.yml` references that name, so nothing needs renaming.

```sh
cd ~/dsh-cua

git init
git add -A
git commit -m "dsh-mac-cua 1.0.0: Computer Use for macOS via the Accessibility API"

# the SSH key on this machine can push; create the repo first (web UI or API)
git remote add origin git@github.com:Saunato/dsh-mac-cua.git
git push -u origin main
```

Then, on the repository:

- add the **`dsh-plugin`** topic (the registry requires it);
- confirm `package.json` still declares `dsh.bundle` — the registry's CI checks
  exactly that, and a repo with only `dsh.client` is rejected;
- confirm `cordis.patch.yml` is committed at the root.

### 2. Choose a download host

The registry accepts either. **GitHub Release is the path that needs no second
account** — only the GitHub login you already need for step 1.

**Option A — GitHub Release (no npm account needed)**

```sh
cd ~/dsh-cua
npm pack
gh release create v1.0.0 dsh-mac-cua-1.0.0.tgz \
  --title "dsh-mac-cua 1.0.0" \
  --notes "Computer Use for macOS: accessibility-tree desktop control from a persistent JavaScript REPL."
```

Then point the registry entry at it. `latest/download/` resolves the tag at
request time but takes the filename literally, so the asset name must be
version-free or the link rots on the next release. This repo's entry already
uses that rule — uncomment the `tarball:` line in
`market/Saunato__dsh-mac-cua.yml`:

```yaml
tarball: https://github.com/Saunato/dsh-mac-cua/releases/latest/download/dsh-mac-cua.tgz
```

For that URL to resolve, the released asset must be named `dsh-mac-cua.tgz`
(no version). Rename it during upload:

```sh
cp dsh-mac-cua-1.0.0.tgz /tmp/dsh-mac-cua.tgz
gh release create v1.0.0 /tmp/dsh-mac-cua.tgz --title "dsh-mac-cua 1.0.0"
```

**Option B — npm**

```sh
npm login
npm publish --access public
```

Publishing to npm is the smoother install for users: prebuilt tarballs are
preferred over source downloads and skip pnpm's build-approval step.

**Either way**, keep the prebuilt `native/dsh_cua.node` in the tarball, or users
hit that build-approval step with no Swift toolchain configured. Check it:

```sh
npm pack --dry-run | grep dsh_cua.node
```

### 3. Open the registry pull request

Fork `awesome-dsh-plugin/awesome-dsh-plugin` and add **one file** at
`data/plugins/Saunato__dsh-mac-cua.yml`. A ready copy is at
[`market/Saunato__dsh-mac-cua.yml`](market/Saunato__dsh-mac-cua.yml) in this
repository.

Do not edit either README — they are generated from `data/plugins/*.yml`.

CI checks, in order: at most 3 entries per PR, the `dsh.bundle` manifest, and a
repository at least one day old. The `Saunato` GitHub account was created in 2021,
so the age rule is satisfied.

## After publishing

A user installs with:

```sh
dsh plugin --profile web add dsh-mac-cua
```

The bundle mounts the MCP server automatically. They then grant Accessibility to
DSH Desktop, restart it, and the agent sees `mcp__cua_repl__js`.

## Verification performed before publishing

Rather than assert these, each was run:

- **78 tests** across three suites — native module (30), MCP server over real
  stdio (25), setup/bundle/patch editing (23).
- **Install path** — `dsh plugin --profile web add <tarball>` installs, reconciles
  `dsh.profile.bundles`, and composes `mcp-cua` from the bundle patch.
- **Tool binding** — a headless DSH harness exposed `mcp__cua_repl__js`, the model
  called it, and it returned a real result (`137 apps`).
- **Write round-trip** — the model launched TextEdit, found the `TextArea` by
  index, wrote via `set_value`, and read the value back out of the tree.
- **Image delivery** — `nodeRepl.emitImage` produced an `image/png` content block
  whose payload carries a valid PNG signature.
- **Clean-install** — the packed tarball installed into an empty project and all
  three layers worked from `node_modules`.