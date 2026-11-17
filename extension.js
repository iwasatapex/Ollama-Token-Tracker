'use strict';
const vscode = require('vscode');
const http = require('http');
const https = require('https');
const { OllamaProxyCore } = require('./ollama-proxy-core.js');
const {
  buildStatusMarkdown,
  formatBytes,
  formatInt,
  formatPercent,
  formatCompact,
  formatKeepAlive,
  formatProcessor,
  formatRate,
} = require('./status-tooltip.js');

const EXT_ID = '4m4teur.ollama-token-tracker';

let statusBarItem;
let renderInterval;
let core;
let outputChannel;
let extensionVersion = 'unknown';
let lastRenderKey = null;
let configRestartTimer = null;

// Theme colors rather than hard-coded hex, so the item follows light, dark and
// high-contrast themes. charts.* are the theme's own red/yellow/green.
const COLOR_NO_MODEL = 'charts.red';
const COLOR_MODEL_LOADED = 'charts.yellow';
const COLOR_GENERATING = 'charts.green';
// Real faults get a filled background so they are not mistaken for the
// ordinary red "no model loaded" state.
const BG_ERROR = 'statusBarItem.errorBackground';
const BG_WARNING = 'statusBarItem.warningBackground';

const LAST_FINAL_WINDOW_MS = 5 * 60 * 1000;
const TRANSIENT_ERROR_WINDOW_MS = 60 * 1000;
const RENDER_INTERVAL_MS = 500;
// Context fill at which the status bar turns to the warning background.
const CONTEXT_WARN_PERCENT = 90;

// Shown as links at the bottom of the tooltip, and the only commands the
// (trusted) tooltip markdown is allowed to invoke.
const TOOLTIP_COMMANDS = [
  { title: 'Setup Check', id: 'ollamaTokenTracker.runSetupCheck' },
  { title: 'Restart', id: 'ollamaTokenTracker.restartProxy' },
  { title: 'Log', id: 'ollamaTokenTracker.showOutput' },
];

// The project's own single-color glyph, contributed as an icon by
// `contributes.icons` in package.json (font at media/ollama-tracker-103.woff,
// built from icon-build/svg/ollama-tracker.svg). Contributed icon ids are
// usable anywhere a label is rendered, StatusBarItem.text included, so this
// renders as the alpaca face in the screenshots rather than a built-in codicon.
const ICON = '$(ollama-tracker)';

function getConfig() {
  const cfg = vscode.workspace.getConfiguration('ollamaTokenTracker');
  return {
    proxyPort: cfg.get('proxyPort', 11434),
    ollamaUrl: String(cfg.get('ollamaUrl', 'http://127.0.0.1:11435')).trim(),
  };
}

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  if (outputChannel) outputChannel.appendLine(line);
}

function markdownTooltip(data) {
  const tooltip = new vscode.MarkdownString(
    buildStatusMarkdown({
      ...data,
      version: extensionVersion,
      commands: TOOLTIP_COMMANDS,
    }),
    true,
  );
  tooltip.supportHtml = true;
  tooltip.isTrusted = { enabledCommands: TOOLTIP_COMMANDS.map((c) => c.id) };
  return tooltip;
}

function modelDetails(s, preferredName) {
  const models = Array.isArray(s.loadedModels) ? s.loadedModels : [];
  const nameOf = (m) => m.name || m.model || '';
  // Describe the model the last generation actually used when it is loaded,
  // not whichever happens to be first in /api/ps.
  const model = (preferredName && models.find((m) => nameOf(m) === preferredName)) || models[0];
  if (!model) {
    return {
      model: '—',
      otherModels: [],
      size: '—',
      vram: '—',
      processor: '—',
      context: '—',
    };
  }
  const contextSize = Number(model.context_length ?? model.context);
  const hasSize = Number.isFinite(contextSize) && contextSize > 0;
  return {
    model: nameOf(model) || 'Unknown model',
    otherModels: models.filter((m) => m !== model).map(nameOf),
    size: formatBytes(Number(model.size)),
    vram: formatBytes(Number(model.size_vram)),
    processor: formatProcessor(model),
    context: hasSize ? formatInt(contextSize) : '—',
    contextSize: hasSize ? contextSize : null,
    keepAlive: formatKeepAlive(model.expires_at),
  };
}

