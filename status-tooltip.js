"use strict";

function escapeMarkdown(value) {
  if (value === null || value === undefined) return "—";
  return String(value)
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .replace(/\n/g, "<br>");
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function formatProcessor(model) {
  if (!model) return "—";
  if (model.processor) return String(model.processor);

  const total = Number(model.size);
  const vram = Number(model.size_vram);
  if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(vram)) return "—";

  const gpuPercent = Math.max(0, Math.min(100, (vram / total) * 100));
  const cpuPercent = 100 - gpuPercent;
  if (gpuPercent >= 99.5) return "100% GPU";
  if (gpuPercent <= 0.5) return "100% CPU";
  return `${cpuPercent.toFixed(1)}% CPU / ${gpuPercent.toFixed(1)}% GPU`;
}

function buildStatusMarkdown({
  status,
  model,
  size,
  vram,
  processor,
  context,
  note,
  version,
}) {
  const statusText = escapeMarkdown(status || "—");
  const modelName = escapeMarkdown(model || "Unknown model");
  const sizeText = escapeMarkdown(size || "—");
  const vramText = escapeMarkdown(vram || "—");
  const processorText = escapeMarkdown(processor || "—");
  const contextText = escapeMarkdown(context || "—");
  const noteText = escapeMarkdown(note || "No generation has been observed through the proxy yet.");
  const footerText = escapeMarkdown(version ? `Ollama Token Tracker v${version}` : "Ollama Token Tracker");

  // Compact layout:
  // Row 1: current state (no model loaded / ready / generating / error)
  // Row 2: model and context
  // Row 3: size and VRAM
  // Row 4: processor
  return [
    `Status: ${statusText}`,
    `Model: ${modelName}        Context: ${contextText}`,
    `Size: ${sizeText}          VRAM: ${vramText}`,
    `Processor: ${processorText}`,
    "",
    noteText,
    "",
    footerText,
  ].join("<br>");
}

module.exports = {
  buildStatusMarkdown,
  escapeMarkdown,
  formatBytes,
  formatProcessor,
};
