'use strict';
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
    this.buffer = '';
    this.onDone = onDone; // called with the parsed done object
    this.onObject = onObject;
    this.sawDone = false;
  }

  push(chunkStr) {
    if (!chunkStr) return;
    // Fast path: no line terminator in this chunk, so nothing can complete.
    // Avoids re-splitting an ever-growing buffer on every chunk of a large
    // non-streamed (`stream:false`) body, which was O(n^2).
    if (chunkStr.indexOf('\n') === -1) {
      this.buffer += chunkStr;
      return;
    }
    const lines = (this.buffer + chunkStr).split('\n');
    // The last element may be a partial line (no trailing \n yet) — keep
    // it in the buffer for the next push/end.
    this.buffer = lines.pop() || '';
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
      this.buffer = '';
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

function hasText(value) {
  return typeof value === 'string' && value.length > 0;
}

/**
 * Live token estimate for one streamed chunk. Ollama streams one line per
 * generated token (occasionally fewer, when a token is only part of a
 * multi-byte character), so counting text-bearing lines tracks eval_count far
 * better than a characters-per-token guess — that over-counted indented code
 * by almost 2x against a real Ollama. Reasoning ("thinking") chunks count too:
 * Ollama's final eval_count includes them.
 */
function estimateResponseTokens(obj) {
  if (!obj || typeof obj !== 'object') return 0;
  const message = obj.message && typeof obj.message === 'object' ? obj.message : null;
  const carriesText =
    hasText(obj.response) ||
    hasText(obj.thinking) ||
    (message && (hasText(message.content) || hasText(message.thinking)));
  return carriesText ? 1 : 0;
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
    typeof obj.eval_count !== 'number' ||
    typeof obj.eval_duration !== 'number' ||
    obj.eval_duration <= 0
  ) {
    return null;
  }
  const nsToSec = (v) => (typeof v === 'number' && v > 0 ? v / 1e9 : null);
  const promptTokens = typeof obj.prompt_eval_count === 'number' ? obj.prompt_eval_count : 0;
  const promptEvalDurationSec = nsToSec(obj.prompt_eval_duration);
  // Newer Ollama reports how much of the prompt was reused from its cache.
  // prompt_eval_count still counts the whole prompt (verified on 0.40.16:
  // 223 total with 222 cached), so only the uncached part was evaluated.
  const cachedTokens =
    typeof obj.prompt_eval_cached_count === 'number' ? obj.prompt_eval_cached_count : null;
  const evaluatedPromptTokens = Math.max(0, promptTokens - (cachedTokens || 0));
  // How much of the model's context window this request occupied: the
  // /api/generate context token array when present, else prompt + output.
  // The latter is exact when Ollama reports the cached count (its prompt
  // count is then known to include cached tokens); older versions may have
  // counted only the evaluated part, so it is marked approximate there.
  const hasContextArray = Array.isArray(obj.context) && obj.context.length > 0;
  return {
    outputTokens: obj.eval_count,
    promptTokens,
    promptCachedTokens: cachedTokens,
    contextTokens: hasContextArray ? obj.context.length : promptTokens + obj.eval_count,
    contextExact: hasContextArray || cachedTokens !== null,
    evalDurationSec: obj.eval_duration / 1e9,
    promptEvalDurationSec,
    loadDurationSec: nsToSec(obj.load_duration),
    totalDurationSec: nsToSec(obj.total_duration),
    tokensPerSec: obj.eval_count / (obj.eval_duration / 1e9),
    // Prompt processing speed over the tokens actually evaluated (dividing
    // the full prompt by the time spent on a 1-token uncached tail would
    // report absurd speeds). null when nothing was evaluated.
    promptTokensPerSec:
      promptEvalDurationSec && evaluatedPromptTokens > 0
        ? evaluatedPromptTokens / promptEvalDurationSec
        : null,
    doneReason: typeof obj.done_reason === 'string' ? obj.done_reason : null,
    model: typeof obj.model === 'string' ? obj.model : 'unknown',
  };
}

module.exports = { OllamaStreamParser, extractFinalStats, estimateResponseTokens };
