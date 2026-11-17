'use strict';
const http = require('http');
const assert = require('assert');
const { OllamaProxyCore } = require('../ollama-proxy-core.js');

function startMockOllama() {
  return new Promise((resolve) => {
    let modelsLoaded = [{ name: 'gemma3:4b' }];
    const server = http.createServer((req, res) => {
      if (req.url === '/api/ps' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ models: modelsLoaded }));
        return;
      }
      if (
        (req.url === '/api/generate' || req.url === '/api/generate?stream=true') &&
        req.method === 'POST'
      ) {
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
        // Simulate real Ollama streaming behavior: several chunks, then a
        // final done:true object, written as SEPARATE res.write() calls
        // (i.e. separate TCP-level chunks from Node's perspective) so the
        // proxy has to actually reassemble them.
        const chunks = [
          '{"response":"The","done":false}\n',
          '{"response":" quick","done":false}\n',
          '{"response":" fox","done":false}\n',
        ];
        let i = 0;
        const sendNext = () => {
          if (i < chunks.length) {
            res.write(chunks[i++]);
            setTimeout(sendNext, 5);
          } else {
            res.end(
              '{"response":"","done":true,"eval_count":123,"eval_duration":3000000000,"prompt_eval_count":17,"prompt_eval_duration":150000000,"model":"gemma3:4b"}\n',
            );
          }
        };
        sendNext();
        return;
      }
      res.writeHead(404);
      res.end();
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function main() {
  let failed = 0;
  const log = (msg) => console.log('  [proxy log] ' + msg);

  const mockOllama = await startMockOllama();
  const mockPort = mockOllama.address().port;
  console.log(`mock Ollama listening on 127.0.0.1:${mockPort}`);

  const core = new OllamaProxyCore({ log });
  const stateSnapshots = [];
  core.onStateChange((s) => stateSnapshots.push(JSON.parse(JSON.stringify(s))));

  const proxyPort = 0; // OS-assigned ephemeral port to avoid collisions with lingering listeners
  await core.start(proxyPort, `http://127.0.0.1:${mockPort}`);
  const proxyPortNum = core.server.address().port;
  console.log(`proxy listening on 127.0.0.1:${proxyPortNum}`);

  // --- 1. model poll should detect the loaded model ---
  await new Promise((resolve) => {
    core.startModelPoll(`http://127.0.0.1:${mockPort}`, 50);
    setTimeout(resolve, 120);
  });
  try {
    assert.strictEqual(
      core.state.hasLoadedModel,
      true,
      'expected hasLoadedModel=true after polling mock /api/ps',
    );
    console.log('  ok  - model poll detected loaded model');
  } catch (e) {
    failed++;
    console.log('  FAIL - ' + e.message);
  }

  // --- 2. send a real generation request through the proxy, exactly as a client would ---
  const genResult = await new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: proxyPortNum,
        path: '/api/generate?stream=true',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve(body));
      },
    );
    req.on('error', reject);
    req.write(JSON.stringify({ model: 'gemma3:4b', prompt: 'hi', stream: true }));
    req.end();
  });

  try {
    assert.ok(
      genResult.includes('"done":true'),
      'proxied response body should contain the done object',
    );
    console.log('  ok  - client received the full proxied streaming response');
  } catch (e) {
    failed++;
    console.log('  FAIL - ' + e.message);
  }

  // give the internal 'end' handler time to fire after res.end()
  await new Promise((r) => setTimeout(r, 100));

  try {
    assert.strictEqual(
      core.state.isGenerating,
      false,
      'isGenerating should be false again after completion',
    );
    assert.ok(core.state.lastFinal, 'lastFinal stats should now be populated');
    assert.strictEqual(core.state.lastFinal.outputTokens, 123);
    assert.strictEqual(core.state.lastFinal.promptTokens, 17);
    assert.ok(
      Math.abs(core.state.lastFinal.tokensPerSec - 41) < 0.5,
      `expected ~41 tok/s, got ${core.state.lastFinal.tokensPerSec}`,
    );
    console.log(
      '  ok  - final stats correctly captured from the done object (123 output / 17 prompt / ~41 tok/s)',
    );
  } catch (e) {
    failed++;
    console.log('  FAIL - ' + e.message);
  }

  // --- 3. verify isGenerating actually went true DURING the request, not just at the end ---
  const sawGeneratingTrue = stateSnapshots.some((s) => s.isGenerating === true);
  try {
    assert.ok(
      sawGeneratingTrue,
      'expected to observe isGenerating=true at some point during the request',
    );
    console.log('  ok  - observed isGenerating flip to true while streaming was in progress');
  } catch (e) {
    failed++;
    console.log('  FAIL - ' + e.message);
  }

  // --- 4. now kill the mock Ollama and confirm the proxy reports an error rather than hanging/pretending ---
  await new Promise((resolve) => mockOllama.close(resolve));
  core.stop();
  const errorCore = new OllamaProxyCore({ log, requestTimeoutMs: 1000 });
  await errorCore.start(0, `http://127.0.0.1:${mockPort}`);
  const errorProxyPort = errorCore.server.address().port;
  const errResult = await new Promise((resolve) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: errorProxyPort,
        path: '/api/generate',
        method: 'POST',
      },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode, body }));
      },
    );
    req.setTimeout(3000, () => {
      req.destroy();
      resolve({ status: null, body: null });
    });
    req.on('error', () => resolve({ status: null, body: null }));
    req.end();
  });
  try {
    // A 502 specifically: "no answer within 3 s" used to be accepted here,
    // which hid a bug where every upstream failure left the client hanging.
    assert.strictEqual(errResult.status, 502, `expected a 502, got ${errResult.status}`);
    assert.ok(errorCore.state.lastError, 'expected lastError to be set');
    assert.strictEqual(errorCore.state.lastError.transient, true);
    assert.strictEqual(errorCore.state.isGenerating, false);
    console.log(
      '  ok  - proxy answers 502 and records a transient error when upstream Ollama is unreachable',
    );
  } catch (e) {
    failed++;
    console.log('  FAIL - ' + e.message);
  }

  // --- 5. the model poll reports an unreachable backend explicitly ---
  await new Promise((resolve) => {
    errorCore.startModelPoll(`http://127.0.0.1:${mockPort}`, 50);
    setTimeout(resolve, 150);
  });
  try {
    assert.ok(errorCore.state.backendError, 'expected backendError to be set');
    assert.strictEqual(errorCore.state.hasLoadedModel, false);
    console.log('  ok  - model poll reports the backend as unreachable');
  } catch (e) {
    failed++;
    console.log('  FAIL - ' + e.message);
  }
  errorCore.stop();

  failed += await testClientAbort(log);
  failed += await testParallelAndUtf8(log);
  failed += await testLoopGuard();
  failed += await testOllamaErrors();
  console.log(`\n${failed === 0 ? 'ALL GOOD' : failed + ' FAILURE(S)'}`);
  process.exit(failed > 0 ? 1 : 0);
}

