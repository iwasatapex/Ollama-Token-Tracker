'use strict';
// Pure formatting for the status bar text and its hover tooltip. No `vscode`
// import, so all of it is unit-testable outside VS Code.

const DASH = '—';

// The tooltip is a MarkdownString with supportHtml on, and model names, error
// messages etc. come from the network. Escape everything that markdown or
// HTML could interpret, and flatten newlines (they would break table rows).
function escapeMarkdown(value) {
  if (value === null || value === undefined || value === '') return DASH;
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/[\\`*_{}[\]()#+!|~]/g, '\\$&')
    .replace(/\r?\n/g, ' ');
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return DASH;
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

// 12345 -> "12,345" (stable, locale-independent so tests and logs agree).
function formatInt(n) {
  if (!Number.isFinite(n)) return DASH;
  return Math.round(n)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

// Compact count for the narrow status bar: 987, 1.2k, 12k, 1.3M.
function formatCompact(n) {
  if (!Number.isFinite(n)) return DASH;
  const abs = Math.abs(n);
  if (abs < 1000) return String(Math.round(n));
  if (abs < 10000) return `${(n / 1000).toFixed(1)}k`;
  if (abs < 1e6) return `${Math.round(n / 1000)}k`;
  return `${(n / 1e6).toFixed(1)}M`;
}

// Tokens/s: one decimal below 100, whole numbers above (e.g. 41.0, 312).
function formatRate(tps) {
  if (!Number.isFinite(tps) || tps < 0) return DASH;
  return tps >= 100 ? tps.toFixed(0) : tps.toFixed(1);
}

// 0.4 -> "<1%", 37.6 -> "38%". Capped at 100: past that Ollama has already
// truncated the prompt to fit.
function formatPercent(pct) {
  if (!Number.isFinite(pct) || pct < 0) return DASH;
  if (pct > 0 && pct < 1) return '<1%';
  return `${Math.min(100, Math.round(pct))}%`;
}

// Ten-cell text meter with whole cells only, so it lines up in any font:
// 37% -> "████░░░░░░".
function formatMeter(pct, cells = 10) {
  if (!Number.isFinite(pct)) return '';
  const filled = Math.max(0, Math.min(cells, Math.round((pct / 100) * cells)));
  return '█'.repeat(filled) + '░'.repeat(cells - filled);
}

function formatDuration(sec) {
  if (!Number.isFinite(sec) || sec < 0) return DASH;
  if (sec < 1) return `${Math.round(sec * 1000)} ms`;
  if (sec < 60) return `${sec.toFixed(1)} s`;
  const m = Math.floor(sec / 60);
  return `${m}m ${Math.round(sec - m * 60)}s`;
}

// Minute-granular on purpose: the result is part of the render key, so a
// finer value would force a status bar update every second for no benefit.
function formatAgo(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '';
  const min = Math.floor(ms / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  return `${Math.floor(min / 60)} h ago`;
}

function formatProcessor(model) {
  if (!model) return DASH;
  if (model.processor) return String(model.processor);

  const total = Number(model.size);
  const vram = Number(model.size_vram);
  if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(vram)) return DASH;

  const gpuPercent = Math.max(0, Math.min(100, (vram / total) * 100));
  const cpuPercent = 100 - gpuPercent;
  if (gpuPercent >= 99.5) return '100% GPU';
  if (gpuPercent <= 0.5) return '100% CPU';
  return `${cpuPercent.toFixed(0)}% CPU / ${gpuPercent.toFixed(0)}% GPU`;
}

// When Ollama will unload the model (from /api/ps `expires_at`).
function formatKeepAlive(expiresAt, now = Date.now()) {
  if (!expiresAt) return DASH;
  const t = Date.parse(expiresAt);
  if (!Number.isFinite(t)) return DASH;
  const left = t - now;
  if (left > 24 * 3600 * 1000) return 'stays loaded';
  if (left <= 0) return 'unloading';
  const min = Math.ceil(left / 60000);
  return min >= 60
    ? `unloads in ${Math.floor(min / 60)} h ${min % 60} min`
    : `unloads in ${min} min`;
}

function row(label, value) {
  return `| ${label} | ${value} |`;
}

/**
 * Builds the tooltip markdown from a plain data object:
 * {
 *   status, model, otherModels: [names], context, size, vram, processor,
 *   keepAlive, live: { tokens, tps, count } | null,
 *   last: { model, outputTokens, promptTokens, tokensPerSec,
 *           promptCachedTokens, promptTokensPerSec, totalDurationSec, contextUsed,
 *           contextExact, contextSize, contextPercent } | null,
 *   totals: { generations, outputTokens, promptTokens } | null,
 *   note, version, commands: [{ title, id }]
 * }
 */
function buildStatusMarkdown(d) {
  const out = [];
  out.push(`**Ollama · ${escapeMarkdown(d.status || DASH)}**`, '');

  // One table: model details, then the last generation's figures. Markdown
  // needs a header row, so the first row (Model, or Output when no model is
  // loaded) is emitted as the header.
  const rows = [];
  if (d.model && d.model !== DASH) {
    rows.push(row('**Model**', `**${escapeMarkdown(d.model)}**`));
    if (d.otherModels && d.otherModels.length) {
      rows.push(row('Also loaded', d.otherModels.map(escapeMarkdown).join(', ')));
    }
    rows.push(row('Context', escapeMarkdown(d.context)));
    rows.push(row('Size', `${escapeMarkdown(d.size)} · VRAM ${escapeMarkdown(d.vram)}`));
    rows.push(row('Processor', escapeMarkdown(d.processor)));
    if (d.keepAlive && d.keepAlive !== DASH)
      rows.push(row('Keep-alive', escapeMarkdown(d.keepAlive)));
  }

  if (d.last) {
    const l = d.last;
    rows.push(
      row('Output', `${formatInt(l.outputTokens)} tokens · ${formatRate(l.tokensPerSec)} tok/s`),
    );
    rows.push(
      row(
        'Prompt',
        `${formatInt(l.promptTokens)} tokens` +
          (l.promptCachedTokens > 0 ? ` (${formatInt(l.promptCachedTokens)} cached)` : '') +
          (Number.isFinite(l.promptTokensPerSec)
            ? ` · ${formatRate(l.promptTokensPerSec)} tok/s`
            : ''),
      ),
    );
    if (Number.isFinite(l.contextUsed) && l.contextUsed > 0) {
      const approx = l.contextExact ? '' : '≈';
      rows.push(
        row(
          'Context used',
          l.contextSize
            ? `${formatMeter(l.contextPercent)} ${approx}${formatInt(l.contextUsed)} / ` +
                `${formatInt(l.contextSize)} tokens (${formatPercent(l.contextPercent)})`
            : `${approx}${formatInt(l.contextUsed)} tokens (context size unknown)`,
        ),
      );
    }
    if (Number.isFinite(l.totalDurationSec))
      rows.push(row('Total time', formatDuration(l.totalDurationSec)));
  }

  if (rows.length) out.push(rows[0], '|:--|:--|', ...rows.slice(1), '');

  if (d.live) {
    const parallel = d.live.count > 1 ? ` (${d.live.count} requests in parallel)` : '';
    out.push(
      `**Generating${parallel}:** ~${formatInt(d.live.tokens)} tokens · ~${formatRate(d.live.tps)} tok/s`,
      '_Live figures are estimated from streamed text; exact counts appear when done._',
      '',
    );
  }

  if (d.totals && d.totals.generations > 0) {
    const t = d.totals;
    out.push(
      `Session: ${formatInt(t.generations)} generation${t.generations === 1 ? '' : 's'} · ` +
        `${formatInt(t.outputTokens)} out · ${formatInt(t.promptTokens)} in`,
      '',
    );
  }

  if (d.note) out.push(escapeMarkdown(d.note), '');

  out.push('---');
  const links = (d.commands || []).map((c) => `[${c.title}](command:${c.id})`);
  const footer = d.version
    ? `Ollama Token Tracker v${escapeMarkdown(d.version)}`
    : 'Ollama Token Tracker';
  out.push([...links, footer].join(' · '));
  return out.join('\n');
}

module.exports = {
  buildStatusMarkdown,
  escapeMarkdown,
  formatAgo,
  formatBytes,
  formatCompact,
  formatDuration,
  formatInt,
  formatKeepAlive,
  formatMeter,
  formatPercent,
  formatProcessor,
  formatRate,
};
