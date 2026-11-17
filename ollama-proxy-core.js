'use strict';
const http = require('http');
const https = require('https');
const { StringDecoder } = require('string_decoder');
const {
  OllamaStreamParser,
  extractFinalStats,
  estimateResponseTokens,
} = require('./ollama-stream-parser.js');

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]', '0.0.0.0']);

function defaultPort(target) {
  return Number(target.port) || (target.protocol === 'https:' ? 443 : 80);
}

function emptyGen() {
  return { tokens: 0, startedAt: 0 };
}

/**
 * All of the network/state logic that used to live inline in extension.js,
 * with zero `require("vscode")` anywhere in this file. extension.js wraps
 * this in a thin adapter that pushes state changes onto the StatusBarItem.
 * Keeping this vscode-free is what makes it possible to unit-test the
 * actual proxy against a mock Ollama server outside of a running VS Code
 * instance.
 */
class OllamaProxyCore {
  // requestTimeoutMs is an *idle* timeout on the upstream socket. Ollama sends
  // nothing while it loads a model or processes a long prompt, which on large
  // partially-offloaded models regularly exceeds two minutes, so the default
  // has to be generous or the proxy aborts requests Ollama would have answered.
  constructor({ log, requestTimeoutMs = 600000, maxSockets = 50 } = {}) {
    this.log = log || (() => {});
    this.requestTimeoutMs = requestTimeoutMs;
    this.maxSockets = maxSockets;
    this._agent = null;
    this._httpsAgent = null;
    this.server = null;
    this.pollTimer = null;
    this._pollInFlight = false;
    this._activeGens = new Set();

    this.state = {
      isGenerating: false,
      activeGenerations: 0,
      hasLoadedModel: false,
      loadedModels: [],
      // null when the last /api/ps poll succeeded, else why it failed. Lets
      // the UI tell "Ollama is down" apart from "Ollama is up, nothing loaded".
      backendError: null,
      // { text, detail, at, transient }. Transient errors (one failed proxied
      // request) clear on the next successful upstream response; non-transient
      // ones (cannot bind the port, bad URL) persist until the next start().
      lastError: null,
      currentGen: emptyGen(),
      lastFinal: null, // result of extractFinalStats, plus finishedAt
      totals: { generations: 0, outputTokens: 0, promptTokens: 0 },
    };

    this._listeners = new Set();
  }

  _agentFor(target) {
    const opts = { keepAlive: true, maxSockets: this.maxSockets, maxFreeSockets: 10 };
    if (target.protocol === 'https:') {
      if (!this._httpsAgent) this._httpsAgent = new https.Agent(opts);
      return this._httpsAgent;
    }
    if (!this._agent) this._agent = new http.Agent(opts);
    return this._agent;
  }

