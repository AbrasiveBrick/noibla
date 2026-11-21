#!/bin/sh
# Runs inside the container. Starts the chosen LLM runner on the mounted prompt.
set -eu
mkdir -p "$HOME"
PROMPT_FILE=${PROMPT_FILE:-/opt/prompt.md}
[ "$#" -gt 0 ] && exec "$@"   # e.g. `run-agent.sh name -- sh` for a debug shell
prompt=$(sed "s/{{AGENT_NAME}}/${AGENT_NAME}/g" "$PROMPT_FILE")
case "${RUNNER:-claude}" in
  claude)
    exec claude -p "$prompt" --model "${MODEL:-sonnet}" --dangerously-skip-permissions --output-format stream-json --verbose ;;
  opencode)
    exec opencode run ${MODEL:+--model "$MODEL"} "$prompt" ;;
  *) echo "unknown RUNNER=$RUNNER (claude|opencode)" >&2; exit 2 ;;
esac
