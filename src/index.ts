/**
 * dsh-plugin-devin — delegate tasks to the Devin CLI from DeepSeek Harness.
 *
 * Registers one model-facing tool, `devin`, which spawns `devin -p` (headless
 * print mode) through the ctx.subprocess seam: bounded captured output,
 * process-tree termination, and abort-signal escalation come from the seam.
 * A `/devin <prompt>` slash command is added when the host composes the
 * commands service.
 *
 * Auth: the spawned CLI reads credentials stored by `devin auth login`
 * (or WINDSURF_API_KEY when forwarded via Config.forwardEnv).
 *
 * @module @quonaro/dsh-plugin-devin
 */

import type { Context, Volatile } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { devinPrintArgv, forwardedEnv } from './shared.ts'

/** Host plugin name; must match package.json `name` and the cordis.patch.yml row id. */
export const name = '@quonaro/dsh-plugin-devin'

/** Services this plugin needs before it loads: the tool registry and a subprocess provider. */
export const inject = ['tools', 'subprocess']

/** Plugin configuration; every field is a Volatile re-read at each call. */
export interface Config {
  /** Path or PATH-resolved name of the Devin CLI executable. */
  devinPath: Volatile<string>
  /** `--permission-mode` for spawned sessions; headless runs cannot answer prompts. */
  permissionMode: Volatile<string>
  /** Default `--model`; empty string means the CLI/account default. */
  model: Volatile<string>
  /** Spawn with `--cloud` to drive Devin Cloud sessions instead of the local agent. */
  cloud: Volatile<boolean>
  /** Cooperative timeout in milliseconds for one delegation call. */
  timeoutMs: Volatile<number>
  /** In-memory cap per captured stream; overflow keeps the tail. */
  maxOutputBytes: Volatile<number>
  /** When false, `--respect-workspace-trust false` is passed (non-interactive runs cannot show the trust prompt). */
  respectWorkspaceTrust: Volatile<boolean>
  /** Environment variable names forwarded to the devin child process. */
  forwardEnv: Volatile<string[]>
  /** Extra CLI flags appended verbatim before the prompt. */
  extraArgs: Volatile<string[]>
}

/** Schemastery schema: defaults live here; cordis.yml and GUI edits are validated against it. */
export const Config = Schema.object({
  devinPath: Schema.string().default('devin').volatile(),
  permissionMode: Schema.union(['normal', 'accept-edits', 'smart', 'bypass', 'autonomous'] as const).default('accept-edits').volatile(),
  model: Schema.string().default('').volatile(),
  cloud: Schema.boolean().default(false).volatile(),
  timeoutMs: Schema.number().default(600_000).volatile(),
  maxOutputBytes: Schema.number().default(1_048_576).volatile(),
  respectWorkspaceTrust: Schema.boolean().default(false).volatile(),
  forwardEnv: Schema.array(Schema.string()).default(['PATH', 'HOME', 'USER', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'WINDSURF_API_KEY']).volatile(),
  extraArgs: Schema.array(Schema.string()).default([]).volatile(),
})

/** Canonical result of one devin delegation, declared by output.schema. */
interface DevinRunResult {
  ok: boolean
  exitCode: number
  signal: string
  timedOut: boolean
  truncated: boolean
  stdout: string
  stderr: string
}

interface DevinRunOptions {
  prompt: string
  cwd: string
  model?: string | undefined
  permissionMode?: string | undefined
  resume?: string | undefined
  cloud?: boolean | undefined
  timeoutMs?: number | undefined
  signal?: AbortSignal | undefined
}

/** Spawn `devin -p` once and collect bounded stdout/stderr. Shared by the tool and the command. */
async function runDevin(ctx: Context, config: Config, options: DevinRunOptions): Promise<DevinRunResult> {
  const env = forwardedEnv(config.forwardEnv.get())
  const executable = await ctx.subprocess.resolveExecutable(config.devinPath.get(), env, options.signal)

  const timeoutMs = options.timeoutMs ?? config.timeoutMs.get()
  const argv = [
    executable,
    ...devinPrintArgv({
      model: options.model ?? config.model.get(),
      permissionMode: options.permissionMode ?? config.permissionMode.get(),
      cloud: options.cloud ?? config.cloud.get(),
      resume: options.resume,
      respectWorkspaceTrust: config.respectWorkspaceTrust.get(),
      extraArgs: config.extraArgs.get(),
    }, options.prompt),
  ]

  const timeout = AbortSignal.timeout(timeoutMs)
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
  const maxBytes = config.maxOutputBytes.get()

  const handle = ctx.subprocess.spawn({
    argv,
    cwd: options.cwd,
    stdio: {
      stdin: 'ignore',
      stdout: { maxBytes },
      stderr: { maxBytes },
    },
    graceMs: 10_000,
    signal,
    env,
  })

  const outcome = await handle.done
  const stdout = handle.collected.stdout?.readFrom(0)
  const stderr = handle.collected.stderr?.readFrom(0)
  const timedOut = timeout.aborted

  return {
    ok: !timedOut && outcome.exitCode === 0,
    exitCode: outcome.exitCode ?? -1,
    signal: outcome.signal ?? '',
    timedOut,
    truncated: Boolean(stdout?.lossy || stderr?.lossy),
    stdout: stdout?.text ?? '',
    stderr: stderr?.text ?? '',
  }
}

