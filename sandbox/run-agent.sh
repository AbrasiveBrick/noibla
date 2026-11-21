#!/usr/bin/env bash
# Start one LLM agent in its own rootless Podman container.
#   sandbox/run-agent.sh <name> [prompt-file] [-- command...]
# Env: RUNNER=claude|opencode  MODEL=...  NOIBLA_PORT=7777  IMAGE=noibla-agent
#      CLAUDE_CODE_OAUTH_TOKEN (from `claude setup-token`) for RUNNER=claude
#      OPENCODE_API_KEY (optional) for RUNNER=opencode
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

tty=(); [[ -t 0 && -t 1 ]] && tty=(-it)
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
  ${CLAUDE_CODE_OAUTH_TOKEN:+-e CLAUDE_CODE_OAUTH_TOKEN} \
  ${OPENCODE_API_KEY:+-e OPENCODE_API_KEY} \
  "${IMAGE:-noibla-agent}" "$@"
