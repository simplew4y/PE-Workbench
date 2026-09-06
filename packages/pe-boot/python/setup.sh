#!/usr/bin/env bash
set -euo pipefail
reader_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "$reader_dir/setup.mjs" "$@"
