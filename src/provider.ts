/**
 * @quonaro/dsh-plugin-devin/provider — expose the Devin CLI as an LLM provider route.
 *
 * Registers provider `devin` with `ctx.llm.registerAdapter`, so it appears
 * alongside ordinary model providers (Settings → Models, `/model`, agent
 * presets). Generation rides `devin acp` through a pooled connection: one ACP
 * process serves many sessions, a harness conversation (GenerateOptions
 * .sessionId) maps to one persistent session, a fresh session receives the
 * whole transcript (native image blocks included), and a reused one receives
 * only the unsent tail. `transport: 'print'` falls back to the original
 * `devin -p` text-only path.
 *
 * Semantics worth knowing before enabling: Devin is an agent, not a model.
 * Every call is a complete headless Devin session — it runs its own tool
 * loop internally and cannot invoke this harness's tools. Use it to hand
 * whole tasks to Devin; per-token latency is minutes, not milliseconds.
 *
 * @module @quonaro/dsh-plugin-devin/provider
 */

import type { Context, Volatile } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import type {
  ContentBlock,
  FinishReason,
  GenerateOptions,
  TokenUsage,
  ImageBlock,
  LlmModelInfo,
  LlmResolvedModelInfo,
  RequestMessage,
  StreamChunk,
  ToolSchema,
} from '@deepseek-ai/dsh-llm'
import { readFile } from 'node:fs/promises'
import { devinPrintArgv, forwardedEnv } from './shared.ts'
import { AcpPool } from './acp.ts'
import { discoverModelsViaAcp, type DiscoveryResult } from './discover.ts'

// Re-exported so the inferred Config type can name Dict in the emitted .d.ts (TS2883).
export type { Dict } from '@deepseek-ai/cosmokit'

/** Plugin name; the cordis.patch.yml row uses the `@quonaro/dsh-plugin-devin/provider` specifier. */
export const name = '@quonaro/dsh-plugin-devin/provider'

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
  /**
   * Generation transport: 'acp' speaks `devin acp` (native image blocks, real
   * token usage, streamed reasoning); 'print' spawns `devin -p` (text only —
   * images degrade to `[image]` placeholders). `cloud` and
   * `respectWorkspaceTrust` only apply to 'print'.
   */
  transport: Volatile<'acp' | 'print'>
  /** Maximum image occurrences attached to one ACP prompt (most recent win). */
  maxImages: Volatile<number>
  /** Per-image byte cap; larger attachments degrade to `[image]` placeholders. */
  maxImageBytes: Volatile<number>
  /** Answer session-title requests locally instead of spending a Devin run on them. */
  localSessionTitles: Volatile<boolean>
  /** Probe `devin acp` for the account's real model catalog instead of using the static `models` table. */
  autoDiscoverModels: Volatile<boolean>
  /** Timeout for one ACP discovery probe (initialize + session/new). */
  discoveryTimeoutMs: Volatile<number>
  /** How long a successful discovery result is cached before re-probing. */
  discoveryCacheMs: Volatile<number>
  /**
   * Idle lifetime for pooled ACP sessions and processes. An expired session is
   * forgotten (the next turn creates one and replays the transcript); an empty
   * expired connection is terminated. 0 disables reaping.
   */
  sessionIdleMs: Volatile<number>
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
  transport: Schema.union(['acp', 'print'] as const).default('acp').volatile(),
  maxImages: Schema.number().default(8).volatile(),
  maxImageBytes: Schema.number().default(5_242_880).volatile(),
  localSessionTitles: Schema.boolean().default(true).volatile(),
  autoDiscoverModels: Schema.boolean().default(true).volatile(),
  discoveryTimeoutMs: Schema.number().default(60_000).volatile(),
  discoveryCacheMs: Schema.number().default(300_000).volatile(),
  sessionIdleMs: Schema.number().default(900_000).volatile(),
})

const ROLE_LABEL: Record<string, string> = {
  system: 'system',
  developer: 'developer',
  user: 'user',
  assistant: 'assistant',
  tool: 'tool result',
}