// Context fill only means something against the window of the model that
// served the request, so it is null when that model is not (or no longer)
// the one described.
function lastSummary(f, details) {
  const size = details.model === f.model ? details.contextSize : null;
  return {
    model: f.model,
    outputTokens: f.outputTokens,
    promptTokens: f.promptTokens,
    promptCachedTokens: f.promptCachedTokens,
    contextUsed: f.contextTokens,
    contextExact: !!f.contextExact,
    contextSize: size,
    contextPercent:
      size && Number.isFinite(f.contextTokens) ? (f.contextTokens / size) * 100 : null,
    tokensPerSec: f.tokensPerSec,
    promptTokensPerSec: f.promptTokensPerSec,
    totalDurationSec: f.totalDurationSec,
  };
}

// Returns { text, tooltip, color, background } for the current proxy state.
// Pure apart from reading the clock, and everything in it is serialisable, so
// render() can compare successive results as strings.
function computeStatus() {
  const s = core.state;
  const now = Date.now();
  const recentFinal =
    s.lastFinal && now - s.lastFinal.finishedAt < LAST_FINAL_WINDOW_MS ? s.lastFinal : null;
  const details = modelDetails(s, recentFinal && recentFinal.model);
  const base = {
    ...details,
    last: recentFinal ? lastSummary(recentFinal, details) : null,
    totals: s.totals || null,
  };

  const err = s.lastError;
  // A one-off request failure stays visible for a minute, then the regular
  // state takes over again; a fatal one (port busy, bad URL) stays.
  const showError = err && (!err.transient || now - (err.at || 0) < TRANSIENT_ERROR_WINDOW_MS);
  if (showError && !err.transient) {
    return {
      text: `${ICON} Error`,
      tooltip: { ...base, status: 'Error', note: `${err.text}: ${err.detail}` },
      color: null,
      background: BG_ERROR,
    };
  }

  if (s.isGenerating) {
    const gen = s.currentGen;
    const elapsedSec = (now - gen.startedAt) / 1000;
    const tps = elapsedSec > 0.25 ? gen.tokens / elapsedSec : 0;
    const count = s.activeGenerations || 1;
    return {
      text: `${ICON} ~${formatCompact(gen.tokens)} tok · ${formatRate(tps)} t/s${count > 1 ? ` ×${count}` : ''}`,
      tooltip: {
        ...base,
        status: 'Generating',
        live: { tokens: gen.tokens, tps, count },
      },
      color: COLOR_GENERATING,
      background: null,
    };
  }

  if (showError) {
    return {
      text: ICON,
      tooltip: {
        ...base,
        status: err.text === 'Ollama error' ? 'Generation failed' : 'Request failed',
        note:
          err.text === 'Ollama error'
            ? `Ollama stopped the request: ${err.detail}`
            : `${err.text}: ${err.detail}. Check that Ollama is running, then try again.`,
      },
      color: null,
      background: BG_WARNING,
    };
  }

  if (s.backendError) {
    const { ollamaUrl } = getConfig();
    return {
      text: ICON,
      tooltip: {
        ...base,
        status: 'Ollama not reachable',
        note:
          `Could not reach Ollama at ${ollamaUrl} (${s.backendError}). ` +
          'Is the Ollama server running and listening there? Run Setup Check for details.',
      },
      color: COLOR_NO_MODEL,
      background: null,
    };
  }

  const status = s.hasLoadedModel ? 'Ready' : 'No model loaded';
  const color = s.hasLoadedModel ? COLOR_MODEL_LOADED : COLOR_NO_MODEL;

  if (recentFinal) {
    const f = recentFinal;
    const pct = base.last.contextPercent;
    const ctx = pct === null ? '' : ` · ${formatPercent(pct)} ctx`;
    const nearlyFull = pct !== null && pct >= CONTEXT_WARN_PERCENT;
    return {
      text: `${ICON} ${formatCompact(f.outputTokens)} out / ${formatCompact(f.promptTokens)} in · ${formatRate(f.tokensPerSec)} t/s${ctx}`,
      tooltip: {
        ...base,
        status,
        note: nearlyFull
          ? `The context window is ${formatPercent(pct)} full. Once it overflows, Ollama ` +
            'silently drops the oldest part of the prompt — start a new chat or raise num_ctx.'
          : null,
      },
      color,
      background: nearlyFull ? BG_WARNING : null,
    };
  }

  return {
    text: ICON,
    tooltip: {
      ...base,
      status,
      note: s.hasLoadedModel
        ? 'No generation has been seen through the proxy yet. Token stats appear here after the next request.'
        : 'Ollama is running, but no model is loaded. One loads on the next request.',
    },
    color,
    background: null,
  };
}

