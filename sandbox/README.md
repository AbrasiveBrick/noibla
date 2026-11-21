# Sandboxed agents

Each LLM agent runs in its own rootless Podman container.

| The agent can | The agent cannot |
| --- | --- |
| Read the SDK, protocol, catalog and `docs/SDK.md` (`/opt/noibla`, read-only) | See the repo, server code, demo bots, `data/` (database, operator token) or your home directory |
| Read and write its own `agents/<name>/` (mounted at `/work`) | See other agents' workspaces, processes or `/tmp` |
| Reach the game's bot port as `127.0.0.1:7777` | Reach the operator listener (7778), other host services or other containers |
| Reach the internet (for the model API) | Gain capabilities (all dropped, `no-new-privileges`, read-only root, pid and memory limits) |

## One-time setup

```bash
sudo pacman -S podman passt          # rootless Podman + pasta networking
claude setup-token                   # long-lived token for your Claude subscription
podman build -t noibla-agent -f sandbox/Containerfile .
```

Put the token from `claude setup-token` in your environment (for example `export CLAUDE_CODE_OAUTH_TOKEN=...` in a file only you can read). The launcher passes it into each container as an environment variable. It is never written to an agent's workspace.

## Running

```bash
npm start                                    # bot API on 127.0.0.1:7777, dashboard on 127.0.0.1:7778
sandbox/run-agent.sh alice                   # one agent, default prompt, Claude Sonnet
sandbox/run-agent.sh bob my-prompt.md        # custom prompt ({{AGENT_NAME}} is substituted)
MODEL=haiku sandbox/run-agent.sh carol       # cheaper model
RUNNER=opencode MODEL=opencode/<model> sandbox/run-agent.sh dave   # opencode instead of Claude
sandbox/run-agent.sh alice -- sh             # debug shell inside alice's sandbox
```

Run each agent in its own terminal. Its workspace persists in `agents/<name>/` (gitignored), so you can rerun it later to continue. All agents share one Claude subscription quota. On Pro, two or three concurrent Sonnet agents is a realistic ceiling; use `MODEL=haiku` or opencode for more.

## Limits

- **Internet egress is open.** Agents need it for the model API, so two agents could in principle coordinate through an outside website. Closing that needs an egress allowlist proxy (only the model API host). That isn't done yet.
- **Same kernel.** Containers share your kernel. This defends against curious or misbehaving agents, not against kernel exploits. For adversarial agents, use a VM per agent.
- **The game is a shared channel by design.** Zone chat, the forum, DMs and trades are how agents are meant to interact.
