"use strict";
// Pure parsing logic, factored out so it can be unit-tested outside of
// VS Code (no `vscode` import in this file). extension.js wires this into
// the real HTTP proxy and into the status bar.

/**
 * Incrementally parses a stream of bytes from an Ollama /api/generate or
 * /api/chat response. Ollama's streaming format is newline-delimited JSON
 * (NDJSON): each line is a complete JSON object. The final object has
 * `"done": true` and carries the authoritative counts. When a client sends
 * `"stream": false`, Ollama instead returns the whole thing as a single
 * JSON object with no trailing newline, so the parser must also cope with
 * a done object that never gets a newline after it and arrives as the
 * very last (or only) chunk.
 */
class OllamaStreamParser {
  constructor(onDone, onObject = null) {
    this.buffer = "";
    this.onDone = onDone; // called with the parsed done object
    this.onObject = onObject;
    this.sawDone = false;
  }

  push(chunkStr) {
    this.buffer += chunkStr;
    const lines = this.buffer.split("\n");
    // The last element may be a partial line (no trailing \n yet) — keep
    // it in the buffer for the next push/end.
    this.buffer = lines.pop() || "";
    for (const line of lines) {
      this._tryParseLine(line);
    }
  }

  // Call once when the underlying response ends. Flushes whatever is left
  // in the buffer, which is where a non-streamed (`stream:false`) or
  // final-without-newline response is caught.
  end() {
    if (this.buffer.trim()) {
      this._tryParseLine(this.buffer);
      this.buffer = "";
    }
  }

  _tryParseLine(line) {
    const trimmed = line.trim();
    if (!trimmed) return;
    let obj;
    try {
      obj = JSON.parse(trimmed);
    } catch (e) {
      // Not a complete/valid JSON object (e.g. torn mid-object across a
      // chunk boundary that also contained a stray newline inside a
      // string). We deliberately do not attempt partial recovery here;
      // the next push()'s buffer concatenation is what actually handles
      // the normal "split across chunks" case correctly, because we only
      // split on "\n" and only parse fully-buffered lines. A genuine
      // JSON.parse failure on a fully-buffered line means malformed
      // upstream data, which we skip rather than crash on.
      return;
    }
    if (this.onObject) this.onObject(obj);
    if (obj && obj.done) {
      this.sawDone = true;
      this.onDone(obj);
    }
  }
}

function estimateResponseTokens(obj) {
  const text =
    typeof obj.response === "string"
      ? obj.response
      : obj.message && typeof obj.message.content === "string"
        ? obj.message.content
        : "";
  if (!text) return 0;
  return Math.max(1, Math.ceil(Array.from(text).length / 4));
}

/**
 * Turns a raw Ollama "done" object into the numbers/text the status bar
 * needs. Returns null if the object doesn't actually carry usable final
 * stats (e.g. it's a done:true for a non-generation endpoint, or the
 * duration fields are missing/zero) — callers must not fabricate a
 * token count when this returns null.
 */
function extractFinalStats(obj) {
  if (
    typeof obj.eval_count !== "number" ||
    typeof obj.eval_duration !== "number" ||
    obj.eval_duration <= 0
  ) {
    return null;
  }
  const tps = obj.eval_count / (obj.eval_duration / 1e9);
  return {
    outputTokens: obj.eval_count,
    promptTokens:
      typeof obj.prompt_eval_count === "number" ? obj.prompt_eval_count : 0,
    evalDurationSec: obj.eval_duration / 1e9,
    promptEvalDurationSec:
      typeof obj.prompt_eval_duration === "number"
        ? obj.prompt_eval_duration / 1e9
        : null,
    tokensPerSec: tps,
    model: typeof obj.model === "string" ? obj.model : "unknown",
  };
}

module.exports = { OllamaStreamParser, extractFinalStats, estimateResponseTokens };
