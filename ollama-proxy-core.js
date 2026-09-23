"use strict";
const http = require("http");
const https = require("https");
const { OllamaStreamParser, extractFinalStats, estimateResponseTokens } = require("./ollama-stream-parser.js");

/**
 * All of the network/state logic that used to live inline in extension.js,
 * with zero `require("vscode")` anywhere in this file. extension.js wraps
 * this in a thin adapter that pushes state changes onto the StatusBarItem.
 * Keeping this vscode-free is what makes it possible to unit-test the
 * actual proxy against a mock Ollama server outside of a running VS Code
 * instance.
 */
class OllamaProxyCore {
  constructor({ log, requestTimeoutMs = 120000, maxSockets = 50 } = {}) {
    this.log = log || (() => {});
    this.requestTimeoutMs = requestTimeoutMs;
    this.maxSockets = maxSockets;
    this._agent = this._createAgent();
    this._httpsAgent = new https.Agent({ keepAlive: true, maxSockets: this.maxSockets, maxFreeSockets: 10 });
    this.server = null;
    this.pollTimer = null;

    this.state = {
      isGenerating: false,
      hasLoadedModel: false,
      loadedModels: [],
      lastError: null, // { text, detail }
      currentGen: { tokens: 0, startedAt: 0 },
      lastFinal: null, // result of extractFinalStats, plus finishedAt
    };

    this._listeners = new Set();
  }

  _createAgent() {
    return new http.Agent({ keepAlive: true, maxSockets: this.maxSockets, maxFreeSockets: 10 });
  }

  _ensureAgent() {
    if (!this._agent) this._agent = this._createAgent();
    return this._agent;
  }

  onStateChange(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  _emit() {
    for (const fn of this._listeners) fn(this.state);
  }

  start(proxyPort, ollamaUrl) {
    return new Promise((resolve, reject) => {
      let target;
      try {
        target = new URL(ollamaUrl);
      } catch (e) {
        this.state.lastError = { text: "bad URL", detail: `Invalid ollamaUrl: ${ollamaUrl}` };
        this._emit();
        reject(e);
        return;
      }

      this.server = http.createServer((req, res) => this._handleRequest(req, res, target));

      this.server.on("error", (err) => {
        this.state.lastError = {
          text: "port busy",
          detail: `Could not listen on port ${proxyPort}: ${err.message}`,
        };
        this._emit();
        reject(err);
      });

      this.server.listen(proxyPort, "127.0.0.1", () => {
        this.state.lastError = null;
        this._emit();
        this.log(`proxy listening on 127.0.0.1:${proxyPort}, forwarding to ${ollamaUrl}`);
        resolve();
      });
    });
  }

  stop() {
    if (this.server) {
      try {
        this.server.close();
      } catch (e) {
        /* ignore */
      }
      this.server = null;
    }
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this._agent) {
      this._agent.destroy();
      this._agent = null;
    }
    if (this._httpsAgent) {
      this._httpsAgent.destroy();
      this._httpsAgent = null;
    }
    // Drop transient state so a "Restart Proxy" cannot leave a stale
    // "generating" flag or error banner on screen. lastFinal is deliberately
    // kept: it is the last real generation, and whether it is still shown is
    // decided by its own timestamp window in render().
    this.state.isGenerating = false;
    this.state.currentGen = { tokens: 0, startedAt: 0 };
    this.state.lastError = null;
  }

