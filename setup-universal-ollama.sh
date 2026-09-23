#!/usr/bin/env bash
set -euo pipefail

backend_port="${OLLAMA_TRACKER_BACKEND_PORT:-11435}"
drop_in_dir="/etc/systemd/system/ollama.service.d"
drop_in_file="${drop_in_dir}/ollama-token-tracker.conf"

echo "Moving the Ollama backend to 127.0.0.1:${backend_port}..."
printf '[Service]\nEnvironment="OLLAMA_HOST=127.0.0.1:%s"\n' "$backend_port" \
  | sudo install -D -m 0644 /dev/stdin "$drop_in_file"
sudo systemctl daemon-reload
sudo systemctl restart ollama

echo "Universal routing is ready:"
echo "  Ollama backend: http://127.0.0.1:${backend_port}"
echo "  Tracker proxy:  http://127.0.0.1:11434"
echo "Restart VS Code, then use Ollama normally."