/**
 * dsh-plugin-devin/provider — expose the Devin CLI as an LLM provider route.
 *
 * Registers provider `devin` with `ctx.llm.registerAdapter`, so it appears
 * alongside ordinary model providers (Settings → Models, `/model`, agent
 * presets). Each generation spawns `devin -p` with the flattened transcript
 * and streams its stdout back as one text block.
 *
 * Semantics worth knowing before enabling: Devin is an agent, not a model.
 * Every call is a complete headless Devin session — it runs its own tool
 * loop internally and cannot invoke this harness's tools. Use it to hand
 * whole tasks to Devin; per-token latency is minutes, not milliseconds.
 *
 * @module dsh-plugin-devin/provider
 */

import type { Context, Volatile } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import type {
  ContentBlock,
  GenerateOptions,
  LlmModelInfo,
  LlmResolvedModelInfo,
  RequestMessage,
  StreamChunk,
  ToolSchema,
} from '@deepseek-ai/dsh-llm'
import { devinPrintArgv, forwardedEnv } from './shared.ts'
import { discoverModelsViaAcp, type DiscoveryResult } from './discover.ts'

// Re-exported so the inferred Config type can name Dict in the emitted .d.ts (TS2883).
export type { Dict } from '@deepseek-ai/cosmokit'

/** Plugin name; the cordis.patch.yml row uses the `dsh-plugin-devin/provider` specifier. */
export const name = 'dsh-plugin-devin-provider'

/** Services this plugin needs: the llm adapter registry and a subprocess provider. */
export const inject = ['llm', 'subprocess']

/** Plugin configuration; every field is a Volatile re-read at each call. */
export interface Config {
  /** Path or PATH-resolved name of the Devin CLI executable. */
  devinPath: Volatile<string>
  /** `--permission-mode` for spawned sessions; headless runs cannot answer prompts. */
  permissionMode: Volatile<string>
  /** Spawn with `--cloud` to drive Devin Cloud sessions instead of the local agent. */
  cloud: Volatile<boolean>
  /** Working directory for every spawned session; empty = the harness cwd. */
  cwd: Volatile<string>
  /** Cooperative timeout in milliseconds per generation. Devin runs are slow. */
  timeoutMs: Volatile<number>
  /** In-memory cap for the captured stderr tail surfaced on failure. */
  stderrMaxBytes: Volatile<number>
  /** When false, `--respect-workspace-trust false` is passed. */
  respectWorkspaceTrust: Volatile<boolean>
  /** Environment variable names forwarded to the devin child process. */
  forwardEnv: Volatile<string[]>
  /** Extra CLI flags appended verbatim before the prompt. */
  extraArgs: Volatile<string[]>
  /**
   * Advertised models, in selector order. `id` is the route model id passed via
   * GenerateOptions.model; `devinModel` is the `--model` value ('' = the
   * CLI/account default); `name` is the display name in the model selector.
   */
  models: Volatile<{ id: string; devinModel: string; name: string }[]>
  /**
   * Instruction prepended to every flattened transcript, telling Devin it runs
   * as a model backend and must finish autonomously.
   */
  brief: Volatile<string>
  /** Answer session-title requests locally instead of spending a Devin run on them. */
  localSessionTitles: Volatile<boolean>
  /** Probe `devin acp` for the account's real model catalog instead of using the static `models` table. */
  autoDiscoverModels: Volatile<boolean>
  /** Timeout for one ACP discovery probe (initialize + session/new). */
  discoveryTimeoutMs: Volatile<number>
  /** How long a successful discovery result is cached before re-probing. */
  discoveryCacheMs: Volatile<number>
}

const DEFAULT_BRIEF =
  'You are Devin, an autonomous software-engineering agent, invoked as the model backend ' +
  'of another agent harness. The transcript of the calling conversation is below. Carry out ' +
  'the most recent user request end-to-end using your own tools and judgment. Do not ask ' +
  'questions — act autonomously. Your final printed answer is returned verbatim as the ' +
  "model's reply."