/** Project one message's blocks into transcript text. `imageLabel` customizes image placeholders (ACP transport numbers attached images). */
function blocksToText(blocks: readonly ContentBlock[], imageLabel?: (block: ImageBlock) => string): string {
  return blocks.map((block) => {
    switch (block.type) {
      case 'text': return block.text
      case 'reasoning': return `<thinking>\n${block.text}\n</thinking>`
      case 'tool-call': return `[tool call ${block.name} #${block.id}]: ${block.arguments}`
      case 'image': return imageLabel?.(block) ?? '[image]'
      case 'file': return '[file]'
      case 'tool-addition': return `[tool enabled: ${block.toolName}]`
      case 'tool-removal': return `[tool disabled: ${block.toolName}]`
      default: return `[${(block as { type: string }).type}]`
    }
  }).join('\n')
}

/** Flatten one generation request into the prompt handed to `devin -p` / ACP `session/prompt`. */
function buildPrompt(options: GenerateOptions, brief: string, imageLabel?: (block: ImageBlock) => string): string {
  const parts: string[] = [brief, '', '<transcript>']
  if (options.system) parts.push('## system', options.system, '')
  for (const message of options.messages) {
    parts.push(`## ${ROLE_LABEL[message.role] ?? message.role}`, blocksToText(message.content, imageLabel), '')
  }
  parts.push('</transcript>')
  if (options.tools?.length) {
    const names = options.tools.map((tool: ToolSchema) => tool.name).slice(0, 12).join(', ')
    parts.push('', `[note: the caller declared ${options.tools.length} of its own tools (${names}${options.tools.length > 12 ? ', …' : ''}) — you cannot invoke them; complete the work with your own capabilities.]`)
  }
  return parts.join('\n')
}

/**
 * Flatten only the unsent tail of a transcript for a reused ACP session. The
 * session already holds the brief and history, so the tail is role-labeled
 * text — except a lone user message, which reads as a natural continuation.
 */
function buildTailPrompt(tail: readonly RequestMessage[], imageLabel?: (block: ImageBlock) => string): string {
  if (tail.length === 1 && tail[0]!.role === 'user') {
    return blocksToText(tail[0]!.content, imageLabel)
  }
  const parts: string[] = []
  for (const message of tail) {
    parts.push(`## ${ROLE_LABEL[message.role] ?? message.role}`, blocksToText(message.content, imageLabel), '')
  }
  return parts.join('\n').trimEnd()
}

/** Map an advertised route id to its `--model` value; unknown ids pass through verbatim. */
function resolveDevinModel(routeId: string, table: readonly { id: string; devinModel: string }[]): string {
  const entry = table.find((m) => m.id === routeId)
  if (entry) return entry.devinModel
  return routeId === 'default' ? '' : routeId
}

/** Map an ACP session/prompt stopReason onto the provider-neutral finish vocabulary. */
function finishFor(stopReason: string | undefined): FinishReason {
  switch (stopReason) {
    case 'end_turn':
    case 'stop_sequence':
      return { kind: 'stop' }
    case 'max_tokens':
    case 'max_turn_requests':
      return { kind: 'max-tokens' }
    case 'cancelled':
      return { kind: 'aborted', failure: { code: 'DEVIN_CANCELLED', message: 'devin acp cancelled the turn' } }
    case 'refusal':
      return { kind: 'error', failure: { code: 'DEVIN_REFUSAL', message: 'devin refused the prompt' } }
    default:
      return { kind: 'stop' }
  }
}

/** Normalize an ACP usage payload (all fields optional) into the adapter's TokenUsage contract. */
function usageFor(event: { inputTokens?: number | undefined; outputTokens?: number | undefined; totalTokens?: number | undefined; cacheReadTokens?: number | undefined }): TokenUsage {
  return {
    inputTokens: event.inputTokens ?? 0,
    outputTokens: event.outputTokens ?? 0,
    ...(event.totalTokens !== undefined ? { totalTokens: event.totalTokens } : {}),
    ...(event.cacheReadTokens !== undefined ? { cacheReadTokens: event.cacheReadTokens } : {}),
  }
}

