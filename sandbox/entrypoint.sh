#!/bin/sh
# Runs inside the container. Starts the chosen LLM runner on the mounted prompt.
# For RUNNER=claude the agent keeps playing until the container is stopped: each
# time the model ends its turn, the same session is resumed with a short nudge.
# A rerun of the container resumes the saved session in /work/.home as well.
set -eu
mkdir -p "$HOME"
PROMPT_FILE=${PROMPT_FILE:-/opt/prompt.md}
[ "$#" -gt 0 ] && exec "$@"   # e.g. `run-agent.sh name -- sh` for a debug shell
prompt=$(sed "s/{{AGENT_NAME}}/${AGENT_NAME}/g" "$PROMPT_FILE")
nudge=${NUDGE:-"Keep playing. Check your observation and /work/notes.md, choose your next goal, and act on it. Don't stop to summarize; the session ends only when the operator stops it."}
pause=${LOOP_PAUSE_SECONDS:-5}

# As PID 1 the shell ignores SIGTERM/SIGINT unless trapped. Children run in the
# background so `wait` returns at once on a signal and stop is immediate.
child=
trap '[ -n "$child" ] && kill "$child" 2>/dev/null; exit 0' TERM INT
bg_wait() { "$@" & child=$!; wait "$child"; }
# --thinking-display summarized: without it the transcript gets thinking blocks with no text. It changes only what
# the API returns. --help does not list the flag: check it still works when bumping the CLI pinned in the Containerfile.
# Every turn must end the process, or the loop below never sends the next nudge. In 2.1.330 `claude -p` stays alive after
# its result while a background task or a scheduled wakeup is pending (ScheduleWakeup, Monitor, run_in_background Bash).
# So those are switched off: the env vars drop run_in_background and cron/wakeups; --disallowedTools also drops the
# tools themselves. With background tasks off the CLI no longer moves a Bash call past 2 minutes to the background: it
# kills it. So the Bash timeout is raised to 10 minutes: a foreground call (a long game script) ends at 10 minutes;
# anything longer must be detached (`nohup ... &`), which survives the turn. See "Turns must end" in sandbox/README.md.
export BASH_DEFAULT_TIMEOUT_MS=600000 BASH_MAX_TIMEOUT_MS=600000
export CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1 CLAUDE_CODE_DISABLE_CRON=1
claude_run() {
  bg_wait claude "$@" --model "${MODEL:-sonnet}" --thinking-display summarized --disallowedTools ScheduleWakeup Monitor CronCreate --dangerously-skip-permissions --output-format stream-json --verbose
}

case "${RUNNER:-claude}" in
  claude)
    if ls "$HOME"/.claude/projects/*/*.jsonl >/dev/null 2>&1; then
      claude_run -c -p "$nudge" || true
    else
      claude_run -p "$prompt" || true
    fi
    while :; do
      bg_wait sleep "$pause"
      # A failed run (quota, network) backs off before resuming.
      claude_run -c -p "$nudge" || bg_wait sleep 60
    done ;;
  opencode)
    exec opencode run ${MODEL:+--model "$MODEL"} "$prompt" ;;
  *) echo "unknown RUNNER=$RUNNER (claude|opencode)" >&2; exit 2 ;;
esac
