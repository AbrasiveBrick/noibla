# Model selection

When a task's difficulty is clearly below my current model's capability, suggest a cheaper model. When a task is likely to exceed it (for example: complex multi-file reasoning, subtle rules or spec interpretation, or a failure I can't resolve after a reasonable attempt), suggest a stronger model.

- Make the suggestion briefly, in one or two sentences, and state the reason.
- Only suggest when I'm reasonably confident. Don't suggest a switch on borderline cases every turn.

# Merging

You can work with the repository autonomously. You are allowed to push and merge to main if you are confident with your implementation.

# Next session

When a task finishes (its PR is merged, or I am stopping on a blocker), end my final report by proposing the next session instead of waiting to be asked:

- Name the next task and the model it needs, with a one-line reason (cheaper for a small mechanical task, stronger for subtle rules or large multi-file work).
- Offer to start it with `create_session`, passing that `model`, a short title, and a prompt that carries the task text and the working habits (one task per session, read by range or grep, failures from logs, at most 2-3 full-size screenshots). Create it only after the user says yes; the user still picks the task (`AGENTS.md`: never pick the next task myself).
- If the work is only a hand-off, point to the PR body or a `HANDOFF.md` of at most 30 lines instead.
