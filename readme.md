# Ollama Token Tracker

![The status bar item sitting next to VS Code's built-in status icons](https://github.com/iwasatapex/Ollama-Token-Tracker/raw/HEAD/media/screenshot-statusbar.png)
![The three icon states: generating (green), model loaded (yellow), no model / error (red)](https://github.com/iwasatapex/Ollama-Token-Tracker/raw/HEAD/media/screenshot-icon-states.png)

A small, standalone VS Code / VSCodium extension. It puts a compact,
color-coded llama face in the status bar (bottom right) and reports the
**exact** token statistics of any Ollama generation that runs through it.

- **Red** — no model is loaded, or something is wrong (hover for the reason).
- **Yellow** — a model is loaded and idle.
- **Green** — a generation is in progress right now.
- **Hover** — model, size, VRAM, processor/GPU split, context length, the last
  generation's exact token counts, and the running version.

## How it works

On activation the extension starts a small HTTP proxy:

| Setting | Default | Meaning |
| --- | --- | --- |
| `ollamaTokenTracker.proxyPort` | `11434` | Port the proxy listens on (`127.0.0.1` only). |
| `ollamaTokenTracker.ollamaUrl` | `http://127.0.0.1:11435` | Where your real Ollama server listens behind the proxy. |

The proxy forwards every request to `ollamaUrl` untouched. For `/api/generate`
and `/api/chat` it additionally watches the streamed response as it passes
through:

- **While generating**, the tooltip shows a live *chunks per second* estimate.
  It is explicitly labelled as an estimate and is never presented as a token
  count.
- **When Ollama sends `done: true`**, the extension reads Ollama's own
  `eval_count`, `eval_duration`, `prompt_eval_count` and `prompt_eval_duration`
  fields and shows the exact, final numbers, for example
  `Last generation: 123 output tokens • 17 prompt tokens • 41.0 tok/s`. They
  stay in the tooltip for five minutes. If a `done` object carries no usable
  durations, nothing is recorded — the extension never invents a token count.

Separately, it polls Ollama's own `/api/ps` directly (every 2 seconds, not
through the proxy) to know whether a model is loaded. That part works with no
setup at all.

## Setup

**The colored icon works immediately** — no configuration needed.

**Universal setup:** the tracker listens on Ollama's normal port `11434`, while
the real Ollama server runs behind it on `11435`. Run
`setup-universal-ollama.sh` once from this folder, then restart the extension.
Every existing Ollama client, including `ollama run`, is tracked without
changing its endpoint.

For a per-client setup instead, keep the proxy on `11436` and point the client
at `http://127.0.0.1:11436`:

- **Copilot Chat** — run **"Ollama Token Tracker: Point Copilot Chat at This
  Proxy"**, then reload the window.
- **Anything with a configurable Ollama base URL** (Cline, Continue, aider,
  Open WebUI, a `curl` script, an SDK, ...) — run **"Ollama Token Tracker: Show
  Proxy URL"** and point that client at it.
Run **"Ollama Token Tracker: Run Setup Check"** at any time — it probes the
proxy, the configured backend, and Ollama's usual default port, and prints a
plain-English report to the Output panel.

## Commands

| Command | What it does |
| --- | --- |
| **Restart Proxy** | Restarts the proxy after a settings change. |
| **Point Copilot Chat at This Proxy** | Writes Copilot Chat's Ollama endpoint setting. Needs a window reload. |
| **Show Proxy URL** | Shows/copies the proxy address, for Cline, Continue, aider, etc. |
| **Show Diagnostics** | Running version, install path, duplicate-install detection, and live state. |
| **Run Setup Check** | Proxy/backend reachability report in the Output panel. |

## Settings

- `ollamaTokenTracker.proxyPort` (default `11434`) — the port this extension's
  proxy listens on.
- `ollamaTokenTracker.ollamaUrl` (default `http://127.0.0.1:11435`) — where your
  real Ollama server actually listens.

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
  the live `isGenerating` transition, and that an unreachable backend surfaces
  an error instead of hanging.
- `test/test-extension-render.js` drives the real `extension.js` through a
  stubbed `vscode` API, asserting the status bar uses the contributed
  `$(ollama-tracker)` icon and that each state (no model / ready / final stats /
  generating / error) yields the right color and tooltip content.

**Verified:** all three test files pass, and `node --check` succeeds on every
JavaScript file in the extension.

**Not verified here:** how the glyph actually renders in a real VS Code /
Code-OSS window (font rendering in Electron/Chromium, or on KDE
Plasma/Wayland), and behavior against a real Ollama installation. That is what
**Run Setup Check** and **Show Diagnostics** exist for — they give fast,
structured feedback from your actual environment.

## Changelog

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