// render() runs on a timer and on every proxy state change. Only touch the
// StatusBarItem when what it shows actually changed: each assignment is an
// IPC round-trip to the renderer, and while idle nothing changes for hours.
function render() {
  if (!statusBarItem || !core) return;
  const next = computeStatus();
  const key = JSON.stringify(next);
  if (key === lastRenderKey) return;
  lastRenderKey = key;
  statusBarItem.text = next.text;
  statusBarItem.tooltip = markdownTooltip(next.tooltip);
  statusBarItem.color = next.color ? new vscode.ThemeColor(next.color) : undefined;
  statusBarItem.backgroundColor = next.background
    ? new vscode.ThemeColor(next.background)
    : undefined;
  statusBarItem.accessibilityInformation = {
    role: 'status',
    label: `Ollama: ${next.tooltip.status}${next.text === ICON ? '' : `, ${next.text.slice(ICON.length).trim()}`}`,
  };
}

function startRenderLoop() {
  clearInterval(renderInterval);
  // Drives the live token counter while generating and the time-based
  // transitions (stats window, error expiry). Cheap when nothing changed:
  // render() bails out before touching the status bar.
  renderInterval = setInterval(render, RENDER_INTERVAL_MS);
  render();
}

async function showMenu() {
  const items = [
    { label: '$(output) Show Log', command: 'ollamaTokenTracker.showOutput' },
    {
      label: '$(checklist) Run Setup Check',
      command: 'ollamaTokenTracker.runSetupCheck',
    },
    {
      label: '$(debug-restart) Restart Proxy',
      command: 'ollamaTokenTracker.restartProxy',
    },
    { label: '$(link) Show Proxy URL', command: 'ollamaTokenTracker.showProxyUrl' },
    {
      label: '$(info) Show Diagnostics',
      command: 'ollamaTokenTracker.showDiagnostics',
    },
    {
      label: '$(gear) Open Settings',
      command: 'workbench.action.openSettings',
      args: ['ollamaTokenTracker'],
    },
  ];
  const pick = await vscode.window.showQuickPick(items, {
    placeHolder: 'Ollama Token Tracker',
  });
  if (pick) vscode.commands.executeCommand(pick.command, ...(pick.args || []));
}

function activate(context) {
  extensionVersion =
    context.extension && context.extension.packageJSON
      ? context.extension.packageJSON.version
      : 'unknown';

  outputChannel = vscode.window.createOutputChannel('Ollama Token Tracker');
  context.subscriptions.push(outputChannel);
  log(`activating v${extensionVersion} from ${context.extensionPath}`);

  statusBarItem = vscode.window.createStatusBarItem(
    'ollamaTokenTracker.status',
    vscode.StatusBarAlignment.Right,
    100,
  );
  statusBarItem.name = 'Ollama Token Tracker';
  statusBarItem.command = 'ollamaTokenTracker.showMenu';
  statusBarItem.accessibilityInformation = {
    role: 'status',
    label: 'Ollama generation status',
  };
  statusBarItem.show();
  lastRenderKey = null;
  context.subscriptions.push(statusBarItem);

  core = new OllamaProxyCore({ log });
  core.onStateChange(render);

  restartEverything();

  const commands = {
    'ollamaTokenTracker.restartProxy': () => {
      log('manual restart requested');
      restartEverything();
    },
    'ollamaTokenTracker.pointCopilotAtProxy': pointCopilotAtProxy,
    'ollamaTokenTracker.showProxyUrl': showProxyUrl,
    'ollamaTokenTracker.showDiagnostics': showDiagnostics,
    'ollamaTokenTracker.runSetupCheck': runSetupCheck,
    'ollamaTokenTracker.showMenu': showMenu,
    'ollamaTokenTracker.showOutput': () => outputChannel.show(true),
  };
  for (const [id, fn] of Object.entries(commands)) {
    context.subscriptions.push(vscode.commands.registerCommand(id, fn));
  }

  // Apply setting changes without a manual "Restart Proxy". Debounced so
  // typing a port number in the Settings UI doesn't rebind on every key.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('ollamaTokenTracker')) return;
      clearTimeout(configRestartTimer);
      configRestartTimer = setTimeout(() => {
        log('settings changed; restarting proxy');
        restartEverything();
      }, 750);
    }),
  );

  context.subscriptions.push({ dispose: shutdown });
}

