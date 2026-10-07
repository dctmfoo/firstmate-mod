#!/usr/bin/env bash
# capture-replay.sh - copy one Firstmate home's records and Herdr's agent list into a replay home.
#
# Usage: scripts/capture-replay.sh <firstmate-home> .capture/<name>
#
# A capture is real data from your machine: names, task ids, links and paths.
# Keep it under .capture/ (ignored by git) and never commit it; the tests use
# the made-up fixtures/demo-home instead.
#
# Read-only against <firstmate-home> and Herdr: it reads state/home-summary.json,
# each worker's state/<id>.meta and state/<id>.status (a worker is a task whose
# meta names a herdr_tab_id), the workers' lines of data/backlog.md, and runs
# `herdr agent list` and quota-axi --json --no-credential-refresh. It writes
# only under <out-dir>, laid out like a home so the mod reads it with the same code:
#   state/home-summary.json   verbatim
#   state/<id>.meta           trimmed to project (a basename), harness, kind, herdr_tab_id, spawn_gen
#   state/<id>.status         verbatim
#   data/backlog.md           only the workers' task lines, cut to 300 characters
#   herdr/agent-list.json     the agents of the workers' tabs, trimmed to what the mod reads
#   quota.json                quota-axi stdout, as printed
#   bin/herdr, bin/quota-axi  replay stand-ins that print the above
#   capture.json              the capture window and the commands run
set -euo pipefail

home=${1:?usage: capture-replay.sh <firstmate-home> <out-dir>}
out=${2:?usage: capture-replay.sh <firstmate-home> <out-dir>}
home=${home%/}
mkdir -p "$out/state" "$out/data" "$out/herdr" "$out/bin"

started=$(date -u +%Y-%m-%dT%H:%M:%SZ)
cp "$home/state/home-summary.json" "$out/state/home-summary.json"

herdr agent list > "$out/herdr/all-agents.json"
tabs='[]'
: > "$out/data/backlog.md"
for meta in "$home"/state/*.meta; do
  [ -f "$meta" ] || continue
  id=$(basename "$meta" .meta)
  case $id in *[!A-Za-z0-9._-]*) continue ;; esac
  tab=$(sed -n 's/^herdr_tab_id=//p' "$meta" | head -1)
  [ -n "$tab" ] || continue
  grep -E '^(project|harness|kind|herdr_tab_id|spawn_gen)=' "$meta" | sed -E 's#^project=.*/#project=#' > "$out/state/$id.meta"
  [ ! -f "$home/state/$id.status" ] || cp "$home/state/$id.status" "$out/state/$id.status"
  grep -E "^- \[[ xX]\] $id - " "$home/data/backlog.md" | cut -c1-300 >> "$out/data/backlog.md" || true
  tabs=$(jq -c --arg tab "$tab" '. + [$tab]' <<<"$tabs")
done
jq --argjson tabs "$tabs" '{id, result: {type: .result.type,
    agents: [.result.agents[] | select(.tab_id as $t | $tabs | index($t))
             | {agent, agent_status, pane_id, tab_id}]}}' "$out/herdr/all-agents.json" > "$out/herdr/agent-list.json"
rm "$out/herdr/all-agents.json"

quota-axi --provider claude,codex --json --no-credential-refresh > "$out/quota.json" 2>/dev/null || true
ended=$(date -u +%Y-%m-%dT%H:%M:%SZ)

cat > "$out/bin/herdr" <<'STUB'
#!/usr/bin/env bash
# Replay stand-in: prints the `herdr agent list` output captured with this home.
here=$(cd "$(dirname "$0")/.." && pwd)
[ "${1:-} ${2:-}" = "agent list" ] || exit 2
cat "$here/herdr/agent-list.json"
STUB
cat > "$out/bin/quota-axi" <<'STUB'
#!/usr/bin/env bash
# Replay stand-in: prints the quota-axi --json output captured with this home.
here=$(cd "$(dirname "$0")/.." && pwd)
cat "$here/quota.json"
STUB
chmod +x "$out/bin/herdr" "$out/bin/quota-axi"

jq -n --arg started "$started" --arg ended "$ended" --arg home "$home" \
  '{started: $started, ended: $ended, source_home: $home,
    commands: ["cat state/home-summary.json", "cat state/<id>.meta", "cat state/<id>.status",
               "grep task lines of data/backlog.md", "herdr agent list",
               "quota-axi --provider claude,codex --json --no-credential-refresh"]}' > "$out/capture.json"
echo "captured $out ($started - $ended)"
