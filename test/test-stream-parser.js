"use strict";
const assert = require("assert");
const { OllamaStreamParser, extractFinalStats, estimateResponseTokens } = require("../ollama-stream-parser.js");

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

// --- Test 1: normal NDJSON stream, one chunk per line, trailing newline ---
test("normal NDJSON stream with trailing newline on final line", () => {
  let captured = null;
  const p = new OllamaStreamParser((obj) => (captured = obj));
  p.push('{"response":"Hel","done":false}\n');
  p.push('{"response":"lo","done":false}\n');
  p.push(
    '{"response":"","done":true,"eval_count":42,"eval_duration":1200000000,"prompt_eval_count":10,"prompt_eval_duration":100000000,"model":"gemma3:4b"}\n'
  );
  p.end();
  assert.ok(captured, "onDone should have fired");
  assert.strictEqual(captured.eval_count, 42);
  const stats = extractFinalStats(captured);
  assert.strictEqual(stats.outputTokens, 42);
  assert.strictEqual(stats.promptTokens, 10);
  assert.ok(Math.abs(stats.tokensPerSec - 35) < 0.01, `expected ~35 tok/s, got ${stats.tokensPerSec}`);
});

test("streamed response objects provide a live token estimate", () => {
  const objects = [];
  const p = new OllamaStreamParser(() => {}, (obj) => objects.push(obj));
  p.push('{"response":"Hello world","done":false}\n');
  p.push('{"message":{"content":"Hi"},"done":false}\n');
  p.end();
  assert.strictEqual(objects.length, 2);
  assert.strictEqual(estimateResponseTokens(objects[0]), 3);
  assert.strictEqual(estimateResponseTokens(objects[1]), 1);
});

// --- Test 2: final object arrives with NO trailing newline (the documented Ollama behavior for stream:false, and can also happen at the end of a stream:true response depending on TCP framing) ---
test("final JSON object with no trailing newline", () => {
  let captured = null;
  const p = new OllamaStreamParser((obj) => (captured = obj));
  p.push('{"response":"Hi","done":false}\n');
  // no trailing \n on this last write:
  p.push(
    '{"response":"","done":true,"eval_count":7,"eval_duration":500000000,"prompt_eval_count":3,"model":"llama3"}'
  );
  p.end(); // must flush the buffer
  assert.ok(captured, "onDone should have fired from end() flush");
  assert.strictEqual(captured.eval_count, 7);
});

// --- Test 3: a single JSON object split across two TCP chunks mid-object (network fragmentation) ---
test("single done object split mid-JSON across two chunks", () => {
  let captured = null;
  const p = new OllamaStreamParser((obj) => (captured = obj));
  const full =
    '{"response":"","done":true,"eval_count":99,"eval_duration":900000000,"prompt_eval_count":20,"model":"gemma3:4b"}\n';
  const splitPoint = 40;
  p.push(full.slice(0, splitPoint));
  p.push(full.slice(splitPoint));
  p.end();
  assert.ok(captured, "onDone should have fired after both fragments arrived");
  assert.strictEqual(captured.eval_count, 99);
});

// --- Test 4: stream:false — the ENTIRE response is one JSON object with no newlines at all, delivered in one 'data' event ---
test("stream:false single-shot response (no NDJSON framing at all)", () => {
  let captured = null;
  const p = new OllamaStreamParser((obj) => (captured = obj));
  const body =
    '{"model":"gemma3:4b","response":"full text here","done":true,"eval_count":250,"eval_duration":8000000000,"prompt_eval_count":50,"prompt_eval_duration":400000000}';
  p.push(body);
  p.end();
  assert.ok(captured, "onDone should have fired for a non-streamed response");
  const stats = extractFinalStats(captured);
  assert.strictEqual(stats.outputTokens, 250);
  assert.strictEqual(stats.promptTokens, 50);
  assert.ok(Math.abs(stats.tokensPerSec - 31.25) < 0.01);
});

// --- Test 5: streaming chunks must NOT be counted as tokens — only the done object's eval_count counts ---
test("intermediate stream chunks never produce a captured 'done' event", () => {
  let doneCount = 0;
  const p = new OllamaStreamParser(() => doneCount++);
  for (let i = 0; i < 20; i++) {
    p.push(`{"response":"tok${i}","done":false}\n`);
  }
  p.end();
  assert.strictEqual(doneCount, 0, "no done:true was ever sent, so onDone must never fire");
});

// --- Test 6: extractFinalStats must return null (never fabricate) when duration is missing/zero ---
test("extractFinalStats refuses to fabricate stats when eval_duration is 0 or missing", () => {
  assert.strictEqual(extractFinalStats({ done: true }), null);
  assert.strictEqual(extractFinalStats({ done: true, eval_count: 5, eval_duration: 0 }), null);
  assert.strictEqual(extractFinalStats({ done: true, eval_count: 5 }), null);
});

// --- Test 7: a chat-style done object (obj.message.content instead of obj.response) still has the same done/eval_count shape ---
test("chat endpoint done object (message.content instead of response)", () => {
  let captured = null;
  const p = new OllamaStreamParser((obj) => (captured = obj));
  p.push('{"message":{"role":"assistant","content":"Hi"},"done":false}\n');
  p.push(
    '{"message":{"role":"assistant","content":""},"done":true,"eval_count":15,"eval_duration":300000000,"prompt_eval_count":8,"model":"qwen2.5"}\n'
  );
  p.end();
  assert.ok(captured);
  assert.strictEqual(captured.eval_count, 15);
});

// --- Test 8: malformed line in the middle (should be skipped, not crash, and not block later valid done object) ---
test("malformed intermediate line is skipped without crashing later parsing", () => {
  let captured = null;
  const p = new OllamaStreamParser((obj) => (captured = obj));
  p.push('{"response":"ok","done":false}\n');
  p.push("not json at all, garbage line\n");
  p.push(
    '{"response":"","done":true,"eval_count":3,"eval_duration":100000000,"model":"x"}\n'
  );
  p.end();
  assert.ok(captured, "parser should recover and still catch the real done object");
  assert.strictEqual(captured.eval_count, 3);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