/**
 * Prefix the host wraps session-title requests in (`dsh-session-title-llm`
 * `frameMessages`): the actual human messages sit inside a JSON payload.
 */
const TITLE_FRAME_PREFIX = 'Generate the session title from this JSON array of human messages:'

/**
 * Source text for a cheap local session title: the last user message, with the
 * host's title-request JSON framing unwrapped to the first framed human message.
 */
function sessionTitleText(messages: readonly RequestMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!
    if (message.role !== 'user') continue
    const raw = blocksToText(message.content)
    const at = raw.indexOf(TITLE_FRAME_PREFIX)
    if (at === -1) return raw.replace(/\s+/g, ' ').trim() || 'Devin session'
    try {
      const items = JSON.parse(raw.slice(at + TITLE_FRAME_PREFIX.length)) as unknown
      if (Array.isArray(items)) {
        // Host items are `{seq, text}` projections of the eligible human
        // messages; keep `content` blocks as a fallback shape.
        for (const item of items as readonly { text?: unknown; content?: ContentBlock[] }[]) {
          if (!item) continue
          const rawText = typeof item.text === 'string'
            ? item.text
            : Array.isArray(item.content) ? blocksToText(item.content) : ''
          const text = rawText.replace(/\s+/g, ' ').trim()
          if (text) return text
        }
      }
    } catch {
      // Framed payload did not parse — fall back below.
    }
    return 'Devin session'
  }
  return 'Devin session'
}

/**
 * The provider-wire adapter. Duck-typed against the documented LlmAdapter
 * surface — the registry validates behavior, not inheritance — so this class
 * carries no runtime import of @deepseek-ai/dsh-llm.
 */
class DevinLlmAdapter {
  /** Pooled `devin acp` processes; one connection per spawn spec, one ACP session per harness conversation. */
  private readonly pool: AcpPool

  /** Idle reaper — forgets expired session indexes, reclaims empty processes. */
  private readonly reaper: NodeJS.Timeout

  constructor(
    private readonly ctx: Context,
    private readonly config: Config,
  ) {
    this.pool = new AcpPool(ctx)
    this.reaper = setInterval(() => {
      const idleMs = this.config.sessionIdleMs.get()
      if (idleMs > 0) this.pool.reap(idleMs)
    }, 60_000)
    this.reaper.unref()
  }

  /** Terminate pooled agent processes; called when the plugin fiber unloads. */
  async dispose(): Promise<void> {
    clearInterval(this.reaper)
    await this.pool.close()
  }

  providerInfo(provider: string): { id: string; name: string } {
    return { id: provider, name: 'Devin ACP' }
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

  /** Route modalities: the ACP transport feeds image blocks natively; print is text-only. */
  private modalities(): readonly ('text' | 'image')[] {
    return this.config.transport.get() === 'acp' ? ['text', 'image'] : ['text']
  }

  async listModels(provider: string): Promise<LlmModelInfo[]> {
    const inputModalities = this.modalities()
    const discovered = await this.discover()
    if (discovered && discovered.models.length > 0) {
      const currentId = discovered.currentId
      return [
        {
          provider,
          id: 'default',
          name: 'Devin (account default)',
          description: currentId ? `Resolves to the session default (${currentId})` : 'Devin CLI agent, spawned headless per generation',
          inputModalities,
        },
        ...discovered.models.map((m) => ({
          provider,
          id: m.id,
          name: m.name,
          description: m.description ?? 'Devin CLI agent, spawned headless per generation',
          inputModalities,
        })),
      ]
    }
    return this.config.models.get().map((entry) => ({
      provider,
      id: entry.id,
      name: entry.name || `Devin ${entry.id}`,
      description: 'Devin CLI agent, spawned headless per generation',
      inputModalities,
    }))
  }

  resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider,
      id: model,
      name: `Devin ${model}`,
      inputModalities: this.modalities(),
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
      const text = sessionTitleText(options.messages).slice(0, 80)
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }

    yield* this.config.transport.get() === 'acp' ? this.streamAcp(options) : this.streamPrint(options)
  }

  /** Minimal structural face of the host attachment store (ctx.attachments). */
  private attachments(): { imageHostPath(ref: unknown): string | undefined } | undefined {
    try {
      return (this.ctx as unknown as { get?(name: string): unknown }).get?.('attachments') as
        | { imageHostPath(ref: unknown): string | undefined }
        | undefined
    } catch {
      return undefined
    }
  }

  /**
   * Resolve image blocks to ACP image content blocks. The most recent
   * `maxImages` non-offloaded occurrences win; the returned labeler marks each
   * occurrence in the transcript as `[image N]` (attached) or `[image]`.
   */
  private async collectImages(
    messages: readonly RequestMessage[],
  ): Promise<{ blocks: { type: 'image'; data: string; mimeType: string; name?: string }[]; label: (block: ImageBlock) => string }> {
    const labels = new Map<ImageBlock, string>()
    const blocks: { type: 'image'; data: string; mimeType: string; name?: string }[] = []
    const store = this.attachments()
    if (store) {
      const candidates: ImageBlock[] = []
      for (const message of messages) {
        for (const block of message.content) {
          if (block.type === 'image') candidates.push(block)
        }
      }
      // The most recent `maxImages` non-offloaded occurrences get attached.
      const attachable = new Set(candidates.filter((b) => !b.offloaded).slice(-this.config.maxImages.get()))
      const maxBytes = this.config.maxImageBytes.get()
      let next = 0
      for (const block of candidates) {
        // Offloaded occurrences keep placeholder semantics — but Devin is a
        // local agent that can Read files, so name the recovery path.
        if (block.offloaded) {
          try {
            const path = store.imageHostPath(block.attachment)
            if (path) labels.set(block, `[image not attached${block.attachment.name ? `: ${block.attachment.name}` : ''} — read-only copy at ${path}]`)
          } catch { /* plain placeholder */ }
          continue
        }
        if (!attachable.has(block)) continue
        try {
          const path = store.imageHostPath(block.attachment)
          if (!path || block.attachment.bytes > maxBytes) continue
          const data = await readFile(path)
          if (data.byteLength > maxBytes) continue
          next += 1
          labels.set(block, `[image ${next}${block.attachment.name ? `: ${block.attachment.name}` : ''}]`)
          blocks.push({
            type: 'image',
            data: data.toString('base64'),
            mimeType: block.attachment.mediaType,
            ...(block.attachment.name ? { name: block.attachment.name } : {}),
          })
        } catch {
          // Resolution failures degrade to a plain placeholder.
        }
      }
    }
    return { blocks, label: (block) => labels.get(block) ?? '[image]' }
  }

  /**
   * ACP generation over the pooled connection. The conversation session is
   * resolved first: a fresh one receives the whole transcript (brief +
   * `<transcript>` + every image), a reused one only the messages after
   * `sentCount` and their images.
   */
  private async *streamAcp(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const timeout = AbortSignal.timeout(this.config.timeoutMs.get())
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout

    // Compaction/session-title calls must not pollute the conversation's own
    // session, so only a plain generation gets the persistent session key.
    const conversationKey = options.purpose ? '' : String(options.sessionId ?? '')

    // Block indexes: 0 = visible text, 1 = reasoning. Open lazily on first delta.
    let textAcc = ''
    let reasoningAcc = ''
    let textOpen = false
    let reasoningOpen = false

    const closeBlocks = function* (): Generator<StreamChunk> {
      if (textOpen) yield { type: 'block-end', index: 0, block: { type: 'text', text: textAcc } }
      if (reasoningOpen) yield { type: 'block-end', index: 1, block: { type: 'reasoning', text: reasoningAcc } }
    }

    let entry: Awaited<ReturnType<AcpPool['session']>>
    try {
      entry = await this.pool.session({
        spawn: {
          devinPath: this.config.devinPath.get(),
          env: this.config.forwardEnv.get(),
          cwd: this.config.cwd.get() || process.cwd(),
          extraArgs: this.config.extraArgs.get(),
          stderrMaxBytes: this.config.stderrMaxBytes.get(),
        },
        conversationKey,
        model: resolveDevinModel(options.model, this.config.models.get()),
        permissionMode: this.config.permissionMode.get(),
        totalMessages: options.messages.length,
        signal,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      yield {
        type: 'finish',
        reason: {
          kind: 'error',
          failure: {
            code: options.signal?.aborted ? 'DEVIN_ABORTED' : timeout.aborted ? 'DEVIN_TIMEOUT' : 'DEVIN_ACP',
            message,
          },
        },
      }
      return
    }

    // Built lazily at send time: a session nobody has written to gets the
    // whole transcript (brief + <transcript> + every image); a session that
    // already holds history gets only the unsent tail and its images — never
    // a replay, which would duplicate the context the agent keeps.
    const buildPromptNow = async (): Promise<readonly unknown[]> => {
      const sent = entry.st.sentCount
      const tail = sent === 0
        ? options.messages
        : sent < options.messages.length
          ? options.messages.slice(sent)
          : options.messages.slice(-1)
      const { blocks: imageBlocks, label } = await this.collectImages(tail)
      const text = sent === 0
        ? buildPrompt(options, this.config.brief.get(), label)
        : buildTailPrompt(tail, label)
      return [{ type: 'text', text }, ...imageBlocks]
    }

    try {
      for await (const event of this.pool.turn(entry, { prompt: buildPromptNow, totalMessages: options.messages.length, signal })) {
        switch (event.kind) {
          case 'text':
            if (!textOpen) { yield { type: 'block-start', index: 0, blockType: 'text' }; textOpen = true }
            textAcc += event.text
            yield { type: 'text-delta', index: 0, text: event.text }
            break
          case 'thought':
            if (!reasoningOpen) { yield { type: 'block-start', index: 1, blockType: 'reasoning' }; reasoningOpen = true }
            reasoningAcc += event.text
            yield { type: 'reasoning-delta', index: 1, text: event.text }
            break
          case 'usage':
            if (event.usage.inputTokens !== undefined || event.usage.outputTokens !== undefined) {
              yield { type: 'usage', usage: usageFor(event.usage) }
            }
            break
          case 'done':
            yield* closeBlocks()
            yield { type: 'finish', reason: finishFor(event.stopReason) }
            return
        }
      }
      // The generator ended without a 'done' (e.g. child died mid-run).
      yield* closeBlocks()
      yield {
        type: 'finish',
        reason: { kind: 'error', failure: { code: 'DEVIN_ACP_EOF', message: 'devin acp ended the session without a prompt response' } },
      }
    } catch (err) {
      yield* closeBlocks()
      const message = err instanceof Error ? err.message : String(err)
      if (options.signal?.aborted) {
        yield { type: 'finish', reason: { kind: 'aborted', failure: { code: 'DEVIN_ABORTED', message } } }
      } else if (timeout.aborted) {
        yield {
          type: 'finish',
          reason: { kind: 'error', failure: { code: 'DEVIN_TIMEOUT', message: `devin exceeded timeoutMs=${this.config.timeoutMs.get()} and was terminated` } },
        }
      } else {
        yield {
          type: 'finish',
          reason: { kind: 'error', failure: { code: 'DEVIN_ACP', message } },
        }
      }
    }
  }

  /** Print-mode generation: spawn `devin -p` once and stream stdout as one text block. */
  private async *streamPrint(options: GenerateOptions): AsyncIterable<StreamChunk> {
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
  ctx.effect(() => {
    const adapter = new DevinLlmAdapter(ctx, config)
    ctx.llm.registerAdapter(['devin'], adapter)
    ctx.llm.registerConfigurableProviders([{
      provider: 'devin',
      displayName: 'Devin ACP',
      settingsNs: name,
      settingsPath: [],
    }])
    // Disposer runs when the plugin fiber unloads — terminate pooled agents.
    return () => adapter.dispose()
  })
}