  _handleRequest(req, res, target) {
    // Strip hop-by-hop headers before forwarding. Node sets its own Host and
    // framing headers on the outgoing request, and copying the client's
    // connection/transfer-encoding across can double-encode the body.
    // Content-Length is deliberately kept so ordinary JSON POSTs are not
    // re-chunked on the way out.
    const forwardHeaders = { ...req.headers };
    delete forwardHeaders.host;
    delete forwardHeaders.connection;
    delete forwardHeaders["transfer-encoding"];

    const requestPath = new URL(req.url, "http://127.0.0.1");
    const requestModule = target.protocol === "https:" ? https : http;
    const options = {
      hostname: target.hostname,
      port: target.port || (target.protocol === "https:" ? 443 : 80),
      path: requestPath.pathname + requestPath.search,
      method: req.method,
      headers: forwardHeaders,
      agent: target.protocol === "https:" ? this._httpsAgent : this._ensureAgent(),
    };

    const isGenEndpoint = requestPath.pathname === "/api/generate" || requestPath.pathname === "/api/chat";
    this.log(`proxying ${req.method} ${req.url}${isGenEndpoint ? " (generation endpoint)" : ""}`);

    const proxyReq = requestModule.request(options, (proxyRes) => {
      // Same reasoning as the request side: the proxy is byte-transparent so
      // Content-Length stays valid, but the hop-by-hop framing headers must go
      // or Node re-chunks an already-chunked upstream body.
      const responseHeaders = { ...proxyRes.headers };
      delete responseHeaders.connection;
      delete responseHeaders["transfer-encoding"];
      res.writeHead(proxyRes.statusCode || 502, responseHeaders);

      let parser = null;
      if (isGenEndpoint) {
        this.state.isGenerating = true;
        this.state.currentGen = { tokens: 0, startedAt: Date.now() };
        this._emit();
        parser = new OllamaStreamParser(
          (obj) => this._onDoneObject(obj),
          (obj) => {
            if (!obj.done) this.state.currentGen.tokens += estimateResponseTokens(obj);
          }
        );
      }

      proxyRes.on("data", (chunk) => {
        if (!res.write(chunk)) proxyRes.pause();
        if (!parser) return;
        parser.push(chunk.toString("utf8"));
      });

      res.on("drain", () => proxyRes.resume());

      proxyRes.on("end", () => {
        if (parser) parser.end();
        res.end();
        if (isGenEndpoint) {
          this.state.isGenerating = false;
          this._emit();
        }
      });

      proxyRes.on("error", (err) => {
        proxyReq.destroy(err);
      });
    });

    proxyReq.setTimeout(this.requestTimeoutMs, () => {
      const timeoutError = new Error(`upstream request timed out after ${this.requestTimeoutMs}ms`);
      timeoutError.code = "ETIMEDOUT";
      proxyReq.destroy(timeoutError);
    });

    let requestFinished = false;
    const cancelUpstream = () => {
      if (requestFinished) return;
      requestFinished = true;
      proxyReq.destroy();
    };
    req.on("aborted", cancelUpstream);
    req.on("error", cancelUpstream);
    res.on("close", cancelUpstream);

    proxyReq.on("error", (err) => {
      requestFinished = true;
      if (req.destroyed || res.destroyed) return;
      this.state.isGenerating = false;
      this.state.lastError = { text: "proxy error", detail: err.message };
      this._emit();
      if (!res.headersSent) {
        res.writeHead(502, { "Content-Type": "text/plain" });
      }
      res.end("Ollama Token Tracker proxy error: " + err.message);
    });

    proxyReq.on("close", () => {
      requestFinished = true;
    });

    req.pipe(proxyReq);
  }

  _onDoneObject(obj) {
    const stats = extractFinalStats(obj);
    if (!stats) {
      this.log("done object seen but had no usable eval_count/eval_duration; not recording stats");
      return;
    }
    this.state.lastFinal = { ...stats, finishedAt: Date.now() };
    this.log(
      `generation finished: ${stats.outputTokens} output tokens, ${stats.promptTokens} prompt tokens, ${stats.tokensPerSec.toFixed(1)} tok/s, model=${stats.model}`
    );
    this._emit();
  }

  startModelPoll(ollamaUrl, intervalMs = 2000) {
    const poll = () => this._pollOnce(ollamaUrl);
    this.pollTimer = setInterval(poll, intervalMs);
    poll();
  }

  _pollOnce(ollamaUrl) {
    let target;
    try {
      target = new URL(ollamaUrl);
    } catch (e) {
      return;
    }
    const requestModule = target.protocol === "https:" ? https : http;
    const req = requestModule.request(
      {
        hostname: target.hostname,
        port: target.port || (target.protocol === "https:" ? 443 : 80),
        path: "/api/ps",
        method: "GET",
        timeout: 1500,
        agent: target.protocol === "https:" ? this._httpsAgent : this._ensureAgent(),
      },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          try {
            const parsed = JSON.parse(body);
            const models = Array.isArray(parsed.models) ? parsed.models : [];
            const loaded = models.length > 0;
            const modelsChanged =
              loaded !== this.state.hasLoadedModel ||
              JSON.stringify(models) !== JSON.stringify(this.state.loadedModels);
            if (loaded !== this.state.hasLoadedModel) {
              this.log(`model-loaded state changed: ${this.state.hasLoadedModel} -> ${loaded}`);
            }
            this.state.hasLoadedModel = loaded;
            this.state.loadedModels = models;
            if (modelsChanged) this._emit();
          } catch (e) {
            this.state.hasLoadedModel = false;
            this.state.loadedModels = [];
            this._emit();
          }
        });
      }
    );
    req.on("timeout", () => req.destroy());
    req.on("error", () => {
      this.state.hasLoadedModel = false;
      this.state.loadedModels = [];
      this._emit();
    });
    req.end();
  }
}

module.exports = { OllamaProxyCore };