function check(name, fn) {
  try {
    fn();
    console.log('  ok  - ' + name);
    return 0;
  } catch (e) {
    console.log('  FAIL - ' + name + ': ' + e.message);
    return 1;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// An upstream that streams forever until the client goes away.
function startEndlessUpstream() {
  return new Promise((resolve) => {
    const state = { upstreamClosed: false };
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      const t = setInterval(() => res.write('{"response":"tok","done":false}\n'), 10);
      res.on('close', () => {
        clearInterval(t);
        state.upstreamClosed = true;
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, state }));
  });
}

async function testClientAbort(log) {
  const { server, state } = await startEndlessUpstream();
  const core = new OllamaProxyCore({ log: () => {} });
  await core.start(0, `http://127.0.0.1:${server.address().port}`);
  const req = http.request({
    hostname: '127.0.0.1',
    port: core.server.address().port,
    path: '/api/chat',
    method: 'POST',
  });
  req.on('error', () => {});
  let midTokens = -1;
  req.on('response', (res) =>
    res.once('data', () =>
      setTimeout(() => {
        midTokens = core.state.currentGen.tokens;
        req.destroy();
      }, 50),
    ),
  );
  req.end('{}');
  await sleep(400);
  let failed = check('live token estimate grows while streaming', () => {
    assert.ok(midTokens > 0, `expected tokens > 0, got ${midTokens}`);
  });
  failed += check('client abort (Stop button) ends the generation and cancels upstream', () => {
    assert.strictEqual(core.state.isGenerating, false, 'isGenerating stuck at true');
    assert.strictEqual(core.state.activeGenerations, 0);
    assert.strictEqual(core.state.lastError, null, 'a client abort is not an error');
    assert.ok(state.upstreamClosed, 'upstream request should have been cancelled');
  });
  core.stop();
  server.close();
  return failed;
}

async function testParallelAndUtf8() {
  // Each response is slow enough to overlap, and the done line's model name
  // has a 3-byte UTF-8 character split across two writes to exercise the
  // decoder (a plain toString() per chunk would turn it into U+FFFD).
  const done = Buffer.from(
    '{"done":true,"eval_count":5,"eval_duration":1000000000,"prompt_eval_count":2,"model":"m\u20ac"}\n',
    'utf8',
  );
  const splitAt = done.indexOf(Buffer.from('\u20ac', 'utf8')) + 1;
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
    res.write('{"response":"hi","done":false}\n');
    setTimeout(() => res.write(done.subarray(0, splitAt)), 40);
    setTimeout(() => res.end(done.subarray(splitAt)), 120);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const core = new OllamaProxyCore({ log: () => {} });
  await core.start(0, `http://127.0.0.1:${server.address().port}`);
  let maxActive = 0;
  core.onStateChange((s) => (maxActive = Math.max(maxActive, s.activeGenerations)));
  const port = core.server.address().port;
  const one = () =>
    new Promise((resolve, reject) => {
      const req = http.request(
        { hostname: '127.0.0.1', port, path: '/api/generate', method: 'POST' },
        (res) => {
          res.resume();
          res.on('end', resolve);
        },
      );
      req.on('error', reject);
      req.end('{}');
    });
  await Promise.all([one(), one()]);
  await sleep(30);
  let failed = check('parallel generations are tracked independently', () => {
    assert.strictEqual(maxActive, 2);
    assert.strictEqual(core.state.isGenerating, false);
    assert.strictEqual(core.state.totals.generations, 2);
    assert.strictEqual(core.state.totals.outputTokens, 10);
  });
  failed += check('multi-byte UTF-8 split across chunks is decoded intact', () => {
    assert.strictEqual(core.state.lastFinal.model, 'm\u20ac');
  });
  core.stop();
  server.close();
  return failed;
}

async function testOllamaErrors() {
  // Shapes captured from a real Ollama 0.40.16: a mid-stream abort with no
  // done object, and a refused request.
  const server = http.createServer((req, res) => {
    if (req.url === '/api/generate') {
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      res.write('{"response":" search","done":false}\n');
      res.end('{"error":"prediction aborted, token repeat limit reached"}\n');
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end('{"error":"model \\"nope\\" not found, try pulling it first"}');
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const core = new OllamaProxyCore({ log: () => {} });
  await core.start(0, `http://127.0.0.1:${server.address().port}`);
  const port = core.server.address().port;
  const send = (path) =>
    new Promise((resolve) => {
      const req = http.request({ hostname: '127.0.0.1', port, path, method: 'POST' }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      });
      req.end('{}');
    });
  await send('/api/generate');
  await sleep(30);
  let failed = check('a mid-stream Ollama error is surfaced, and no stats are invented', () => {
    assert.strictEqual(
      core.state.lastError && core.state.lastError.detail,
      'prediction aborted, token repeat limit reached',
    );
    assert.strictEqual(core.state.lastFinal, null);
    assert.strictEqual(core.state.isGenerating, false);
  });
  const status = await send('/api/chat');
  await sleep(30);
  failed += check("a refused generation request reports Ollama's error message", () => {
    assert.strictEqual(status, 404);
    assert.ok(
      /model "nope" not found.*HTTP 404/.test(core.state.lastError.detail),
      core.state.lastError.detail,
    );
  });
  core.stop();
  server.close();
  return failed;
}

async function testLoopGuard() {
  const core = new OllamaProxyCore({ log: () => {} });
  let rejected = null;
  try {
    await core.start(45999, 'http://localhost:45999');
  } catch (e) {
    rejected = e;
  }
  core.stop();
  return check('refuses an ollamaUrl that points back at the proxy itself', () => {
    assert.ok(rejected && /proxy's own port/.test(rejected.message), String(rejected));
  });
}

main().catch((e) => {
  console.error('Test harness crashed:', e);
  process.exit(1);
});
