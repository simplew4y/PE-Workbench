#!/usr/bin/env bash
set -euo pipefail
reader_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
"${PE_DOCUMENT_PYTHON:-python3}" -m venv "$reader_dir/.venv"
"$reader_dir/.venv/bin/python" -m pip install -r "$reader_dir/requirements.txt"
