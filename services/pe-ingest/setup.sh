#!/usr/bin/env bash
set -euo pipefail

service_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
python3 -m venv "$service_dir/.venv"
"$service_dir/.venv/bin/python" -m pip install --upgrade pip
"$service_dir/.venv/bin/python" -m pip install -r "$service_dir/requirements.txt"
echo "PE ingest environment ready: $service_dir/.venv"