function renderResult(result: DevinRunResult): string {
  const head = result.timedOut
    ? 'devin timed out and was terminated.'
    : result.ok
      ? 'devin finished successfully.'
      : `devin exited with code ${result.exitCode}${result.signal ? ` (signal ${result.signal})` : ''}.`
  const tail = result.truncated ? '\n[output truncated — tail shown]' : ''
  return `${head}\n\n${result.stdout || '(no stdout)'}${result.stderr ? `\n\n--- stderr ---\n${result.stderr}` : ''}${tail}`
}

/** /devin command payload shape (minimal subset of dsh-commands CommandInvocation). */
interface DevinCommandInvocation {
  readonly rawInput: string
}

interface DevinCommandResult {
  kind: 'success' | 'error'
  text?: string
}

interface DevinCommandsLike {
  register(definition: {
    readonly name: string
    readonly description: string
    readonly handler: (invocation: DevinCommandInvocation) => DevinCommandResult | Promise<DevinCommandResult>
  }): unknown
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Command registry (provided at runtime by @deepseek-ai/dsh-commands, optional). */
    commands: DevinCommandsLike
  }
}

/**
 * Plugin body: register the `devin` tool, and `/devin` when a commands
 * service is composed. All registrations are effects — unloading the plugin
 * reverts them automatically.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.tools.register(defineTool({
    name: 'devin',
    description:
      'Delegate a task to the Devin CLI agent (`devin -p`, headless). Devin works ' +
      'autonomously in the given directory and its final answer is returned as text. ' +
      'Prefer this for self-contained chunks of work you want a second agent to own ' +
      'end-to-end. The call blocks until Devin finishes or the configured timeout fires.',
    parameters: {
      prompt: {
        type: 'string',
        required: true,
        description: 'The task for Devin, written self-contained — it does not see this conversation.',
      },
      cwd: {
        type: 'string',
        description: 'Working directory for the Devin session. Defaults to the current directory.',
      },
      model: {
        type: 'string',
        description: 'Devin model override for this call (e.g. "opus"). Defaults to the plugin config value.',
      },
      permissionMode: {
        type: 'string',
        enum: ['normal', 'accept-edits', 'smart', 'bypass', 'autonomous'],
        description: 'Permission mode for the spawned session. Headless runs cannot answer prompts; the default comes from plugin config.',
      },
      resume: {
        type: 'string',
        description: 'Resume an existing Devin session by ID (or cloud session URL with cloud=true) instead of starting a new one.',
      },
      cloud: {
        type: 'boolean',
        description: 'Drive a Devin Cloud session instead of the local agent. Defaults to the plugin config value.',
      },
      timeoutMs: {
        type: 'number',
        description: 'Timeout in milliseconds for this call. Defaults to the plugin config value.',
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean', required: true },
          exitCode: { type: 'integer', required: true },
          signal: { type: 'string', required: true },
          timedOut: { type: 'boolean', required: true },
          truncated: { type: 'boolean', required: true },
          stdout: { type: 'string', required: true },
          stderr: { type: 'string', required: true },
        },
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: renderResult(value) }],
    },
    async execute(args, exec) {
      return runDevin(ctx, config, {
        prompt: args.prompt,
        cwd: args.cwd ?? process.cwd(),
        model: args.model,
        permissionMode: args.permissionMode,
        resume: args.resume,
        cloud: args.cloud,
        timeoutMs: args.timeoutMs,
        signal: exec.signal,
      })
    },
    presentResult: (_args, result) => ({
      card: 'generic' as const,
      title: 'devin',
      content: result.content,
    }),
  }))

  ctx.inject(['commands'], (commandCtx) => {
    commandCtx.commands.register({
      name: 'devin',
      description: 'Delegate a task to the Devin CLI (devin -p). Usage: /devin <task>',
      handler: async ({ rawInput }) => {
        const prompt = rawInput.trim()
        if (!prompt) return { kind: 'error' as const, text: 'Usage: /devin <task for Devin>' }
        const result = await runDevin(ctx, config, { prompt, cwd: process.cwd() })
        return {
          kind: result.ok ? ('success' as const) : ('error' as const),
          text: renderResult(result),
        }
      },
    })
  })
}
