# dsh-plugin-devin

Unofficial bridge between the [Devin CLI](https://devin.ai) and DeepSeek Harness: a `devin` delegation tool plus a `/devin` command running `devin -p` (headless print mode), and a `devin` LLM provider route with automatic model discovery — all over the `ctx.subprocess` seam. Not affiliated with Cognition.

## What the agent gets

- **`devin` tool** — spawns `devin -p "<prompt>"` as a managed child process. Per-call `cwd`, `model`, `permissionMode`, `resume`, `cloud`, and `timeoutMs`. Returns `{ ok, exitCode, stdout, stderr, timedOut, truncated }`.
- **`/devin <task>`** — slash command shortcut (when the profile composes the commands service).

Cancelling the tool call aborts the child via the subprocess seam's terminate escalation (SIGTERM → grace → SIGKILL on the process tree); output capture is bounded and keeps the tail on overflow.

## Prerequisites

- `devin` CLI on `PATH` (or set `devinPath` to an absolute path)
- `devin auth login` completed, or `WINDSURF_API_KEY` exported (forwarded to the child via `forwardEnv`)

## Install

```sh
# from npm
dsh plugin --profile <your-profile> add @quonaro/dsh-plugin-devin

# or straight from a git host
dsh plugin --profile <your-profile> add github:quonaro/dsh-plugin-devin

# or from a local checkout
dsh plugin --profile <your-profile> add /path/to/dsh-plugin-devin
```

The package declares `dsh.bundle`, so `dsh plugin add` applies `cordis.patch.yml` to the profile automatically. On pnpm ≥ 10 the first git install refuses the `prepare` build — copy the package key pnpm prints into the profile's `pnpm-workspace.yaml` `allowBuilds:` and re-run.

## Configuration

Edit the `dsh-plugin-devin` row in the profile's `cordis.patch.yml`, or the derived settings namespace in the GUI. All fields are volatile — changes apply to the next call without a restart.

| Key                     | Default                                 | Notes                                                                                    |
| ----------------------- | --------------------------------------- | ---------------------------------------------------------------------------------------- |
| `devinPath`             | `devin`                                 | Executable name or absolute path                                                         |
| `permissionMode`        | `accept-edits`                          | Headless runs can't answer prompts; `bypass`/`autonomous` for fully unattended work      |
| `model`                 | `''`                                    | Devin model; empty = CLI/account default                                                 |
| `cloud`                 | `false`                                 | `true` → `devin --cloud` (Devin Cloud sessions)                                          |
| `timeoutMs`             | `600000`                                | Cooperative per-call timeout                                                             |
| `maxOutputBytes`        | `1048576`                               | In-memory cap per captured stream; tail kept on overflow                                 |
| `respectWorkspaceTrust` | `false`                                 | `false` → passes `--respect-workspace-trust false` (required for `-p` in untrusted dirs) |
| `forwardEnv`            | PATH/HOME/USER/XDG\_\*/WINDSURF_API_KEY | Env var names forwarded to the child on top of the scrubbed base                         |
| `extraArgs`             | `[]`                                    | Extra flags appended verbatim, e.g. `['--sandbox']`                                      |

## Develop

```sh
pnpm install
pnpm test        # typecheck + tsdown build + smoke test (uses a fake devin binary)
```

## Notes

- The plugin hard-injects `tools` and `subprocess` — profiles must compose a subprocess provider (all shipped base profiles do; `sdk-minimal` does not).
- `--print` mode fails on the workspace-trust prompt in untrusted directories; that's why `respectWorkspaceTrust: false` is the default. Set it `true` if you prefer Devin's own trust flow.
- The provider half keeps persistent ACP sessions (one `devin acp` process, one session per conversation); the `devin` _tool_ stays stateless — `resume` still lets you chain `-p` calls by session ID.

## Provider half (`@quonaro/dsh-plugin-devin/provider`)

The package also ships an LLM-adapter entry point that registers `devin` as a **provider route** — it shows up in Settings → Models and `/model`, and the whole dsh agent loop can run on it.

Generation rides `devin acp` (Agent Client Protocol over stdio) through a pooled connection — **one process serves many sessions**, modelled on acp2api's session manager. A harness conversation (`GenerateOptions.sessionId`) maps to one persistent ACP session:

- a **fresh** session receives the whole transcript (brief + `<transcript>` + every attached image as a native content block) — the agent holds no history of its own;
- a **reused** session receives only the messages it has not seen yet and their images — never a replay, which would duplicate its history;
- turns on one session are single-flight (a second call queues behind the first), while different conversations run in parallel on the same process;
- if the process dies, the next call respawns it, recreates the session, and replays the transcript exactly once;
- compaction and session-title calls get ephemeral sessions so they don't pollute the conversation's own;
- the idle reaper (`sessionIdleMs`) forgets expired session indexes and terminates empty processes; ACP v1 cannot delete a session, so the process is the reclaimable unit. All pooled agents die when the plugin unloads.

Attached images go as **native image content blocks** — SWE and other vision-capable models actually see them. `session/update` notifications stream back as text and reasoning deltas, and the prompt result carries real token usage. `transport: 'print'` keeps the old stateless `devin -p` path (text only — images degrade to `[image]` placeholders). `listModels` probes `devin acp` (`initialize` + `session/new`) for the account's real model catalog and falls back to the static `models` table (`{id, devinModel, name}`) on failure; the session-title aux call is answered locally when `localSessionTitles` is on.

The agent advertises `devin-browser` auth, so `authenticate` is called during the initialize handshake with `WINDSURF_API_KEY` from the forwarded env, or the key stored by `devin auth login` (lazy-retry on an auth-required reply covers servers that demand auth without advertising). `permissionMode` maps to the ACP session mode via `session/set_mode` (`bypass`/`autonomous` → `bypass`; `normal` keeps the account default), the requested model is applied via `session/set_config_option` per session, and `session/request_permission` prompts are answered allow-once. `cloud` and `respectWorkspaceTrust` only apply to `transport: 'print'`.

**Semantics:** Devin is an agent, not a model. Every model call is a complete headless Devin session running its own tool loop — per-response latency is minutes, and harness-side tools are never invoked. The `devin` _tool_ (main entry) is the right shape for delegation; the provider exists for routing whole conversations through Devin.

| Extra config         | Default           | Notes                                                                                                                                                                                   |
| -------------------- | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cwd`                | `''`              | Working dir for spawned sessions; empty = harness cwd                                                                                                                                   |
| `timeoutMs`          | `1800000`         | Provider calls get a longer budget than tool calls                                                                                                                                      |
| `transport`          | `acp`             | `acp` = `devin acp` session/prompt (images, usage, reasoning); `print` = `devin -p` text-only                                                                                           |
| `maxImages`          | `8`               | Most recent image occurrences attached to one ACP prompt                                                                                                                                |
| `maxImageBytes`      | `5242880`         | Per-image byte cap; larger attachments degrade to `[image]` placeholders                                                                                                                |
| `models`             | `default`, `opus` | Advertised model ids → `--model` value + display name                                                                                                                                   |
| `brief`              | (English wrapper) | Instruction prepended to each flattened transcript                                                                                                                                      |
| `localSessionTitles` | `true`            | Don't spend a Devin run on session-title generation                                                                                                                                     |
| `autoDiscoverModels` | `true`            | Probe `devin acp` (`initialize` + `session/new`) for the account's real model catalog — the same mechanism ACP clients like Zed use. Falls back to the static `models` table on failure |
| `discoveryTimeoutMs` | `60000`           | Timeout for one discovery probe                                                                                                                                                         |
| `discoveryCacheMs`   | `300000`          | Cache a successful probe before re-probing                                                                                                                                              |
| `sessionIdleMs`      | `900000`          | Idle lifetime of pooled ACP sessions/processes; an expired session replays on next turn, an empty expired process is terminated. `0` disables reaping                                   |

Both halves are independent rows in `cordis.patch.yml` — remove `dsh-plugin-devin-provider` to keep only the tool, or `dsh-plugin-devin` to keep only the provider.