function shutdown() {
  if (core) core.stop();
  clearInterval(renderInterval);
  clearTimeout(configRestartTimer);
}

function restartEverything() {
  if (core) core.stop();
  const { proxyPort, ollamaUrl } = getConfig();
  // Backend reachability is reported by the model poll (state.backendError,
  // logged on every change), so no separate probe is needed here.
  core.start(proxyPort, ollamaUrl).catch((err) => {
    log(`failed to start proxy on port ${proxyPort}: ${err.message}`);
    // Loud and actionable: any start failure gets a popup explaining it,
    // instead of only a log line and an unexplained red icon.
    const isBindError = err.code === 'EADDRINUSE' || err.code === 'EACCES';
    const message = isBindError
      ? `Ollama Token Tracker couldn't listen on port ${proxyPort} (${err.message}). ` +
        `Something else is already using that port — most often the real Ollama server, ` +
        `a second copy of this extension, or a previous instance that didn't shut down. ` +
        `Run "Run Setup Check" to see what is answering there, or set ` +
        `ollamaTokenTracker.proxyPort to a free port.`
      : `Ollama Token Tracker couldn't start its proxy: ${err.message}. ` +
        `Check the ollamaTokenTracker.proxyPort and ollamaTokenTracker.ollamaUrl settings.`;
    vscode.window.showErrorMessage(message, 'Run Setup Check', 'Open Settings').then((choice) => {
      if (choice === 'Run Setup Check') runSetupCheck();
      if (choice === 'Open Settings')
        vscode.commands.executeCommand('workbench.action.openSettings', 'ollamaTokenTracker');
    });
  });
  core.startModelPoll(ollamaUrl, 2000);
  startRenderLoop();
}

async function showProxyUrl() {
  const { proxyPort } = getConfig();
  const url = `http://127.0.0.1:${proxyPort}`;
  const isOllamaDefaultPort = proxyPort === 11434;
  const choice = await vscode.window.showInformationMessage(
    isOllamaDefaultPort
      ? `This proxy listens on ${url}, which is Ollama's own default port — so anything that ` +
          `talks to Ollama's default address (Copilot Chat included) is already routed through it.`
      : `This proxy listens on ${url}. That is not Ollama's default port (11434), so point your ` +
          `client's Ollama base URL at ${url}, or run "Point Copilot Chat at This Proxy".`,
    'Copy URL',
  );
  if (choice === 'Copy URL') {
    await vscode.env.clipboard.writeText(url);
  }
}

async function pointCopilotAtProxy() {
  const { proxyPort } = getConfig();
  const target = `http://127.0.0.1:${proxyPort}`;
  const config = vscode.workspace.getConfiguration();
  await config.update(
    'github.copilot.chat.byok.ollamaEndpoint',
    target,
    vscode.ConfigurationTarget.Global,
  );
  vscode.window.showInformationMessage(
    `Copilot Chat's Ollama endpoint set to ${target}. Reload the window for it to take effect.`,
  );
}

function probe(url, path) {
  return new Promise((resolve) => {
    let target;
    try {
      target = new URL(url);
    } catch (e) {
      resolve({ ok: false, error: `invalid URL: ${url}` });
      return;
    }
    const isHttps = target.protocol === 'https:';
    const req = (isHttps ? https : http).request(
      {
        hostname: target.hostname,
        port: target.port || (isHttps ? 443 : 80),
        path: target.pathname.replace(/\/+$/, '') + path,
        method: 'GET',
        timeout: 1500,
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve({ ok: true, status: res.statusCode }));
      },
    );
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, error: 'timed out' });
    });
    req.on('error', (err) => resolve({ ok: false, error: err.message }));
    req.end();
  });
}

