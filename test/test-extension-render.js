'use strict';
// Drives the real, shipped ../extension.js render() path with a stubbed
// `vscode` API and a fake proxy core. This is the only automated coverage of
// extension.js itself: it proves the status-bar text uses the contributed
// icon id, and that every state (no model / ready / stats / generating /
// error) produces the right color and tooltip content.
const assert = require('assert');
const Module = require('module');
const path = require('path');

const EXT_DIR = path.resolve(__dirname, '..');

let statusBarItem = null;

class MarkdownString {
  constructor(value) {
    this.value = value;
  }
}

class ThemeColor {
  constructor(id) {
    this.id = id;
  }
}

let statusBarWrites = 0;

const vscodeStub = {
  StatusBarAlignment: { Right: 2 },
  MarkdownString,
  ThemeColor,
  window: {
    showQuickPick: () => Promise.resolve(undefined),
    createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} }),
    createStatusBarItem: () => {
      const item = { tooltip: null, color: null, name: '', show() {}, dispose() {} };
      let text = '';
      Object.defineProperty(item, 'text', {
        get: () => text,
        set: (v) => {
          statusBarWrites++;
          text = v;
        },
      });
      statusBarItem = item;
      return statusBarItem;
    },
    showErrorMessage: () => Promise.resolve(undefined),
    showInformationMessage: () => Promise.resolve(undefined),
  },
  commands: {
    registerCommand: () => ({ dispose() {} }),
    executeCommand: () => Promise.resolve(),
  },
  workspace: {
    getConfiguration: () => ({ get: (k, d) => d, update: () => Promise.resolve() }),
    onDidChangeConfiguration: () => ({ dispose() {} }),
  },
  extensions: { all: [], getExtension: () => undefined },
  env: { clipboard: { writeText: () => Promise.resolve() } },
  ConfigurationTarget: { Global: 1 },
};

// extension.js is CommonJS and does `require("vscode")`, which only resolves
// inside a real VS Code host, so intercept it before loading the extension.
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') return vscodeStub;
  return originalLoad.apply(this, arguments);
};

// Swap the real proxy core for a controllable fake so render() can be driven
// deterministically without opening sockets.
const corePath = require.resolve(path.join(EXT_DIR, 'ollama-proxy-core.js'));
let fakeCore = null;
class FakeCore {
  constructor() {
    fakeCore = this;
    this.state = {
      isGenerating: false,
      hasLoadedModel: false,
      loadedModels: [],
      activeGenerations: 0,
      backendError: null,
      lastError: null,
      currentGen: { tokens: 0, startedAt: 0 },
      lastFinal: null,
      totals: { generations: 0, outputTokens: 0, promptTokens: 0 },
    };
    this._listeners = new Set();
  }
  onStateChange(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }
  start() {
    return Promise.resolve();
  }
  stop() {}
  startModelPoll() {}
  emit() {
    for (const fn of this._listeners) fn(this.state);
  }
}
require.cache[corePath] = {
  id: corePath,
  filename: corePath,
  loaded: true,
  exports: { OllamaProxyCore: FakeCore },
};

