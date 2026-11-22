#!/usr/bin/env bash
# Start one LLM agent in its own rootless Podman container.
#   sandbox/run-agent.sh <name> [prompt-file] [-- command...]
# Env: RUNNER=claude|opencode  MODEL=...  NOIBLA_PORT=7777  IMAGE=noibla-agent
#      NUDGE, LOOP_PAUSE_SECONDS (claude loop; see entrypoint.sh)
#      CLAUDE_CODE_OAUTH_TOKEN (from `claude setup-token`) for RUNNER=claude
#      OPENCODE_API_KEY (optional) for RUNNER=opencode
#      AGENT_LOG_DIR (default agent-logs/): where each transcript is kept for the dashboard
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
root=$(dirname "$here")
name=${1:?usage: run-agent.sh <name> [prompt-file] [-- command...]}; shift
[[ $name =~ ^[A-Za-z0-9_-]{1,32}$ ]] || { echo "name must be 1-32 chars of A-Z a-z 0-9 _ -" >&2; exit 2; }
prompt="$here/agent-prompt.md"
if [[ $# -gt 0 && $1 != "--" ]]; then prompt=$(realpath "$1"); shift; fi
[[ ${1:-} == "--" ]] && shift
port=${NOIBLA_PORT:-7777}
runner=${RUNNER:-claude}
if [[ $runner == claude && -z ${CLAUDE_CODE_OAUTH_TOKEN:-} && $# -eq 0 ]]; then
  echo "CLAUDE_CODE_OAUTH_TOKEN is not set. Run \`claude setup-token\` once and export it." >&2; exit 2
fi

work="$root/agents/$name"
mkdir -p "$work"
chmod 700 "$work"

tty=()
if [[ $# -gt 0 ]]; then
  [[ -t 0 && -t 1 ]] && tty=(-it)
else
  # An agent run: the dashboard reads the transcript from a directory no agent has mounted, with credentials hidden.
  # The filter ignores Ctrl-C, so the last lines still land after podman has passed the signal on.
  logs=${AGENT_LOG_DIR:-$root/agent-logs}
  mkdir -p -m 700 "$logs"
  log="$logs/$name.log"
  touch "$log"; chmod 600 "$log"
  exec > >(trap '' INT TERM; sed -u -E 's/sk-ant-[A-Za-z0-9_-]+/[token hidden]/g; s/bot_[A-Za-z0-9_-]{16,}/[bot token hidden]/g' | tee -a "$log") 2>&1
fi
# Network: pasta gives the container its own namespace with internet access.
#   -T <port>     container 127.0.0.1:<port> -> host 127.0.0.1:<port> (bot API only)
#   --no-map-gw   the host is not reachable through the gateway address, so the
#                 operator port and every other host service stay out of reach
exec podman run --rm "${tty[@]}" --name "noibla-$name" --hostname "$name" \
  --network "pasta:-T,$port,--no-map-gw" \
  --userns=keep-id --read-only --tmpfs /tmp:rw,size=256m \
  --cap-drop=all --security-opt no-new-privileges \
  --pids-limit 512 --memory 2g \
  -v "$work:/work:rw,Z" -v "$prompt:/opt/prompt.md:ro" \
  -e AGENT_NAME="$name" -e NOIBLA_URL="http://127.0.0.1:$port" \
  -e RUNNER="$runner" ${MODEL:+-e MODEL="$MODEL"} \
  ${NUDGE:+-e NUDGE} ${LOOP_PAUSE_SECONDS:+-e LOOP_PAUSE_SECONDS} \
  ${CLAUDE_CODE_OAUTH_TOKEN:+-e CLAUDE_CODE_OAUTH_TOKEN} \
  ${OPENCODE_API_KEY:+-e OPENCODE_API_KEY} \
  "${IMAGE:-noibla-agent}" "$@"
