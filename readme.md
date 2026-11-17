# Ollama Token Tracker

![The status bar item sitting next to VS Code's built-in status icons](https://github.com/iwasatapex/Ollama-Token-Tracker/raw/HEAD/media/screenshot-statusbar.png)
![The three icon states: generating (green), model loaded (yellow), no model / error (red)](https://github.com/iwasatapex/Ollama-Token-Tracker/raw/HEAD/media/screenshot-icon-states.png)

A small, standalone VS Code / VSCodium extension. It puts a compact,
color-coded llama face in the status bar (bottom right) and reports the
**exact** token statistics of any Ollama generation that runs through it.

- **Red** — no model is loaded, or Ollama itself is not reachable (the tooltip
  says which).
- **Yellow** — a model is loaded and idle.
- **Green** — a generation is in progress, with a live `~tokens · t/s` estimate
  (and `×2`, `×3`… when several requests run in parallel).
- **Red/orange background** — a real fault: the proxy could not start (error),
  or a proxied request just failed (warning, clears itself after a minute).
- **After a generation** — `123 out / 17 in · 41.0 t/s · 25% ctx`, kept for
  five minutes. `ctx` is how much of the model's context window that request
  filled; at 90% or more the item turns orange, because once the window
  overflows Ollama silently drops the oldest part of the prompt.
- **Hover** — model, context length, size/VRAM, CPU/GPU split, when Ollama will
  unload the model, the last generation's exact output/prompt tokens and speeds,
  context used as `8,192 / 32,768 tokens (25%)` with a meter, total time,
  session totals, and quick links (Setup Check, Restart, Log).
- **Click** — a menu with every command.

## How it works

On activation the extension starts a small HTTP proxy:

| Setting                        | Default                  | Meaning                                                 |
| ------------------------------ | ------------------------ | ------------------------------------------------------- |
| `ollamaTokenTracker.proxyPort` | `11434`                  | Port the proxy listens on (`127.0.0.1` only).           |
| `ollamaTokenTracker.ollamaUrl` | `http://127.0.0.1:11435` | Where your real Ollama server listens behind the proxy. |

The proxy forwards every request to `ollamaUrl` untouched. For `/api/generate`
and `/api/chat` it additionally watches the streamed response as it passes
through:

- **While generating**, the status bar shows a live token and tokens/s
  _estimate_ (one per streamed chunk — Ollama streams one token per line —
  reasoning/"thinking" chunks included; within a token or two of the final
  count in live testing). It is explicitly labelled as an estimate in the tooltip.
- **When Ollama sends `done: true`**, the extension reads Ollama's own
  `eval_count`, `eval_duration`, `prompt_eval_count` and `prompt_eval_duration`
  fields and shows the exact, final numbers, for example
  `Output: 123 tokens · 41.0 tok/s` and `Prompt: 17 tokens`. They
  stay in the tooltip for five minutes. If a `done` object carries no usable
  durations, nothing is recorded — the extension never invents a token count.

Separately, it polls Ollama's own `/api/ps` directly (every 2 seconds, not
through the proxy) to know whether a model is loaded — and whether Ollama is
reachable at all. That part works with no setup at all.

If a client cancels a request (a chat's Stop button), the proxy cancels the
upstream request too, so Ollama stops generating.

## Setup

**The colored icon works immediately** — no configuration needed.

**Universal setup:** the tracker listens on Ollama's normal port `11434`, while
the real Ollama server runs behind it on `11435`. Run
`setup-universal-ollama.sh` once from this folder, then restart the extension.
Every existing Ollama client, including `ollama run`, is tracked without
changing its endpoint.

For a per-client setup instead, leave Ollama on its default port: set
`ollamaTokenTracker.proxyPort` to a free port such as `11436` and
`ollamaTokenTracker.ollamaUrl` to `http://127.0.0.1:11434`, then point each
client at `http://127.0.0.1:11436`:

- **Copilot Chat** — run **"Ollama Token Tracker: Point Copilot Chat at This
  Proxy"**, then reload the window.
- **Anything with a configurable Ollama base URL** (Cline, Continue, aider,
  Open WebUI, a `curl` script, an SDK, ...) — run **"Ollama Token Tracker: Show
  Proxy URL"** and point that client at it.

Run **"Ollama Token Tracker: Run Setup Check"** at any time — it probes the
proxy, the configured backend, and Ollama's usual default port, and prints a
plain-English report to the Output panel.

## Commands

| Command                              | What it does                                                                |
| ------------------------------------ | --------------------------------------------------------------------------- |
| **Restart Proxy**                    | Restarts the proxy (settings changes already apply automatically).          |
| **Point Copilot Chat at This Proxy** | Writes Copilot Chat's Ollama endpoint setting. Needs a window reload.       |
| **Show Proxy URL**                   | Shows/copies the proxy address, for Cline, Continue, aider, etc.            |
| **Show Diagnostics**                 | Running version, install path, duplicate-install detection, and live state. |
| **Run Setup Check**                  | Proxy/backend reachability report in the Output panel.                      |
| **Show Log**                         | Opens the extension's Output panel.                                         |

## Settings

- `ollamaTokenTracker.proxyPort` (default `11434`) — the port this extension's
  proxy listens on.
- `ollamaTokenTracker.ollamaUrl` (default `http://127.0.0.1:11435`) — where your
  real Ollama server actually listens. `http` or `https`; a base path (e.g.
  `https://host/ollama`) is honoured. It must not point at the proxy's own port —
  the extension refuses that configuration instead of looping forever.

Changes to either setting restart the proxy automatically.

## Notes

- The proxy binds to `127.0.0.1` only, so it is not reachable from other machines.
- No runtime dependencies, and no network calls other than to your own
  configured Ollama URL.
- If the proxy cannot bind its port, you get a popup explaining it and pointing
  at "Run Setup Check" — not a silent failure behind the red icon.

## The icon

The glyph is an original, single-color llama face — not Ollama's logo. It is
contributed through `contributes.icons` in `package.json`, which points at
`media/ollama-tracker-103.woff`. The vector source is
`icon-build/svg/ollama-tracker.svg`, and `icon-build/build-font.js` regenerates
the font (`npm install`, then `npm run build:icon`).

Because it is a single-color font glyph it picks up the status bar color
(red/yellow/green) automatically, and its two dark eyes are holes cut into the
outline rather than a second color, so they stay dark against whichever color
the face currently is.

## Tests

```sh
npm install     # only needed for the icon build tooling
npm test
```

- `test/test-stream-parser.js` covers the NDJSON parsing edge cases: normal
  streaming, a final object with no trailing newline, a final object split
  mid-JSON across two TCP chunks, a `stream:false` single-shot response, and
  proof that intermediate chunks are never counted as tokens. It also asserts
  that no stats are produced when the duration fields are missing or zero.
- `test/test-e2e-proxy.js` runs the real proxy against a mock Ollama and
  asserts the captured final stats (`123` output / `17` prompt / ~`41` tok/s),
  the live `isGenerating` transition, a `502` (not a hang) when the backend is
  down, client-abort handling, parallel generations, UTF-8 split across chunks,
  and the self-proxy loop guard.
- `test/test-extension-render.js` drives the real `extension.js` through a
  stubbed `vscode` API, asserting the status bar uses the contributed
  `$(ollama-tracker)` icon, that each state (no model / backend down / ready /
  final stats / generating / transient and fatal errors) yields the right
  color, background and tooltip content, that network text is escaped, and
  that an unchanged state does not rewrite the status bar.

**Verified:** all three test files pass, and `node --check` succeeds on every
JavaScript file in the extension.

**Not verified here:** how the glyph actually renders in a real VS Code /
Code-OSS window (font rendering in Electron/Chromium, or on KDE
Plasma/Wayland), and behavior against a real Ollama installation. That is what
**Run Setup Check** and **Show Diagnostics** exist for — they give fast,
structured feedback from your actual environment.

## Changelog

### Unreleased

Found by testing live against Ollama 0.40.16:

- **Fixed:** when Ollama aborted a generation mid-stream (e.g. "prediction
  aborted, token repeat limit reached") or refused one (unknown model, HTTP
  404), the icon silently went idle. Ollama's error is now shown.
- **Fixed:** the live estimate over-counted code by almost 2x (characters ÷ 4);
  it now counts streamed chunks and lands within a token or two.
- **Fixed:** prompt speed was absurdly high for cached prompts (it divided the
  whole prompt by the time spent on the uncached tail). The tooltip now also
  shows how many prompt tokens were cached.

- **Fixed:** cancelling a request mid-stream (a chat's Stop button) left the
  icon stuck on green "Generating" until VS Code was restarted.
- **Fixed:** when Ollama was down, proxied requests never got a response — the
  client hung until its own timeout and no error was shown. They now get a
  `502` and the status bar shows the failure.
- **Fixed:** a single failed request turned the icon red permanently; request
  errors now clear on the next success or after a minute.
- **Fixed:** an upstream failure mid-stream appended plain text to the NDJSON
  body (looking like a clean finish); the connection is now dropped instead.
- **Fixed:** multi-byte UTF-8 split across network chunks was garbled.
- **Fixed:** `ollamaUrl` pointing at the proxy's own port made it proxy to
  itself until sockets ran out; it is now refused with a clear message.
- **Fixed:** `https` backends were probed over plain HTTP by Setup Check.
- Shows how full the context window is (status bar `25% ctx`, tooltip meter,
  warning at 90%+). Exact for `/api/generate`, which returns the context
  tokens; otherwise prompt + output tokens — exact on Ollama versions that
  report `prompt_eval_cached_count`, marked `≈` on older ones.
- Status bar shows tokens/s live and after each generation; large counts are
  compacted (`18k`). Parallel generations are counted.
- New "Ollama not reachable" state, distinct from "no model loaded".
- Tooltip redesigned as tables (markdown collapsed the old space-padding), with
  prompt speed, total time, keep-alive, other loaded models, session totals and
  command links. Model details follow the model the last generation used.
- Colors follow the theme; real faults use the error/warning background.
- Clicking the item opens a command menu. Settings changes apply immediately.
- Live token estimate includes reasoning ("thinking") text.
- Performance: no status bar update per streamed token, no O(n²) re-splitting
  of large non-streamed bodies, no overlapping `/api/ps` polls.
- Tooltip text from the network is fully escaped (it is rendered with HTML on).
- Packaging: `node_modules` is no longer committed; stale root
  `extension.vsixmanifest` / `[Content_Types].xml` removed; screenshots, build
  fonts and `.claude/` are excluded from the `.vsix`.

### 4.0.0

- Added live estimated token generation speed during streaming.
- Improved proxy performance, timeout handling, keep-alive reuse, and endpoint detection.

### 3.0.1

- Reconciled the version reported in `package.json`, the VSIX manifest, and
  this README. They previously disagreed (3.0.1 / 1.0.8 / 1.0.3).
- Wired the shipped icon font up for real via `contributes.icons`. The status
  bar previously used the built-in `$(hubot)` codicon while this README
  described a custom glyph that was never actually rendered.
- Corrected the documented defaults: the proxy listens on `11436` and real
  Ollama stays on `11434` — the reverse of what earlier revisions described.
- The "couldn't bind the port" popup now fires for **any** configured port,
  not only `11434`.
- Removed dead code left over from an earlier table-based UI
  (`formatBytesDisplay`, `formatProcessorDisplay`, `formatDate`,
  `formatLoadedModels`, `formatOllamaPs`, `TABLE_WIDTH`, `versionFooter`) and
  de-duplicated the byte/processor formatters against `status-tooltip.js`.
- The tooltip now states the current status explicitly, and the proxy strips
  hop-by-hop headers instead of forwarding them verbatim.
- Added `icon`, `license`, `scripts` and `devDependencies`; added
  `.vscodeignore`; removed the placeholder `github.com/yourname/...` URLs.

### 1.0.3

- First version with the proxying design, exact token statistics, the
  Diagnostics command, and the Setup Check command.

### 1.0.1 - 1.0.2

- Established the icon-only status bar presentation and the red/yellow/green
  state colors.