/** Schemastery schema: defaults live here; cordis.yml and GUI edits are validated against it. */
export const Config = Schema.object({
  devinPath: Schema.string().default('devin').volatile(),
  permissionMode: Schema.union(['normal', 'accept-edits', 'smart', 'bypass', 'autonomous'] as const).default('accept-edits').volatile(),
  cloud: Schema.boolean().default(false).volatile(),
  cwd: Schema.string().default('').volatile(),
  timeoutMs: Schema.number().default(1_800_000).volatile(),
  stderrMaxBytes: Schema.number().default(65_536).volatile(),
  respectWorkspaceTrust: Schema.boolean().default(false).volatile(),
  forwardEnv: Schema.array(Schema.string()).default(['PATH', 'HOME', 'USER', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'WINDSURF_API_KEY']).volatile(),
  extraArgs: Schema.array(Schema.string()).default([]).volatile(),
  models: Schema.array(Schema.object({
    id: Schema.string(),
    devinModel: Schema.string().default(''),
    name: Schema.string().default(''),
  })).default([
    { id: 'default', devinModel: '', name: 'Devin (account default)' },
    { id: 'opus', devinModel: 'opus', name: 'Devin Opus' },
  ] as { id: string; devinModel: string; name: string }[]).volatile(),
  brief: Schema.string().default(DEFAULT_BRIEF).volatile(),
  localSessionTitles: Schema.boolean().default(true).volatile(),
  autoDiscoverModels: Schema.boolean().default(true).volatile(),
  discoveryTimeoutMs: Schema.number().default(60_000).volatile(),
  discoveryCacheMs: Schema.number().default(300_000).volatile(),
})

const ROLE_LABEL: Record<string, string> = {
  system: 'system',
  developer: 'developer',
  user: 'user',
  assistant: 'assistant',
  tool: 'tool result',
}

/** Project one message's blocks into transcript text. */
function blocksToText(blocks: readonly ContentBlock[]): string {
  return blocks.map((block) => {
    switch (block.type) {
      case 'text': return block.text
      case 'reasoning': return `<thinking>\n${block.text}\n</thinking>`
      case 'tool-call': return `[tool call ${block.name} #${block.id}]: ${block.arguments}`
      case 'image': return '[image]'
      case 'file': return '[file]'
      case 'tool-addition': return `[tool enabled: ${block.toolName}]`
      case 'tool-removal': return `[tool disabled: ${block.toolName}]`
      default: return `[${(block as { type: string }).type}]`
    }
  }).join('\n')
}

/** Flatten one generation request into the prompt handed to `devin -p`. */
function buildPrompt(options: GenerateOptions, brief: string): string {
  const parts: string[] = [brief, '', '<transcript>']
  if (options.system) parts.push('## system', options.system, '')
  for (const message of options.messages) {
    parts.push(`## ${ROLE_LABEL[message.role] ?? message.role}`, blocksToText(message.content), '')
  }
  parts.push('</transcript>')
  if (options.tools?.length) {
    const names = options.tools.map((tool: ToolSchema) => tool.name).slice(0, 12).join(', ')
    parts.push('', `[note: the caller declared ${options.tools.length} of its own tools (${names}${options.tools.length > 12 ? ', …' : ''}) — you cannot invoke them; complete the work with your own capabilities.]`)
  }
  return parts.join('\n')
}

/** Map an advertised route id to its `--model` value; unknown ids pass through verbatim. */
function resolveDevinModel(routeId: string, table: readonly { id: string; devinModel: string }[]): string {
  const entry = table.find((m) => m.id === routeId)
  if (entry) return entry.devinModel
  return routeId === 'default' ? '' : routeId
}

/** Last user text, for cheap local session titles. */
function lastUserText(messages: readonly RequestMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!
    if (message.role === 'user') {
      const text = blocksToText(message.content).replace(/\s+/g, ' ').trim()
      if (text) return text
    }
  }
  return 'Devin session'
}

/**
 * The provider-wire adapter. Duck-typed against the documented LlmAdapter
 * surface — the registry validates behavior, not inheritance — so this class
 * carries no runtime import of @deepseek-ai/dsh-llm.
 */
class DevinLlmAdapter {
  constructor(
    private readonly ctx: Context,
    private readonly config: Config,
  ) {}

  providerInfo(provider: string): { id: string; name: string } {
    return { id: provider, name: 'Devin' }
  }

  providerRetryPolicy(_provider: string): undefined {
    return undefined
  }

  imageRequestPricing(_provider: string, _model: string): undefined {
    return undefined
  }

  private discovered: { at: number; result: DiscoveryResult } | undefined

  /** Probe `devin acp` for the real catalog (cached); null on failure/disabled. */
  private async discover(): Promise<DiscoveryResult | null> {
    if (!this.config.autoDiscoverModels.get()) return null
    const cacheMs = this.config.discoveryCacheMs.get()
    if (this.discovered && Date.now() - this.discovered.at < cacheMs) return this.discovered.result
    try {
      const result = await discoverModelsViaAcp(this.ctx, {
        devinPath: this.config.devinPath.get(),
        env: this.config.forwardEnv.get(),
        cwd: this.config.cwd.get() || process.cwd(),
        timeoutMs: this.config.discoveryTimeoutMs.get(),
        stderrMaxBytes: this.config.stderrMaxBytes.get(),
      })
      if (result) this.discovered = { at: Date.now(), result }
      return result
    } catch {
      return null
    }
  }

