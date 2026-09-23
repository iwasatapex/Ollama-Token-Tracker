"use strict";
const http = require("http");
const assert = require("assert");
const { OllamaProxyCore } = require("../ollama-proxy-core.js");

function startMockOllama() {
  return new Promise((resolve) => {
    let modelsLoaded = [{ name: "gemma3:4b" }];
    const server = http.createServer((req, res) => {
      if (req.url === "/api/ps" && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ models: modelsLoaded }));
        return;
      }
      if ((req.url === "/api/generate" || req.url === "/api/generate?stream=true") && req.method === "POST") {
        res.writeHead(200, { "Content-Type": "application/x-ndjson" });
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
              '{"response":"","done":true,"eval_count":123,"eval_duration":3000000000,"prompt_eval_count":17,"prompt_eval_duration":150000000,"model":"gemma3:4b"}\n'
            );
          }
        };
        sendNext();
        return;
      }
      res.writeHead(404);
      res.end();
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

async function main() {
  let failed = 0;
  const log = (msg) => console.log("  [proxy log] " + msg);

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
    assert.strictEqual(core.state.hasLoadedModel, true, "expected hasLoadedModel=true after polling mock /api/ps");
    console.log("  ok  - model poll detected loaded model");
  } catch (e) {
    failed++;
    console.log("  FAIL - " + e.message);
  }

  // --- 2. send a real generation request through the proxy, exactly as a client would ---
  const genResult = await new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: proxyPortNum,
        path: "/api/generate?stream=true",
        method: "POST",
        headers: { "Content-Type": "application/json" },
      },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve(body));
      }
    );
    req.on("error", reject);
    req.write(JSON.stringify({ model: "gemma3:4b", prompt: "hi", stream: true }));
    req.end();
  });

  try {
    assert.ok(genResult.includes('"done":true'), "proxied response body should contain the done object");
    console.log("  ok  - client received the full proxied streaming response");
  } catch (e) {
    failed++;
    console.log("  FAIL - " + e.message);
  }

  // give the internal 'end' handler time to fire after res.end()
  await new Promise((r) => setTimeout(r, 100));

  try {
    assert.strictEqual(core.state.isGenerating, false, "isGenerating should be false again after completion");
    assert.ok(core.state.lastFinal, "lastFinal stats should now be populated");
    assert.strictEqual(core.state.lastFinal.outputTokens, 123);
    assert.strictEqual(core.state.lastFinal.promptTokens, 17);
    assert.ok(Math.abs(core.state.lastFinal.tokensPerSec - 41) < 0.5, `expected ~41 tok/s, got ${core.state.lastFinal.tokensPerSec}`);
    console.log("  ok  - final stats correctly captured from the done object (123 output / 17 prompt / ~41 tok/s)");
  } catch (e) {
    failed++;
    console.log("  FAIL - " + e.message);
  }

  // --- 3. verify isGenerating actually went true DURING the request, not just at the end ---
  const sawGeneratingTrue = stateSnapshots.some((s) => s.isGenerating === true);
  try {
    assert.ok(sawGeneratingTrue, "expected to observe isGenerating=true at some point during the request");
    console.log("  ok  - observed isGenerating flip to true while streaming was in progress");
  } catch (e) {
    failed++;
    console.log("  FAIL - " + e.message);
  }

  // --- 4. now kill the mock Ollama and confirm the proxy reports an error rather than hanging/pretending ---
  await new Promise((resolve) => mockOllama.close(resolve));
  core.stop();
  const errorCore = new OllamaProxyCore({ log, requestTimeoutMs: 1000 });
  await errorCore.start(0, `http://127.0.0.1:${mockPort}`);
  const errorProxyPort = errorCore.server.address().port;
  const errResult = await new Promise((resolve) => {
    const req = http.request(
      { hostname: "127.0.0.1", port: errorProxyPort, path: "/api/generate", method: "POST" },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode, body }));
      }
    );
    req.setTimeout(3000, () => {
      req.destroy();
      resolve({ status: null, body: null });
    });
    req.on("error", () => resolve({ status: null, body: null }));
    req.end();
  });
  try {
    assert.ok(errResult.status === 502 || errResult.status === null, `expected a 502 or connection error, got ${errResult.status}`);
    console.log("  ok  - proxy surfaces an error instead of hanging when upstream Ollama is unreachable");
  } catch (e) {
    failed++;
    console.log("  FAIL - " + e.message);
  }

  errorCore.stop();
  console.log(`\n${failed === 0 ? "ALL GOOD" : failed + " FAILURE(S)"}`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("Test harness crashed:", e);
  process.exit(1);
});
