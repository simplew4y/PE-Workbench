#!/usr/bin/env bash
set -euo pipefail

service_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "$service_dir/../../../../packages/pe-boot/python/setup.mjs" "$@"
