#!/usr/bin/env bash
# check-public.sh - fail when tracked files contain local absolute paths, which
# usually means data copied from a real machine or Firstmate home.
#
# Usage: scripts/check-public.sh
set -euo pipefail

cd "$(dirname "$0")/.."
# The final double backslash is ERE syntax for a literal Windows path separator.
# shellcheck disable=SC1003
pattern='/(Users|home)/[A-Za-z0-9._-]+/|/Volumes/[A-Za-z0-9._-]+/|[A-Za-z]:\\Users\\'
if git grep -n -I -E "$pattern" -- . ':!scripts/check-public.sh'; then
  echo "check-public: local absolute paths found above; replace them with made-up data" >&2
  exit 1
fi
echo "check-public: no local absolute paths"
