# dsh-cua

**Computer Use for DeepSeek Harness.** Control macOS desktop applications from a
DSH agent through a persistent JavaScript REPL, backed by the macOS Accessibility
API.

The model gets two tools — `js` and `js_reset` — and drives everything through
them. There is no tool per action; the tool surface stays fixed while capability
lives in the `sky` API.

## What it can do

- **Read** any application's accessibility tree as text, optionally with a
  screenshot
- **Act** — click elements or coordinates, type, paste, press key chords, scroll,
  drag, select text, set values, invoke accessibility actions
- **Work incrementally** — the tree comes back as a diff after the first read, so
  a long interaction stays cheap in tokens
- **Read screenshots** back into the conversation as images

Actions address elements by `element_index`, derived from the most recent state
read. Coordinates are the fallback, not the default.

## Requirements

- macOS 14.4 or newer (Apple Silicon or Intel)
- Node.js 20 or newer
- **Accessibility permission** — required; without it nothing works
- **Screen Recording permission** — optional; only needed for screenshots

## Install

```sh
dsh plugin --profile web add dsh-cua
```

The package ships prebuilt, so nothing is compiled during install. Register the
MCP server with your profile — it writes the patch row with this installation's
absolute paths:

```sh
dsh-cua-setup                    # check the install and report what is missing
```

A normal install needs **no configuration**. The package declares `dsh.bundle`,
so `dsh plugin add dsh-cua` mounts the MCP server from the package's own
`cordis.patch.yml`, with no absolute paths to fill in.

If the tools do not appear, `dsh-cua-setup` separates the possible causes —
missing dependency, missing bundle layer, broken native module, missing
permission — and names the fix for whichever one it finds.

<details>
<summary>Manual installs, or overriding the row</summary>

An install that has no bundle layer (a bare copy of the source, for instance)
needs an explicit row carrying absolute paths. `dsh-cua-setup --write` adds one;
`--print` shows it without writing; `--remove` takes it back out. The row goes
into `~/Library/Application Support/dsh-desktop/harness/profiles/web/cordis.patch.yml`:

```yaml
- insert:
    - id: mcp-cua
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: cua_repl
        transport: stdio
        command: node
        args:
          - '/path/to/dsh-cua/cua-repl/server.js'
        cwd: '/path/to/dsh-cua'
        env:
          DSH_CUA_NATIVE: '/path/to/dsh-cua/native/dsh_cua.node'
        toolCallTimeoutMs: 180000
        failOnStartupError: true
```

The row must nest under `insert:`. A top-level `- id:` row is an *override* of an
existing entry, and the loader rejects it with `entry "mcp-cua" not found`.

</details>

Then grant **Accessibility** so the harness can read and operate app UI:

> System Settings → Privacy & Security → **Accessibility** → add and enable
> **DSH Desktop**

For screenshots, also grant:

> System Settings → Privacy & Security → **Screen Recording** → add and enable
> **DSH Desktop**

Restart DSH Desktop after granting either permission.

Verify with the agent:

```
Use mcp__cua_repl__js to run (await import("node:fs")).existsSync ? "ok" : "ok"
```

or ask it to read the state of an app. A permission problem is reported with the
exact settings path rather than failing silently.

## Configuration

The bundle ships this row, which mounts the MCP server. `dsh-cua-setup --print`
shows the same row with absolute paths for a manual install:

```yaml
- insert:
    - id: mcp-cua
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: cua_repl
        transport: stdio
        command: node
        args:
          - '/path/to/dsh-cua/cua-repl/server.js'
        cwd: '/path/to/dsh-cua'
        env:
          DSH_CUA_NATIVE: '/path/to/dsh-cua/native/dsh_cua.node'
        toolCallTimeoutMs: 180000
        failOnStartupError: true
```

`serverName` determines the tool prefix, so the tools appear as
`mcp__cua_repl__js` and `mcp__cua_repl__js_reset`.

The shipped row uses paths relative to the profile directory, so it works for
every install location. To change a setting, add an override row to your profile
patch — `- id: mcp-cua` plus only the fields you want to differ.

## Usage

The agent writes JavaScript. State persists between calls.

```js
// Read state. `sky` is injected as a global — do not import it.
var state = await sky.get_app_state({ app: "Finder" });
nodeRepl.write(state.text);
```

```js
// Act on an element by its index, then read state again.
await sky.click({ app: "Finder", element_index: 42 });
nodeRepl.write((await sky.get_app_state({ app: "Finder" })).text);
```

```js
// Read a screenshot back into the conversation.
const fs = await import("node:fs/promises");
const { fileURLToPath } = await import("node:url");
var state = await sky.get_app_state({ app: "Finder" });
if (state.screenshot) {
  await nodeRepl.emitImage({
    bytes: await fs.readFile(fileURLToPath(state.screenshot.url)),
    mimeType: "image/png",
  });
}
```

### API

