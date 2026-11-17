---
title: Real Ollama behaviour the proxy must handle (verified against 0.40.16)
author: Amateur
date: 2026-11-17
branch: master
cost: { minutes: 1, tokens: 1643 }
id: l-41cffa25
scope: repo
status: active
src: agent
touches:
  - ollama-stream-parser.js
  - ollama-proxy-core.js
---

## Decided
- Live token estimate counts one token per text-bearing streamed line. Ollama streams one line per generated token, so this tracks eval_count closely; a characters/4 guess over-counted indented code by almost 2x (about 292 estimated vs 159 streamed).
- prompt_eval_count is the whole prompt even when most of it is cached; prompt_eval_cached_count is the cached part (seen: 223 total, 222 cached). So prompt + output is an accurate context-window figure when the cached field is present, and prompt speed must divide only the uncached tokens by prompt_eval_duration.

## Tried and ruled out
- Mock-only tests: they passed while the behaviours below went unnoticed. Check against a real Ollama on a spare port before trusting the numbers.

## Watch out
- Ollama can end a stream with an error line such as {"error":"prediction aborted, token repeat limit reached"} and no done:true object. Recording no stats then is correct (never invent counts); the error line is the only signal that the generation failed, so it has to be read from the stream to tell the user.
- Do not test req.destroyed in the upstream error handler: on current Node an IncomingMessage is auto-destroyed once its body is read, which made every upstream failure skip the 502 and hang the client.
- Right after an aborted prediction, /api/ps can report no loaded model.

In the code:
- ollama-stream-parser.js: estimateResponseTokens, extractFinalStats (promptCachedTokens, contextExact, promptTokensPerSec)
- ollama-proxy-core.js: _handleRequest error path (clientGone instead of req.destroyed)
- /api/ps context_length matches OLLAMA_CONTEXT_LENGTH (8192 on this machine)
