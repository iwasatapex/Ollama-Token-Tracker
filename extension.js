"use strict";
const vscode = require("vscode");
const http = require("http");
const { OllamaProxyCore } = require("./ollama-proxy-core.js");
const { buildStatusMarkdown, formatBytes, formatProcessor } = require("./status-tooltip.js");

const EXT_ID = "local-user.ollama-token-tracker";

let statusBarItem;
let renderInterval;
let core;
let outputChannel;
let extensionVersion = "unknown";

const COLOR_NO_MODEL = "#f14c4c";
const COLOR_MODEL_LOADED = "#cca700";
const COLOR_GENERATING = "#89d185";

// The project's own single-color glyph, contributed as an icon by
// `contributes.icons` in package.json (font at media/ollama-tracker-103.woff,
// built from icon-build/svg/ollama-tracker.svg). Contributed icon ids are
// usable anywhere a label is rendered, StatusBarItem.text included, so this
// renders as the alpaca face in the screenshots rather than a built-in codicon.
const ICON = "$(ollama-tracker)";

function getConfig() {
  const cfg = vscode.workspace.getConfiguration("ollamaTokenTracker");
  return {
    proxyPort: cfg.get("proxyPort", 11434),
    ollamaUrl: cfg.get("ollamaUrl", "http://127.0.0.1:11435"),
  };
}

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  if (outputChannel) outputChannel.appendLine(line);
}

function markdownTooltip(params) {
  const markdown = buildStatusMarkdown({
    status: params.status,
    model: params.model,
    size: params.size,
    vram: params.vram,
    processor: params.processor,
    context: params.context,
    note: params.note,
    version: extensionVersion,
  });
  const tooltip = new vscode.MarkdownString(markdown, true);
  tooltip.supportHtml = true;
  return tooltip;
}

function render() {
  if (!statusBarItem || !core) return;
  const s = core.state;
  const now = Date.now();

  const model = (s.loadedModels && s.loadedModels[0]) || {};
  const modelName = model.name || model.model || "Unknown model";
  const size = formatBytes(Number(model.size));
  const vram = formatBytes(Number(model.size_vram));
  const processor = formatProcessor(model);
  const context = model.context_length ?? model.context ?? "—";

  if (s.lastError) {
    statusBarItem.text = ICON;
    statusBarItem.tooltip = markdownTooltip({
      status: "Error",
      model: modelName,
      size,
      vram,
      processor,
      context,
      note: `${s.lastError.text}: ${s.lastError.detail}`,
    });
    statusBarItem.color = COLOR_NO_MODEL;
    return;
  }

  if (s.isGenerating) {
    const elapsedSec = (now - s.currentGen.startedAt) / 1000;
    const liveTps = elapsedSec > 0 ? (s.currentGen.tokens / elapsedSec).toFixed(1) : "0.0";
    statusBarItem.text = `${ICON} ~${s.currentGen.tokens} tok`;
    statusBarItem.tooltip = markdownTooltip({
      status: "Generating",
      model: modelName,
      size,
      vram,
      processor,
      context,
      note: `Live estimate: ~${liveTps} tok/s (estimated from streamed text; exact count shown when done).`,
    });
    statusBarItem.color = COLOR_GENERATING;
    return;
  }

  if (s.lastFinal && now - s.lastFinal.finishedAt < 5 * 60 * 1000) {
    const f = s.lastFinal;
    statusBarItem.text = `${ICON} ${f.outputTokens} out / ${f.promptTokens} in`;
    statusBarItem.tooltip = markdownTooltip({
      status: "Ready",
      model: f.model || modelName,
      size,
      vram,
      processor,
      context,
      note: `Last generation: ${f.outputTokens} output tokens • ${f.promptTokens} prompt tokens • ${f.tokensPerSec.toFixed(1)} tok/s`,
    });
    statusBarItem.color = s.hasLoadedModel ? COLOR_MODEL_LOADED : COLOR_NO_MODEL;
    return;
  }

  if (s.hasLoadedModel) {
    statusBarItem.text = ICON;
    statusBarItem.tooltip = markdownTooltip({
      status: "Ready",
      model: modelName,
      size,
      vram,
      processor,
      context,
      note: "No generation has been observed through the proxy yet — token stats will appear here once a request goes through it.",
    });
    statusBarItem.color = COLOR_MODEL_LOADED;
    return;
  }

  statusBarItem.text = ICON;
  statusBarItem.tooltip = markdownTooltip({
    status: "No model loaded",
    model: "—",
    size: "—",
    vram: "—",
    processor: "—",
    context: "—",
    note: "No model is currently loaded in Ollama.",
  });
  statusBarItem.color = COLOR_NO_MODEL;
}