```ts
sky.get_app_state({ app, disableDiff?, screenshot? })  // -> AppState
sky.list_apps()                                       // -> App[]
sky.get_screenshot()                                  // -> { url, note }

sky.click({ app, element_index?, x?, y?, mouse_button?, click_count? })
sky.set_value({ app, element_index, value })
sky.select_text({ app, element_index, text, prefix?, suffix?, selection_type? })
sky.perform_secondary_action({ app, element_index, action })
sky.type_text({ app, text })
sky.press_key({ app, key })
sky.paste({ app, text, format })     // "text" | "md" | "html"
sky.scroll({ app, element_index?, x?, y?, direction, pages? })
sky.drag({ app, from_x, from_y, to_x, to_y })
```

`app` accepts a display name, bundle identifier, or full path:
`"Finder"`, `"com.apple.finder"`, `"/Applications/Safari.app"`.

### Behaviour worth knowing

**Element indices only mean something for the snapshot that produced them.**
Every `get_app_state` publishes a fresh map and invalidates the previous one. A
stale index is refused with a message telling the model to re-read — it is never
applied to whatever now occupies that position.

**`paste` restores your clipboard.** It writes to the pasteboard, presses Cmd+V,
then puts your previous clipboard contents back.

**`\n` in `type_text` presses Return**, which submits forms and sends messages in
many apps. Use `paste` for multi-line text.

**Typing waits for keyboard focus** and reads the field back, so a mismatch is
reported instead of silently lost.

## Architecture

```
DSH agent
  │  mcp__cua_repl__js { code }
  ▼
dsh-mcp-client  (ships with DSH; mounted by this package's dsh.bundle)
  │  MCP over stdio, newline-delimited JSON-RPC
  ▼
cua-repl/server.js        (MCP server: js, js_reset)
  │
cua-repl/repl.js          (persistent vm context, completion values)
  │
lib/sky.js                (the sky API)
  │
native/dsh_cua.node       (Swift accessibility core + C N-API binding)
  │  Accessibility API · CGEvent · ScreenCaptureKit · NSWorkspace
  ▼
macOS applications
```

| Layer | Responsibility |
|---|---|
| `native/axcore.swift` | AX tree walk, element indexing, text rendering, diffing |
| `native/actions.swift` | AX actions, index resolution, focus handling |
| `native/input.swift` | CGEvent keys and mouse, clipboard-preserving paste |
| `native/screenshots.swift` | ScreenCaptureKit capture, app enumeration, window geometry |
| `native/abi.swift` | JSON C ABI consumed by the binding |
| `native/addon.c` | N-API binding; every operation runs on a worker thread |

Nothing uses AppleScript, JXA, or System Events — they are a different permission
path and behave inconsistently.

## Building from source

A prebuilt `native/dsh_cua.node` ships with the package, so this is only needed
after editing the Swift sources or if the binary does not match your platform.

```sh
node scripts/build-native.js
```

Needs the Xcode Command Line Tools and Node headers. Point at the headers
explicitly when they are not next to your Node binary:

```sh
NODE_INCLUDE=/path/to/include/node node scripts/build-native.js
```

The Swift sources compile with `-wmo`; cross-file references to internal symbols
do not resolve otherwise, because `swiftc` emits one object per input file when
building incrementally.

## Tests

```sh
node test/run-tests.js    # native module, against a controlled host app
node test/mcp-tests.js    # MCP server, over the real stdio protocol
node test/setup-tests.js  # setup command, bundle patch and profile editing
```

78 tests in total. The native suite exercises every public `sky` method directly,
including the ones that are easy to leave untested — `select_text`'s caret modes
and its `prefix`/`suffix` disambiguation, and `paste`'s clipboard restoration.

The native suite drives write actions **only** against a purpose-built host
application (`test/host.swift`), never against your real apps or data. Checks
against real applications are read-only.

## Troubleshooting

**Tools do not appear.** Run `dsh-cua-setup` first: it reports whether the
dependency, the bundle layer, the native module and the permissions are each in
place, and names the fix. A config that fails to compose reports
`entry "<id>" not found`, which means a row was written as a bare `- id:`
override instead of nesting under `insert:`.

**"Accessibility is NOT available".** Grant it to **DSH Desktop** under
Privacy & Security → Accessibility, then restart DSH Desktop.

**Screenshots are null.** Read `state.screenshotNote`. It distinguishes the three
causes: the screen is locked (macOS blocks capture of a locked session), the
display is asleep (no active display), or Screen Recording is not granted. Only
the last needs a settings change.

**Screenshots return while the screen is locked?** They do not, by design — the
note says so. Accessibility-based operation is unaffected.

**A click does not register.** The tree may be stale, or the element exposes no
`AXPress`. The result message says which path was used, and clicking falls back
to the element's centre point automatically.

**Some apps expose a poor accessibility tree.** Games, canvas editors, and some
Electron apps. Get a screenshot and fall back to coordinates; the agent is
instructed to tell you when it had to work that way.

## Security

This plugin gives the agent the ability to read and operate your desktop UI — the
same class of access a screen reader has. Granting Accessibility to DSH Desktop
means any process the harness spawns can control your Mac. Grant it only if you
intend to use Computer Use.

The agent is instructed by `instructions/computer-policy.md` to confirm before
actions with external side effects: deleting data, sending messages, submitting
forms, financial transactions, installing software, changing system settings, and
transmitting sensitive data. That policy is prompt-level guidance, not a kernel
enforcement boundary — treat the agent as a capable assistant that can act on
your machine, not as a sandboxed one.

## License

MIT