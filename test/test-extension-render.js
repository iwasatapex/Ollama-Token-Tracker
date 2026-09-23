"use strict";
// Drives the real, shipped ../extension.js render() path with a stubbed
// `vscode` API and a fake proxy core. This is the only automated coverage of
// extension.js itself: it proves the status-bar text uses the contributed
// icon id, and that every state (no model / ready / stats / generating /
// error) produces the right color and tooltip content.
const assert = require("assert");
const Module = require("module");
const path = require("path");

const EXT_DIR = path.resolve(__dirname, "..");

let statusBarItem = null;

class MarkdownString {
  constructor(value) {
    this.value = value;
  }
}

const vscodeStub = {
  StatusBarAlignment: { Right: 2 },
  MarkdownString,
  window: {
    createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} }),
    createStatusBarItem: () => {
      statusBarItem = { text: "", tooltip: null, color: null, name: "", show() {}, dispose() {} };
      return statusBarItem;
    },
    showErrorMessage: () => Promise.resolve(undefined),
    showInformationMessage: () => Promise.resolve(undefined),
  },
  commands: { registerCommand: () => ({ dispose() {} }), executeCommand: () => Promise.resolve() },
  workspace: { getConfiguration: () => ({ get: (k, d) => d, update: () => Promise.resolve() }) },
  extensions: { all: [], getExtension: () => undefined },
  env: { clipboard: { writeText: () => Promise.resolve() } },
  ConfigurationTarget: { Global: 1 },
};

// extension.js is CommonJS and does `require("vscode")`, which only resolves
// inside a real VS Code host, so intercept it before loading the extension.
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "vscode") return vscodeStub;
  return originalLoad.apply(this, arguments);
};

// Swap the real proxy core for a controllable fake so render() can be driven
// deterministically without opening sockets.
const corePath = require.resolve(path.join(EXT_DIR, "ollama-proxy-core.js"));
let fakeCore = null;
class FakeCore {
  constructor() {
    fakeCore = this;
    this.state = {
      isGenerating: false,
      hasLoadedModel: false,
      loadedModels: [],
      lastError: null,
      currentGen: { tokens: 0, startedAt: 0 },
      lastFinal: null,
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

const extension = require(path.join(EXT_DIR, "extension.js"));

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
    console.log("        " + e.message);
  }
}

extension.activate({
  extension: { packageJSON: { version: "4.0.0" } },
  extensionPath: EXT_DIR,
  subscriptions: { push() {} },
});

test("status bar text uses the contributed icon id, not a built-in codicon", () => {
  assert.strictEqual(statusBarItem.text, "$(ollama-tracker)");
});

test("the version from packageJSON reaches the tooltip footer", () => {
  fakeCore.state.loadedModels = [];
  fakeCore.state.hasLoadedModel = false;
  fakeCore.emit();
  assert.ok(
    statusBarItem.tooltip.value.includes("Ollama Token Tracker v4.0.0"),
    statusBarItem.tooltip.value
  );
});

test("no-model state is red and reports Status: No model loaded", () => {
  assert.ok(statusBarItem.tooltip.value.includes("Status: No model loaded"), statusBarItem.tooltip.value);
  assert.strictEqual(statusBarItem.color, "#f14c4c");
});

test("model-loaded state is yellow (Status: Ready) with real model details", () => {
  fakeCore.state.loadedModels = [
    { name: "gemma3:4b", size: 3000000000, size_vram: 3000000000, context_length: 4096 },
  ];
  fakeCore.state.hasLoadedModel = true;
  fakeCore.emit();
  const md = statusBarItem.tooltip.value;
  assert.ok(md.includes("Status: Ready"), md);
  assert.ok(md.includes("Model: gemma3:4b"), md);
  assert.ok(md.includes("Context: 4096"), md);
  assert.ok(md.includes("Processor: 100% GPU"), md);
  assert.strictEqual(statusBarItem.color, "#cca700");
});

test("final token statistics are reported exactly, from lastFinal", () => {
  fakeCore.state.lastFinal = {
    outputTokens: 123,
    promptTokens: 17,
    tokensPerSec: 41,
    model: "gemma3:4b",
    finishedAt: Date.now(),
  };
  fakeCore.emit();
  const md = statusBarItem.tooltip.value;
  assert.ok(md.includes("123 output tokens"), md);
  assert.ok(md.includes("17 prompt tokens"), md);
  assert.ok(md.includes("41.0 tok/s"), md);
  assert.strictEqual(statusBarItem.text, "$(ollama-tracker) 123 out / 17 in");
});

test("a lastFinal older than the five-minute window is not shown", () => {
  fakeCore.state.lastFinal.finishedAt = Date.now() - 6 * 60 * 1000;
  fakeCore.emit();
  assert.ok(!statusBarItem.tooltip.value.includes("tok/s"), statusBarItem.tooltip.value);
});

test("generating state is green and labels the live figure as estimated tokens/s", () => {
  fakeCore.state.isGenerating = true;
  fakeCore.state.currentGen = { tokens: 40, startedAt: Date.now() - 1000 };
  fakeCore.emit();
  const md = statusBarItem.tooltip.value;
  assert.ok(md.includes("Status: Generating"), md);
  assert.ok(md.includes("tok/s"), md);
  assert.ok(md.includes("estimated from streamed text"), md);
  assert.strictEqual(statusBarItem.text, "$(ollama-tracker) ~40 tok");
  assert.strictEqual(statusBarItem.color, "#89d185");
});

test("error state is red and surfaces the underlying error detail", () => {
  fakeCore.state.isGenerating = false;
  fakeCore.state.lastError = { text: "port busy", detail: "EADDRINUSE 127.0.0.1:11436" };
  fakeCore.emit();
  const md = statusBarItem.tooltip.value;
  assert.ok(md.includes("Status: Error"), md);
  assert.ok(md.includes("port busy: EADDRINUSE 127.0.0.1:11436"), md);
  assert.strictEqual(statusBarItem.color, "#f14c4c");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