  onStateChange(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  _emit() {
    for (const fn of this._listeners) {
      try {
        fn(this.state);
      } catch (e) {
        this.log(`state listener threw: ${e && e.message}`);
      }
    }
  }

  _setError(text, detail, transient) {
    this.state.lastError = { text, detail, at: Date.now(), transient: !!transient };
    this._emit();
  }

  start(proxyPort, ollamaUrl) {
    return new Promise((resolve, reject) => {
      let target;
      try {
        target = new URL(ollamaUrl);
        if (target.protocol !== 'http:' && target.protocol !== 'https:') {
          throw new Error(`unsupported protocol ${target.protocol}`);
        }
      } catch (e) {
        this._setError('bad URL', `Invalid ollamaUrl "${ollamaUrl}": ${e.message}`, false);
        reject(e);
        return;
      }

      // Forwarding to our own listen address would make every request proxy
      // to itself until sockets run out. Refuse instead of melting down.
      if (
        proxyPort &&
        LOOPBACK_HOSTS.has(target.hostname) &&
        defaultPort(target) === Number(proxyPort)
      ) {
        const err = new Error(
          `ollamaUrl (${ollamaUrl}) points at the proxy's own port ${proxyPort}; ` +
            'it must point at the real Ollama server',
        );
        this._setError('config loop', err.message, false);
        reject(err);
        return;
      }

      const server = http.createServer((req, res) => this._handleRequest(req, res, target));
      this.server = server;

      server.on('error', (err) => {
        this._setError('port busy', `Could not listen on port ${proxyPort}: ${err.message}`, false);
        reject(err);
      });

      server.listen(proxyPort, '127.0.0.1', () => {
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
        // Keep-alive client sockets would otherwise hold the old server (and
        // its in-flight requests) open after a restart or deactivate.
        if (typeof this.server.closeAllConnections === 'function') {
          this.server.closeAllConnections();
        }
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
    // "generating" flag or error banner on screen. lastFinal and totals are
    // deliberately kept: they describe real past generations.
    this._activeGens.clear();
    this._syncGenState();
    this.state.lastError = null;
    this.state.backendError = null;
  }

  // --- generation bookkeeping -------------------------------------------
  // Each proxied /api/generate or /api/chat response is one generation.
  // Several can run at once (parallel requests, OLLAMA_NUM_PARALLEL), so
  // "is generating" is a count, and ending one must be idempotent: it is
  // reached from end, close, error and client-abort paths.

  _beginGeneration() {
    const gen = { tokens: 0, startedAt: Date.now() };
    this._activeGens.add(gen);
    this._syncGenState();
    this._emit();
    return gen;
  }

  _endGeneration(gen) {
    if (!gen || !this._activeGens.delete(gen)) return;
    this._syncGenState();
    this._emit();
  }

  _syncGenState() {
    const n = this._activeGens.size;
    let latest = null;
    for (const g of this._activeGens) latest = g; // Set keeps insertion order
    this.state.activeGenerations = n;
    this.state.isGenerating = n > 0;
    this.state.currentGen = latest || emptyGen();
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
    delete forwardHeaders['keep-alive'];
    delete forwardHeaders['transfer-encoding'];

    const requestPath = new URL(req.url, 'http://127.0.0.1');
    // Honour a base path on ollamaUrl (e.g. http://host/ollama behind a
    // reverse proxy) instead of silently dropping it.
    const basePath = target.pathname.replace(/\/+$/, '');
    const isHttps = target.protocol === 'https:';
    const options = {
      hostname: target.hostname,
      port: defaultPort(target),
      path: basePath + requestPath.pathname + requestPath.search,
      method: req.method,
      headers: forwardHeaders,
      agent: this._agentFor(target),
    };

    const isGenEndpoint =
      requestPath.pathname === '/api/generate' || requestPath.pathname === '/api/chat';
    this.log(`proxying ${req.method} ${req.url}${isGenEndpoint ? ' (generation endpoint)' : ''}`);

    let gen = null;
    let clientGone = false;

    const proxyReq = (isHttps ? https : http).request(options, (proxyRes) => {
      // Upstream answered, so any earlier one-off request failure is stale.
      if (this.state.lastError && this.state.lastError.transient) {
        this.state.lastError = null;
        this._emit();
      }

      // Same reasoning as the request side: the proxy is byte-transparent so
      // Content-Length stays valid, but the hop-by-hop framing headers must go
      // or Node re-chunks an already-chunked upstream body.
      const responseHeaders = { ...proxyRes.headers };
      delete responseHeaders.connection;
      delete responseHeaders['keep-alive'];
      delete responseHeaders['transfer-encoding'];
      res.writeHead(proxyRes.statusCode || 502, responseHeaders);

      let parser = null;
      let decoder = null;
      const status = proxyRes.statusCode || 0;
      if (isGenEndpoint && status >= 200 && status < 300 && !clientGone) {
        gen = this._beginGeneration();
        // A StringDecoder keeps multi-byte UTF-8 characters that straddle a
        // chunk boundary intact instead of turning them into U+FFFD.
        decoder = new StringDecoder('utf8');
        const thisGen = gen;
        parser = new OllamaStreamParser(
          (obj) => this._onDoneObject(obj),
          (obj) => {
            // Ollama can abort a generation mid-stream with an error line
            // (e.g. "prediction aborted, token repeat limit reached") and no
            // done object. Surface it rather than silently going idle.
            if (obj && typeof obj.error === 'string') {
              this.log(`Ollama reported an error mid-generation: ${obj.error}`);
              this._setError('Ollama error', obj.error, true);
              return;
            }
            // No emit here: the UI re-renders on its own timer while
            // generating, so a per-token emit would only add redundant work.
            if (!obj.done) thisGen.tokens += estimateResponseTokens(obj);
          },
        );
      }

      // A generation request Ollama refused (unknown model, bad options, out
      // of memory): keep the first few KB of the reply to report its error.
      let errorBody = isGenEndpoint && status >= 400 ? '' : null;

      proxyRes.on('data', (chunk) => {
        if (!res.write(chunk)) proxyRes.pause();
        if (parser) parser.push(decoder.write(chunk));
        else if (errorBody !== null && errorBody.length < 4096) errorBody += chunk.toString('utf8');
      });

      res.on('drain', () => proxyRes.resume());

      proxyRes.on('end', () => {
        if (parser) {
          parser.push(decoder.end());
          parser.end();
        }
        res.end();
        this._endGeneration(gen);
        if (errorBody !== null) this._reportErrorReply(status, errorBody);
      });

      // 'close' always fires, including when the upstream dies mid-stream
      // and 'end' never comes.
      proxyRes.on('close', () => this._endGeneration(gen));

      proxyRes.on('error', (err) => {
        proxyReq.destroy(err);
      });
    });

    proxyReq.setTimeout(this.requestTimeoutMs, () => {
      const timeoutError = new Error(`upstream request timed out after ${this.requestTimeoutMs}ms`);
      timeoutError.code = 'ETIMEDOUT';
      proxyReq.destroy(timeoutError);
    });

    // The client hung up (e.g. pressed Stop in a chat UI): cancel upstream
    // so Ollama stops generating, and end our bookkeeping for it.
    const cancelUpstream = () => {
      if (clientGone) return;
      clientGone = true;
      proxyReq.destroy();
      this._endGeneration(gen);
    };
    req.on('error', cancelUpstream);
    res.on('close', () => {
      if (!res.writableFinished) cancelUpstream();
    });

    proxyReq.on('error', (err) => {
      this._endGeneration(gen);
      // A client that already left is not an upstream failure. Note: do NOT
      // test req.destroyed here — on current Node an IncomingMessage is
      // auto-destroyed as soon as its body has been read, which used to make
      // every upstream failure silently skip the 502 and hang the client.
      if (clientGone || res.destroyed) return;
      this._setError('proxy error', err.message, true);
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Ollama Token Tracker proxy error: ' + err.message);
      } else {
        // Mid-stream failure: appending text would corrupt the NDJSON body
        // and look like a clean finish. Drop the connection so the client
        // sees the truncation.
        res.destroy(err);
      }
    });

    req.pipe(proxyReq);
  }

  _reportErrorReply(status, body) {
    let detail = `HTTP ${status}`;
    try {
      const parsed = JSON.parse(body);
      if (parsed && typeof parsed.error === 'string') detail = `${parsed.error} (HTTP ${status})`;
    } catch (e) {
      /* not JSON; keep the status code */
    }
    this.log(`Ollama refused a generation request: ${detail}`);
    this._setError('Ollama error', detail, true);
  }

  _onDoneObject(obj) {
    const stats = extractFinalStats(obj);
    if (!stats) {
      this.log('done object seen but had no usable eval_count/eval_duration; not recording stats');
      return;
    }
    this.state.lastFinal = { ...stats, finishedAt: Date.now() };
    const t = this.state.totals;
    t.generations += 1;
    t.outputTokens += stats.outputTokens;
    t.promptTokens += stats.promptTokens;
    this.log(
      `generation finished: ${stats.outputTokens} output tokens, ${stats.promptTokens} prompt tokens, ${stats.tokensPerSec.toFixed(1)} tok/s, model=${stats.model}`,
    );
    this._emit();
  }

  startModelPoll(ollamaUrl, intervalMs = 2000) {
    if (this.pollTimer) clearInterval(this.pollTimer);
    const poll = () => this._pollOnce(ollamaUrl);
    this.pollTimer = setInterval(poll, intervalMs);
    poll();
  }

  _applyPoll(models, backendError) {
    const loaded = models.length > 0;
    const changed =
      backendError !== this.state.backendError ||
      loaded !== this.state.hasLoadedModel ||
      JSON.stringify(models) !== JSON.stringify(this.state.loadedModels);
    if (!changed) return;
    if (loaded !== this.state.hasLoadedModel) {
      this.log(`model-loaded state changed: ${this.state.hasLoadedModel} -> ${loaded}`);
    }
    if (backendError !== this.state.backendError) {
      this.log(
        backendError ? `Ollama backend unreachable: ${backendError}` : 'Ollama backend reachable',
      );
    }
    this.state.hasLoadedModel = loaded;
    this.state.loadedModels = models;
    this.state.backendError = backendError;
    this._emit();
  }

  _pollOnce(ollamaUrl) {
    // A slow backend must not pile up overlapping polls.
    if (this._pollInFlight) return;
    let target;
    try {
      target = new URL(ollamaUrl);
    } catch (e) {
      return;
    }
    this._pollInFlight = true;
    let settled = false;
    const finish = (models, backendError) => {
      if (settled) return;
      settled = true;
      this._pollInFlight = false;
      this._applyPoll(models, backendError);
    };

    const basePath = target.pathname.replace(/\/+$/, '');
    const req = (target.protocol === 'https:' ? https : http).request(
      {
        hostname: target.hostname,
        port: defaultPort(target),
        path: basePath + '/api/ps',
        method: 'GET',
        timeout: 1500,
        agent: this._agentFor(target),
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('error', (err) => finish([], err.message));
        res.on('end', () => {
          if (res.statusCode !== 200) {
            finish([], `HTTP ${res.statusCode} from /api/ps`);
            return;
          }
          try {
            const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            finish(Array.isArray(parsed.models) ? parsed.models : [], null);
          } catch (e) {
            finish([], 'unexpected (non-JSON) reply from /api/ps');
          }
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', (err) => finish([], err.message || err.code || 'unreachable'));
    req.end();
  }
}

module.exports = { OllamaProxyCore };
