# dsh-plugin-devin

Delegate tasks to the [Devin CLI](https://devin.ai) from DeepSeek Harness — one `devin` tool plus a `/devin` command running `devin -p` (headless print mode) through the `ctx.subprocess` seam.

## What the agent gets

- **`devin` tool** — spawns `devin -p "<prompt>"` as a managed child process. Per-call `cwd`, `model`, `permissionMode`, `resume`, `cloud`, and `timeoutMs`. Returns `{ ok, exitCode, stdout, stderr, timedOut, truncated }`.
- **`/devin <task>`** — slash command shortcut (when the profile composes the commands service).

Cancelling the tool call aborts the child via the subprocess seam's terminate escalation (SIGTERM → grace → SIGKILL on the process tree); output capture is bounded and keeps the tail on overflow.

## Prerequisites

- `devin` CLI on `PATH` (or set `devinPath` to an absolute path)
- `devin auth login` completed, or `WINDSURF_API_KEY` exported (forwarded to the child via `forwardEnv`)

## Install

```sh
# from a local checkout
dsh plugin --profile <your-profile> add /path/to/dsh-plugin-devin

# or straight from a git host
dsh plugin --profile <your-profile> add github:quonaro/dsh-plugin-devin
```

The package declares `dsh.bundle`, so `dsh plugin add` applies `cordis.patch.yml` to the profile automatically. On pnpm ≥ 10 the first git install refuses the `prepare` build — copy the package key pnpm prints into the profile's `pnpm-workspace.yaml` `allowBuilds:` and re-run.

## Configuration

Edit the `dsh-plugin-devin` row in the profile's `cordis.patch.yml`, or the derived settings namespace in the GUI. All fields are volatile — changes apply to the next call without a restart.

| Key | Default | Notes |
| --- | --- | --- |
| `devinPath` | `devin` | Executable name or absolute path |
| `permissionMode` | `accept-edits` | Headless runs can't answer prompts; `bypass`/`autonomous` for fully unattended work |
| `model` | `''` | Devin model; empty = CLI/account default |
| `cloud` | `false` | `true` → `devin --cloud` (Devin Cloud sessions) |
| `timeoutMs` | `600000` | Cooperative per-call timeout |
| `maxOutputBytes` | `1048576` | In-memory cap per captured stream; tail kept on overflow |
| `respectWorkspaceTrust` | `false` | `false` → passes `--respect-workspace-trust false` (required for `-p` in untrusted dirs) |
| `forwardEnv` | PATH/HOME/USER/XDG_*/WINDSURF_API_KEY | Env var names forwarded to the child on top of the scrubbed base |
| `extraArgs` | `[]` | Extra flags appended verbatim, e.g. `['--sandbox']` |

## Develop

```sh
pnpm install
pnpm test        # typecheck + tsdown build + smoke test (uses a fake devin binary)
```

## Notes

- The plugin hard-injects `tools` and `subprocess` — profiles must compose a subprocess provider (all shipped base profiles do; `sdk-minimal` does not).
- `--print` mode fails on the workspace-trust prompt in untrusted directories; that's why `respectWorkspaceTrust: false` is the default. Set it `true` if you prefer Devin's own trust flow.
- An alternative shape — a persistent `devin acp` bridge with resumable sessions — is deliberately out of scope for v0.1; `resume` still lets you chain `-p` calls by session ID.

## Provider half (`dsh-plugin-devin/provider`)

The package also ships an LLM-adapter entry point that registers `devin` as a **provider route** — it shows up in Settings → Models and `/model`, and the whole dsh agent loop can run on it.

Each generation spawns `devin -p` with the flattened conversation transcript and streams stdout back as one text block. `listModels` comes from the `models` config table (`{id, devinModel, name}`); the session-title aux call is answered locally when `localSessionTitles` is on.

**Semantics:** Devin is an agent, not a model. Every model call is a complete headless Devin session running its own tool loop — per-response latency is minutes, and harness-side tools are never invoked. The `devin` *tool* (main entry) is the right shape for delegation; the provider exists for routing whole conversations through Devin.

| Extra config | Default | Notes |
| --- | --- | --- |
| `cwd` | `''` | Working dir for spawned sessions; empty = harness cwd |
| `timeoutMs` | `1800000` | Provider calls get a longer budget than tool calls |
| `models` | `default`, `opus` | Advertised model ids → `--model` value + display name |
| `brief` | (English wrapper) | Instruction prepended to each flattened transcript |
| `localSessionTitles` | `true` | Don't spend a Devin run on session-title generation |
| `autoDiscoverModels` | `true` | Probe `devin acp` (`initialize` + `session/new`) for the account's real model catalog — same mechanism OmniACP uses. Falls back to the static `models` table on failure |
| `discoveryTimeoutMs` | `60000` | Timeout for one discovery probe |
| `discoveryCacheMs` | `300000` | Cache a successful probe before re-probing |

Both halves are independent rows in `cordis.patch.yml` — remove `dsh-plugin-devin-provider` to keep only the tool, or `dsh-plugin-devin` to keep only the provider.