async function runSetupCheck() {
  const { proxyPort, ollamaUrl } = getConfig();
  outputChannel.show(true);
  log('--- Setup check starting ---');

  const proxyResult = await probe(`http://127.0.0.1:${proxyPort}`, '/api/ps');
  log(
    `Proxy port ${proxyPort} (our own server): ${proxyResult.ok ? `responded, status ${proxyResult.status}` : `NOT reachable (${proxyResult.error})`}`,
  );

  const backendResult = await probe(ollamaUrl, '/api/ps');
  log(
    `Configured Ollama backend ${ollamaUrl}: ${backendResult.ok ? `responded, status ${backendResult.status}` : `NOT reachable (${backendResult.error})`}`,
  );

  let defaultOllamaResult = null;
  if (
    `http://127.0.0.1:${proxyPort}` !== 'http://127.0.0.1:11434' &&
    ollamaUrl !== 'http://127.0.0.1:11434'
  ) {
    defaultOllamaResult = await probe('http://127.0.0.1:11434', '/api/ps');
    log(
      `Ollama's usual default port 11434: ${defaultOllamaResult.ok ? 'something is answering there' : `not reachable (${defaultOllamaResult.error})`}`,
    );
  }

  const lines = [];
  lines.push(`proxyPort = ${proxyPort}, ollamaUrl = ${ollamaUrl}`);
  if (!proxyResult.ok) {
    lines.push(
      '❌ The proxy itself isn\'t answering on its own port — check the Output panel for a startup error, or run "Restart Proxy".',
    );
  } else {
    lines.push('✅ The proxy is up and answering.');
  }
  if (!backendResult.ok) {
    lines.push(
      `❌ The real Ollama server at ${ollamaUrl} isn't reachable. Either Ollama isn't running, or it's listening somewhere else — set OLLAMA_HOST to match ollamaTokenTracker.ollamaUrl, or update the setting to match where Ollama actually listens.`,
    );
  } else {
    lines.push(`✅ The configured Ollama backend at ${ollamaUrl} is reachable.`);
  }
  if (proxyPort === 11434) {
    lines.push(
      "ℹ️ Your proxy is on Ollama's default port (11434), so any tool using Ollama's default endpoint — including Copilot Chat unless you changed it — is already being routed through the proxy with no per-client setup needed.",
    );
  } else {
    lines.push(
      `ℹ️ Your proxy is on a non-default port (${proxyPort}). Nothing will show generation stats until you point a client's Ollama base URL at http://127.0.0.1:${proxyPort} — run "Show Proxy URL" or "Point Copilot Chat at This Proxy".`,
    );
  }

  const summary = lines.join('\n');
  log(summary);
  log('--- Setup check finished (see Output panel above for full detail) ---');
  vscode.window
    .showInformationMessage(
      'Ollama Token Tracker: setup check finished — see the Output panel ("Ollama Token Tracker") for the full report.',
      'Show Output',
    )
    .then((choice) => {
      if (choice === 'Show Output') outputChannel.show(true);
    });
}

async function showDiagnostics() {
  outputChannel.show(true);
  const all = vscode.extensions.all.filter(
    (e) => e.id.toLowerCase() === EXT_ID || e.packageJSON.name === 'ollama-token-tracker',
  );
  log('--- Diagnostics ---');
  log(`This running instance: version ${extensionVersion}`);
  log(
    `Extension path: ${vscode.extensions.getExtension(EXT_ID)?.extensionPath || '(not found under ' + EXT_ID + ')'}`,
  );
  log(`Installed copies matching this extension found by VS Code: ${all.length}`);
  for (const e of all) {
    log(
      `  - id=${e.id} version=${e.packageJSON.version} active=${e.isActive} path=${e.extensionPath}`,
    );
  }
  if (all.length > 1) {
    log(
      '⚠️  More than one installed copy was found. VS Code should only run the highest-version one, ' +
        'but if you have copies in more than one extensions directory (e.g. a dev install alongside a ' +
        'marketplace/VSIX install, or more than one --extensions-dir), the wrong one can end up active. ' +
        'Uninstall the others and reload.',
    );
  }
  const { proxyPort, ollamaUrl } = getConfig();
  log(`Config: proxyPort=${proxyPort} ollamaUrl=${ollamaUrl}`);
  log(`Live state: ${JSON.stringify(core.state, null, 2)}`);
  vscode.window.showInformationMessage(
    `Ollama Token Tracker v${extensionVersion} is the active copy. Full report in the Output panel.`,
  );
}

function deactivate() {
  shutdown();
}

module.exports = { activate, deactivate };