function startRenderLoop() {
  clearInterval(renderInterval);
  renderInterval = setInterval(render, 500);
  render();
}

function activate(context) {
  extensionVersion = context.extension && context.extension.packageJSON
    ? context.extension.packageJSON.version
    : "unknown";

  outputChannel = vscode.window.createOutputChannel("Ollama Token Tracker");
  context.subscriptions.push(outputChannel);
  log(`activating v${extensionVersion} from ${context.extensionPath}`);

  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.name = "Ollama Token Tracker";
  statusBarItem.accessibilityInformation = { role: "status", label: "Ollama generation status" };
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  core = new OllamaProxyCore({ log });
  core.onStateChange(render);

  restartEverything();

  context.subscriptions.push(
    vscode.commands.registerCommand("ollamaTokenTracker.restartProxy", () => {
      log("manual restart requested");
      restartEverything();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("ollamaTokenTracker.pointCopilotAtProxy", pointCopilotAtProxy)
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("ollamaTokenTracker.showProxyUrl", showProxyUrl)
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("ollamaTokenTracker.showDiagnostics", showDiagnostics)
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("ollamaTokenTracker.runSetupCheck", runSetupCheck)
  );

  context.subscriptions.push({
    dispose: () => {
      if (core) core.stop();
      clearInterval(renderInterval);
    },
  });
}

function restartEverything() {
  if (core) core.stop();
  const { proxyPort, ollamaUrl } = getConfig();
  core
    .start(proxyPort, ollamaUrl)
    .then(() => {
      // Sanity-check that the thing we're forwarding to is actually
      // reachable, so a silent misconfiguration doesn't just sit there
      // forever as an unexplained red icon.
      probe(ollamaUrl, "/api/ps").then((r) => {
        if (!r.ok) {
          log(`WARNING: configured ollamaUrl ${ollamaUrl} is not reachable: ${r.error}`);
        }
      });
    })
    .catch((err) => {
      log(`failed to start proxy on port ${proxyPort}: ${err.message}`);
      // Loud, actionable, and independent of which port is configured: any
      // bind failure gets a popup explaining it, instead of only a log line
      // and an unexplained red icon.
      vscode.window
        .showErrorMessage(
          `Ollama Token Tracker couldn't listen on port ${proxyPort} (${err.message}). ` +
            `Something else is already using that port — most often the real Ollama server, ` +
            `a second copy of this extension, or a previous instance that didn't shut down. ` +
            `Run "Run Setup Check" to see what is answering there, or set ` +
            `ollamaTokenTracker.proxyPort to a free port and run "Restart Proxy".`,
          "Run Setup Check",
          "Open Settings"
        )
        .then((choice) => {
          if (choice === "Run Setup Check") runSetupCheck();
          if (choice === "Open Settings") vscode.commands.executeCommand("workbench.action.openSettings", "ollamaTokenTracker");
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
    "Copy URL"
  );
  if (choice === "Copy URL") {
    await vscode.env.clipboard.writeText(url);
  }
}

async function pointCopilotAtProxy() {
  const { proxyPort } = getConfig();
  const target = `http://127.0.0.1:${proxyPort}`;
  const config = vscode.workspace.getConfiguration();
  await config.update("github.copilot.chat.byok.ollamaEndpoint", target, vscode.ConfigurationTarget.Global);
  vscode.window.showInformationMessage(
    `Copilot Chat's Ollama endpoint set to ${target}. Reload the window for it to take effect.`
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
    const req = http.request(
      {
        hostname: target.hostname,
        port: target.port || (target.protocol === "https:" ? 443 : 80),
        path,
        method: "GET",
        timeout: 1500,
      },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ ok: true, status: res.statusCode, body }));
      }
    );
    req.on("timeout", () => {
      req.destroy();
      resolve({ ok: false, error: "timed out" });
    });
    req.on("error", (err) => resolve({ ok: false, error: err.message }));
    req.end();
  });
}

