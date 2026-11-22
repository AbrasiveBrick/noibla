#!/bin/sh
# Checks that every ended turn leads to the next nudge, using the real claude CLI in the image against a local
# stand-in API, with no network. Run from the repo root after building the image:
#   sandbox/check/turns.sh [entrypoint.sh]     (default: sandbox/entrypoint.sh; pass another to compare)
# Each scenario has the model call a tool that used to keep `claude -p` alive after its turn, then waits 30 s and
# requires >= 3 finished turns (turn 1 + nudges). Exit 0 when all scenarios pass.
set -u
cd "$(dirname "$0")/../.."
ep=${1:-sandbox/entrypoint.sh}
img=${IMAGE:-noibla-agent}
fail=0
check() { # name tool input
  work=$(mktemp -d); prompt=$work/prompt.md; echo "You are {{AGENT_NAME}}." > "$prompt"
  out=$(podman run --rm --network none --userns=keep-id -e TOOL="$2" -e INPUT="$3" -e AGENT_NAME=t -e PROMPT_FILE=/p/prompt.md \
    -e LOOP_PAUSE_SECONDS=1 -e ANTHROPIC_BASE_URL=http://127.0.0.1:8099 -e ANTHROPIC_API_KEY=sk-not-real -e MODEL=sonnet \
    -v "$PWD/sandbox/check:/chk:ro" -v "$PWD/$ep:/ep.sh:ro" -v "$work:/p:ro" -v "$work:/work:rw" --entrypoint sh "$img" \
    -c 'node /chk/fake-api.mjs 2>/dev/null & sleep 1; exec timeout 30 sh /ep.sh' 2>&1)
  n=$(printf '%s\n' "$out" | grep -c '"type":"result"')
  if [ "$n" -ge 3 ]; then echo "ok   $1: $n turns in 30 s"; else echo "FAIL $1: only $n turn(s) in 30 s (frozen)"; fail=1; fi
  rm -rf "$work"
}
check "background Bash (sleep 600)" Bash '{"command":"sleep 600","description":"x","run_in_background":true}'
check "ScheduleWakeup" ScheduleWakeup '{"delaySeconds":300,"prompt":"p","reason":"r"}'
check "foreground Bash"  Bash '{"command":"sleep 2; echo ok","description":"x"}'
exit $fail