  async listModels(provider: string): Promise<LlmModelInfo[]> {
    const discovered = await this.discover()
    if (discovered && discovered.models.length > 0) {
      const currentId = discovered.currentId
      return [
        {
          provider,
          id: 'default',
          name: 'Devin (account default)',
          description: currentId ? `Resolves to the session default (${currentId})` : 'Devin CLI agent, spawned headless per generation',
          inputModalities: ['text' as const],
        },
        ...discovered.models.map((m) => ({
          provider,
          id: m.id,
          name: m.name,
          description: m.description ?? 'Devin CLI agent, spawned headless per generation',
          inputModalities: ['text' as const] as readonly ('text')[],
        })),
      ]
    }
    return this.config.models.get().map((entry) => ({
      provider,
      id: entry.id,
      name: entry.name || `Devin ${entry.id}`,
      description: 'Devin CLI agent, spawned headless per generation',
      inputModalities: ['text' as const],
    }))
  }

  resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider,
      id: model,
      name: `Devin ${model}`,
      inputModalities: ['text' as const],
    })
  }

  async prepareCall(provider: string, model: string, signal?: AbortSignal) {
    return {
      model: await this.resolveModel(provider, model, signal),
      stream: (options: GenerateOptions) => this.stream(options),
    }
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    // Cheap path: session-title generations are short text requests — spending a
    // whole Devin agent run on them would burn credits for a one-line answer.
    if (options.purpose === 'session-title' && this.config.localSessionTitles.get()) {
      const text = lastUserText(options.messages).slice(0, 80)
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }

    const env = forwardedEnv(this.config.forwardEnv.get())
    const executable = await this.ctx.subprocess.resolveExecutable(this.config.devinPath.get(), env, options.signal)

    const timeout = AbortSignal.timeout(this.config.timeoutMs.get())
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout

    const prompt = buildPrompt(options, this.config.brief.get())
    const argv = [
      executable,
      ...devinPrintArgv({
        model: resolveDevinModel(options.model, this.config.models.get()),
        permissionMode: this.config.permissionMode.get(),
        cloud: this.config.cloud.get(),
        respectWorkspaceTrust: this.config.respectWorkspaceTrust.get(),
        extraArgs: this.config.extraArgs.get(),
      }, prompt),
    ]

    const handle = this.ctx.subprocess.spawn({
      argv,
      cwd: this.config.cwd.get() || process.cwd(),
      stdio: {
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: { maxBytes: this.config.stderrMaxBytes.get() },
      },
      graceMs: 10_000,
      signal,
      env,
    })

    let text = ''
    yield { type: 'block-start', index: 0, blockType: 'text' }
    const stdout = handle.stdout as AsyncIterable<Uint8Array> | undefined
    if (stdout) {
      for await (const chunk of stdout) {
        const piece = new TextDecoder().decode(chunk)
        text += piece
        yield { type: 'text-delta', index: 0, text: piece }
      }
    }

    const outcome = await handle.done
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield {
      type: 'usage',
      usage: {
        inputTokens: Math.ceil(prompt.length / 4),
        outputTokens: Math.ceil(text.length / 4),
      },
    }

    if (timeout.aborted) {
      yield {
        type: 'finish',
        reason: {
          kind: 'error',
          failure: { code: 'DEVIN_TIMEOUT', message: `devin exceeded timeoutMs=${this.config.timeoutMs.get()} and was terminated` },
        },
      }
    } else if (outcome.exitCode !== 0) {
      const stderr = handle.collected.stderr?.readFrom(0)?.text ?? ''
      yield {
        type: 'finish',
        reason: {
          kind: 'error',
          failure: {
            code: 'DEVIN_EXIT',
            message: `devin exited ${outcome.exitCode ?? `signal ${outcome.signal}`}${stderr ? ` — ${stderr.slice(-400)}` : ''}`,
          },
        },
      }
    } else {
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
}

/**
 * Plugin body: register the `devin` provider route and declare it in the
 * configurable-provider directory so the web Models page can see it.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.llm.registerAdapter(['devin'], new DevinLlmAdapter(ctx, config))
  ctx.llm.registerConfigurableProviders([{
    provider: 'devin',
    displayName: 'Devin',
    settingsNs: name,
    settingsPath: [],
  }])
}