const extension = require(path.join(EXT_DIR, 'extension.js'));

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok  - ${name}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL - ${name}`);
    console.log('        ' + e.message);
  }
}

extension.activate({
  extension: { packageJSON: { version: '4.0.0' } },
  extensionPath: EXT_DIR,
  subscriptions: { push() {} },
});

const colorId = () => statusBarItem.color && statusBarItem.color.id;
const bgId = () => statusBarItem.backgroundColor && statusBarItem.backgroundColor.id;
const md = () => statusBarItem.tooltip.value;

test('status bar text uses the contributed icon id, not a built-in codicon', () => {
  assert.strictEqual(statusBarItem.text, '$(ollama-tracker)');
});

test('clicking the status bar item opens the action menu', () => {
  assert.strictEqual(statusBarItem.command, 'ollamaTokenTracker.showMenu');
});

test('the version from packageJSON reaches the tooltip footer', () => {
  fakeCore.state.loadedModels = [];
  fakeCore.state.hasLoadedModel = false;
  fakeCore.emit();
  assert.ok(md().includes('Ollama Token Tracker v4.0.0'), md());
});

test('tooltip footer carries trusted command links', () => {
  assert.ok(md().includes('(command:ollamaTokenTracker.runSetupCheck)'), md());
  assert.ok(
    statusBarItem.tooltip.isTrusted.enabledCommands.includes('ollamaTokenTracker.runSetupCheck'),
  );
});

test('no-model state is red and reports No model loaded', () => {
  assert.ok(md().includes('**Ollama · No model loaded**'), md());
  assert.strictEqual(colorId(), 'charts.red');
  assert.strictEqual(bgId(), undefined);
});

test('an unreachable backend is reported as such, not as "no model loaded"', () => {
  fakeCore.state.backendError = 'connect ECONNREFUSED 127.0.0.1:11435';
  fakeCore.emit();
  assert.ok(md().includes('Ollama not reachable'), md());
  assert.ok(md().includes('ECONNREFUSED'), md());
  assert.strictEqual(colorId(), 'charts.red');
  fakeCore.state.backendError = null;
});

test('model-loaded state is yellow (Ready) with real model details in a table', () => {
  fakeCore.state.loadedModels = [
    {
      name: 'gemma3:4b',
      size: 3000000000,
      size_vram: 3000000000,
      context_length: 32768,
      expires_at: new Date(Date.now() + 4 * 60 * 1000 + 1000).toISOString(),
    },
  ];
  fakeCore.state.hasLoadedModel = true;
  fakeCore.emit();
  assert.ok(md().includes('**Ollama · Ready**'), md());
  assert.ok(md().includes('| **Model** | **gemma3:4b** |'), md());
  assert.ok(md().includes('| Context | 32,768 |'), md());
  assert.ok(md().includes('| Processor | 100% GPU |'), md());
  assert.ok(md().includes('| Keep-alive | unloads in 5 min |'), md());
  assert.strictEqual(colorId(), 'charts.yellow');
});

test('final token statistics are reported exactly, from lastFinal', () => {
  fakeCore.state.lastFinal = {
    outputTokens: 123,
    promptTokens: 17,
    tokensPerSec: 41,
    promptTokensPerSec: 113.33,
    totalDurationSec: 3.4,
    model: 'gemma3:4b',
    finishedAt: Date.now(),
  };
  fakeCore.state.totals = { generations: 2, outputTokens: 1234, promptTokens: 40 };
  fakeCore.emit();
  assert.ok(md().includes('| Output | 123 tokens · 41.0 tok/s |'), md());
  assert.ok(md().includes('| Prompt | 17 tokens · 113 tok/s |'), md());
  fakeCore.state.lastFinal.promptCachedTokens = 12;
  fakeCore.emit();
  assert.ok(md().includes('| Prompt | 17 tokens (12 cached) · 113 tok/s |'), md());
  assert.ok(md().includes('| Total time | 3.4 s |'), md());
  assert.ok(md().includes('Session: 2 generations · 1,234 out · 40 in'), md());
  assert.strictEqual(statusBarItem.text, '$(ollama-tracker) 123 out / 17 in · 41.0 t/s');
});

test('large counts are compacted in the status bar but exact in the tooltip', () => {
  fakeCore.state.lastFinal = {
    ...fakeCore.state.lastFinal,
    outputTokens: 2345,
    promptTokens: 18000,
  };
  fakeCore.emit();
  assert.strictEqual(statusBarItem.text, '$(ollama-tracker) 2.3k out / 18k in · 41.0 t/s');
  assert.ok(md().includes('| Output | 2,345 tokens'), md());
  fakeCore.state.lastFinal = {
    ...fakeCore.state.lastFinal,
    outputTokens: 123,
    promptTokens: 17,
  };
});

test('context fill is shown against the loaded model context window', () => {
  fakeCore.state.lastFinal = {
    ...fakeCore.state.lastFinal,
    contextTokens: 8192,
    contextExact: false,
  };
  fakeCore.emit();
  assert.strictEqual(statusBarItem.text, '$(ollama-tracker) 123 out / 17 in · 41.0 t/s · 25% ctx');
  assert.ok(md().includes('| Context used | ███░░░░░░░ ≈8,192 / 32,768 tokens (25%) |'), md());
  assert.strictEqual(bgId(), undefined);
});

test('an exact context count (from /api/generate) is not marked approximate', () => {
  fakeCore.state.lastFinal = {
    ...fakeCore.state.lastFinal,
    contextTokens: 100,
    contextExact: true,
  };
  fakeCore.emit();
  assert.ok(statusBarItem.text.endsWith('· <1% ctx'), statusBarItem.text);
  assert.ok(md().includes(' 100 / 32,768 tokens (<1%)'), md());
});

test('a nearly full context window turns the item to a warning with advice', () => {
  fakeCore.state.lastFinal = { ...fakeCore.state.lastFinal, contextTokens: 31000 };
  fakeCore.emit();
  assert.ok(statusBarItem.text.endsWith('· 95% ctx'), statusBarItem.text);
  assert.strictEqual(bgId(), 'statusBarItem.warningBackground');
  assert.ok(md().includes('context window is 95% full'), md());
});

test('context fill is omitted when the window size is unknown', () => {
  const saved = fakeCore.state.loadedModels;
  fakeCore.state.loadedModels = [{ name: 'gemma3:4b', size: 3e9, size_vram: 3e9 }];
  fakeCore.emit();
  assert.ok(!statusBarItem.text.includes('ctx'), statusBarItem.text);
  assert.ok(md().includes('31,000 tokens (context size unknown)'), md());
  fakeCore.state.loadedModels = saved;
  fakeCore.state.lastFinal = { ...fakeCore.state.lastFinal, contextTokens: undefined };
});

test('model details follow the model of the last generation, other models are listed', () => {
  fakeCore.state.loadedModels = [
    { name: 'llama3:8b', size: 5e9, size_vram: 0 },
    fakeCore.state.loadedModels[0],
  ];
  fakeCore.emit();
  assert.ok(md().includes('| **Model** | **gemma3:4b** |'), md());
  assert.ok(md().includes('| Also loaded | llama3:8b |'), md());
  fakeCore.state.loadedModels = [fakeCore.state.loadedModels[1]];
});

test('a lastFinal older than the five-minute window is not shown', () => {
  fakeCore.state.lastFinal.finishedAt = Date.now() - 6 * 60 * 1000;
  fakeCore.emit();
  assert.ok(!md().includes('| Output |'), md());
  assert.strictEqual(statusBarItem.text, '$(ollama-tracker)');
});

test('generating state is green and labels the live figures as estimates', () => {
  fakeCore.state.isGenerating = true;
  fakeCore.state.activeGenerations = 1;
  fakeCore.state.currentGen = { tokens: 40, startedAt: Date.now() - 1000 };
  fakeCore.emit();
  assert.ok(md().includes('**Ollama · Generating**'), md());
  assert.ok(md().includes('estimated from streamed text'), md());
  assert.ok(
    /^\$\(ollama-tracker\) ~40 tok · \d+\.\d t\/s$/.test(statusBarItem.text),
    statusBarItem.text,
  );
  assert.strictEqual(colorId(), 'charts.green');
});

test('parallel generations are counted', () => {
  fakeCore.state.activeGenerations = 2;
  fakeCore.emit();
  assert.ok(statusBarItem.text.endsWith('×2'), statusBarItem.text);
  assert.ok(md().includes('2 requests in parallel'), md());
  fakeCore.state.isGenerating = false;
  fakeCore.state.activeGenerations = 0;
});

test('a transient request error shows a warning, then expires after a minute', () => {
  fakeCore.state.lastError = {
    text: 'proxy error',
    detail: 'socket hang up',
    at: Date.now(),
    transient: true,
  };
  fakeCore.emit();
  assert.ok(md().includes('Request failed'), md());
  assert.strictEqual(bgId(), 'statusBarItem.warningBackground');
  fakeCore.state.lastError.at = Date.now() - 2 * 60 * 1000;
  fakeCore.emit();
  assert.ok(!md().includes('Request failed'), md());
  assert.strictEqual(bgId(), undefined);
  fakeCore.state.lastError = null;
});

test('an error reported by Ollama itself reads as a failed generation', () => {
  fakeCore.state.lastError = {
    text: 'Ollama error',
    detail: 'prediction aborted, token repeat limit reached',
    at: Date.now(),
    transient: true,
  };
  fakeCore.emit();
  assert.ok(md().includes('Generation failed'), md());
  assert.ok(md().includes('Ollama stopped the request: prediction aborted'), md());
  assert.ok(!md().includes('Check that Ollama is running'), md());
  fakeCore.state.lastError = null;
});

test('a fatal error uses the error background and surfaces the detail', () => {
  fakeCore.state.lastError = {
    text: 'port busy',
    detail: 'EADDRINUSE 127.0.0.1:11436',
    at: Date.now(),
    transient: false,
  };
  fakeCore.emit();
  assert.ok(md().includes('**Ollama · Error**'), md());
  assert.ok(md().includes('port busy: EADDRINUSE 127.0.0.1:11436'), md());
  assert.strictEqual(bgId(), 'statusBarItem.errorBackground');
  assert.strictEqual(statusBarItem.text, '$(ollama-tracker) Error');
  fakeCore.state.lastError = null;
});

test('network-supplied text cannot inject markdown or HTML into the tooltip', () => {
  fakeCore.state.lastError = {
    text: 'x',
    detail: '<img src=x> [click](command:evil) **b**',
    at: Date.now(),
    transient: false,
  };
  fakeCore.emit();
  assert.ok(!md().includes('<img'), md());
  assert.ok(!md().includes('[click](command:evil)'), md());
  assert.ok(md().includes('&lt;img'), md());
  fakeCore.state.lastError = null;
});

test('an unchanged state does not rewrite the status bar', () => {
  fakeCore.emit();
  const before = statusBarWrites;
  fakeCore.emit();
  fakeCore.emit();
  assert.strictEqual(statusBarWrites, before);
});

extension.deactivate();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