async function runSetupCheck() {
  const { proxyPort, ollamaUrl } = getConfig();
  outputChannel.show(true);
  log("--- Setup check starting ---");

  const proxyResult = await probe(`http://127.0.0.1:${proxyPort}`, "/api/ps");
  log(
    `Proxy port ${proxyPort} (our own server): ${proxyResult.ok ? `responded, status ${proxyResult.status}` : `NOT reachable (${proxyResult.error})`}`
  );

  const backendResult = await probe(ollamaUrl, "/api/ps");
  log(
    `Configured Ollama backend ${ollamaUrl}: ${backendResult.ok ? `responded, status ${backendResult.status}` : `NOT reachable (${backendResult.error})`}`
  );

  let defaultOllamaResult = null;
  if (`http://127.0.0.1:${proxyPort}` !== "http://127.0.0.1:11434" && ollamaUrl !== "http://127.0.0.1:11434") {
    defaultOllamaResult = await probe("http://127.0.0.1:11434", "/api/ps");
    log(
      `Ollama's usual default port 11434: ${defaultOllamaResult.ok ? "something is answering there" : `not reachable (${defaultOllamaResult.error})`}`
    );
  }

  const lines = [];
  lines.push(`proxyPort = ${proxyPort}, ollamaUrl = ${ollamaUrl}`);
  if (!proxyResult.ok) {
    lines.push("❌ The proxy itself isn't answering on its own port — check the Output panel for a startup error, or run \"Restart Proxy\".");
  } else {
    lines.push("✅ The proxy is up and answering.");
  }
  if (!backendResult.ok) {
    lines.push(
      `❌ The real Ollama server at ${ollamaUrl} isn't reachable. Either Ollama isn't running, or it's listening somewhere else — set OLLAMA_HOST to match ollamaTokenTracker.ollamaUrl, or update the setting to match where Ollama actually listens.`
    );
  } else {
    lines.push(`✅ The configured Ollama backend at ${ollamaUrl} is reachable.`);
  }
  if (proxyPort === 11434) {
    lines.push(
      "ℹ️ Your proxy is on Ollama's default port (11434), so any tool using Ollama's default endpoint — including Copilot Chat unless you changed it — is already being routed through the proxy with no per-client setup needed."
    );
  } else {
    lines.push(
      `ℹ️ Your proxy is on a non-default port (${proxyPort}). Nothing will show generation stats until you point a client's Ollama base URL at http://127.0.0.1:${proxyPort} — run "Show Proxy URL" or "Point Copilot Chat at This Proxy".`
    );
  }

  const summary = lines.join("\n");
  log(summary);
  log("--- Setup check finished (see Output panel above for full detail) ---");
  vscode.window.showInformationMessage("Ollama Token Tracker: setup check finished — see the Output panel (\"Ollama Token Tracker\") for the full report.", "Show Output").then((choice) => {
    if (choice === "Show Output") outputChannel.show(true);
  });
}

async function showDiagnostics() {
  outputChannel.show(true);
  const all = vscode.extensions.all.filter(
    (e) => e.id.toLowerCase() === EXT_ID || e.packageJSON.name === "ollama-token-tracker"
  );
  log("--- Diagnostics ---");
  log(`This running instance: version ${extensionVersion}`);
  log(`Extension path: ${vscode.extensions.getExtension(EXT_ID)?.extensionPath || "(not found under " + EXT_ID + ")"}`);
  log(`Installed copies matching this extension found by VS Code: ${all.length}`);
  for (const e of all) {
    log(`  - id=${e.id} version=${e.packageJSON.version} active=${e.isActive} path=${e.extensionPath}`);
  }
  if (all.length > 1) {
    log(
      "⚠️  More than one installed copy was found. VS Code should only run the highest-version one, " +
        "but if you have copies in more than one extensions directory (e.g. a dev install alongside a " +
        "marketplace/VSIX install, or more than one --extensions-dir), the wrong one can end up active. " +
        "Uninstall the others and reload."
    );
  }
  const { proxyPort, ollamaUrl } = getConfig();
  log(`Config: proxyPort=${proxyPort} ollamaUrl=${ollamaUrl}`);
  log(`Live state: ${JSON.stringify(core.state, null, 2)}`);
  vscode.window.showInformationMessage(`Ollama Token Tracker v${extensionVersion} is the active copy. Full report in the Output panel.`);
}

function deactivate() {
  if (core) core.stop();
  clearInterval(renderInterval);
}

module.exports = { activate, deactivate };
