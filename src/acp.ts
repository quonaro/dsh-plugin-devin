/**
 * ACP stdio transport for dsh-plugin-devin/provider.
 *
 * Generation rides `devin acp` — the Agent Client Protocol server — instead of
 * `devin -p`: `session/prompt` accepts native image content blocks, so attached
 * images reach the model as pixels rather than `[image]` placeholders, and
 * `session/update` notifications stream real text, reasoning, and token usage.
 *
 * Lifetime model (mirroring acp2api's session manager): one `devin acp`
 * process is a connection serving many ACP sessions; a harness conversation
 * (`GenerateOptions.sessionId`) maps to one session, so a turn only sends the
 * messages the session has not seen yet. A session the agent just created gets
 * the whole transcript — it holds no history of its own — while a recycled one
 * must never be replayed into. ACP v1 cannot delete a session, so the process
 * is the unit the idle reaper reclaims.
 *
 * Auth: the server refuses local CLI credentials by design. `authenticate`
 * runs eagerly when the agent advertises auth methods (Devin does), with the
 * key from the forwarded env or the `devin auth login` credentials store;
 * `session/new` falls back to a lazy authenticate when a server demands it
 * without advertising.
 *
 * @module dsh-plugin-devin/acp
 */

import type { Context } from '@deepseek-ai/cordis'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { forwardedEnv, type SubprocessLike } from './shared.ts'

/** Spawned-child handle shape, narrowed from {@link SubprocessLike.spawn}. */
type SubprocessHandle = ReturnType<SubprocessLike['spawn']>

/* ---- newline-delimited JSON-RPC peer over ctx.subprocess pipes ---- */

interface JsonRpcMessage {
  jsonrpc: string
  id?: number
  result?: unknown
  error?: { code: number; message: string }
  method?: string
  params?: unknown
}

export class AcpError extends Error {
  constructor(
    message: string,
    readonly code?: number,
  ) {
    super(message)
    this.name = 'AcpError'
  }
}

/**
 * One ndjson JSON-RPC peer bound to a spawned `devin acp` child.
 * Agent→client requests (method + id) go to {@link onRequest}; notifications
 * (method, no id) go to {@link onNotification}. When the child exits, every
 * in-flight request rejects, and later ones reject immediately.
 */
export class JsonRpcPeer {
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  private buffer = ''
  private nextId = 1
  private dead: Error | undefined

  /** Handle one agent→client request; must write a result or error for msg.id. */
  onRequest: ((msg: { id: number; method: string; params: unknown }) => void) | undefined
  /** Handle one agent→client notification. */
  onNotification: ((method: string, params: unknown) => void) | undefined

  constructor(private readonly handle: SubprocessHandle) {
    const stdout = handle.stdout as NodeJS.ReadableStream | undefined
    stdout?.on('data', (chunk: Buffer | string) => this.feed(chunk.toString()))
    void handle.done.then((outcome) => {
      this.failAll(new AcpError(`devin acp exited early (code ${outcome.exitCode ?? `signal ${outcome.signal}`})`))
    })
  }

  private feed(chunk: string): void {
    this.buffer += chunk
    let idx: number
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx)
      this.buffer = this.buffer.slice(idx + 1)
      if (!line.trim()) continue
      let msg: JsonRpcMessage
      try {
        msg = JSON.parse(line) as JsonRpcMessage
      } catch {
        continue
      }
      this.dispatch(msg)
    }
  }

  private dispatch(msg: JsonRpcMessage): void {
    if (msg.id !== undefined && msg.method === undefined) {
      const p = this.pending.get(msg.id)
      if (!p) return
      this.pending.delete(msg.id)
      if (msg.error) p.reject(new AcpError(msg.error.message, msg.error.code))
      else p.resolve(msg.result)
    } else if (msg.method !== undefined && msg.id !== undefined) {
      this.onRequest?.({ id: msg.id, method: msg.method, params: msg.params })
    } else if (msg.method !== undefined) {
      this.onNotification?.(msg.method, msg.params)
    }
  }

  private failAll(err: Error): void {
    this.dead ??= err
    for (const p of this.pending.values()) p.reject(this.dead)
    this.pending.clear()
  }

  /** Write one JSON-RPC request and await its response. Rejects at once when the child is gone or `signal` fires. */
  request(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    const stdin = this.handle.stdin
    if (this.dead) return Promise.reject(this.dead)
    if (!stdin) return Promise.reject(new AcpError('devin acp stdin is not piped'))
    if (signal?.aborted) return Promise.reject(new AcpError('request aborted'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        if (this.pending.delete(id)) reject(new AcpError('request aborted'))
      }
      this.pending.set(id, {
        resolve: (v) => { signal?.removeEventListener('abort', onAbort); resolve(v) },
        reject: (e) => { signal?.removeEventListener('abort', onAbort); reject(e) },
      })
      signal?.addEventListener('abort', onAbort, { once: true })
      stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    })
  }

  /** Write one JSON-RPC notification (no response expected). */
  notify(method: string, params: unknown): void {
    this.handle.stdin?.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n')
  }

  /** Answer one agent→client request with a result payload. */
  respond(id: number, result: unknown): void {
    this.handle.stdin?.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n')
  }

  /** Answer one agent→client request with a JSON-RPC error. */
  respondError(id: number, code: number, message: string): void {
    this.handle.stdin?.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n')
  }
}

/* ---- credentials ---- */

/**
 * Resolve the API key the ACP server expects in `authenticate`'s `_meta.api_key`.
 * Order: forwarded env, process env, then the credentials store written by
 * `devin auth login` (TOML parsed by regex — no dependency).
 */
export function resolveDevinApiKey(env: Readonly<Record<string, string>>): string | undefined {
  const key = env.WINDSURF_API_KEY ?? process.env.WINDSURF_API_KEY
  if (key) return key
  try {
    const toml = readFileSync(join(env.HOME ?? homedir(), '.local/share/devin/credentials.toml'), 'utf8')
    return /windsurf_api_key\s*=\s*"([^"]+)"/.exec(toml)?.[1]
  } catch {
    return undefined
  }
}

/* ---- agent process lifecycle ---- */

export interface AcpSpawnOptions {
  devinPath: string
  env: readonly string[]
  cwd: string
  extraArgs?: readonly string[] | undefined
  stderrMaxBytes?: number | undefined
  signal?: AbortSignal | undefined
}

/** One live `devin acp` process after the initialize handshake (and auth, when advertised). */
export interface AcpAgent {
  readonly peer: JsonRpcPeer
  /** Raw initialize result — agentCapabilities, authMethods, agentInfo. */
  readonly initResult: unknown
  readonly handle: SubprocessHandle
  close(): Promise<void>
}

function isAuthRequired(err: unknown): boolean {
  return err instanceof AcpError && (err.code === -32000 || /not authenticated|authenticate/i.test(err.message))
}

/**
 * Spawn `devin acp` and run the initialize handshake. `authenticate` is called
 * eagerly when the agent advertises auth methods and a key resolves — the
 * Devin CLI refuses `session/new` until it is called, even when the CLI itself
 * is already logged in. The process carries no timeout: lifetime is owned by
 * the caller (pool or one-shot close()).
 */
export async function spawnAcp(ctx: Context, opts: AcpSpawnOptions): Promise<AcpAgent> {
  const env = forwardedEnv(opts.env)
  const executable = await ctx.subprocess.resolveExecutable(opts.devinPath, env, opts.signal)

  const argv = [executable, 'acp']
  if (opts.extraArgs) argv.push(...opts.extraArgs)

  const handle = ctx.subprocess.spawn({
    argv,
    cwd: opts.cwd,
    stdio: {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: { maxBytes: opts.stderrMaxBytes ?? 65_536 },
    },
    graceMs: 5_000,
    ...(opts.signal ? { signal: opts.signal } : {}),
    env,
  })

  const peer = new JsonRpcPeer(handle)
  const close = async () => {
    handle.terminate()
    await handle.waitForExit(AbortSignal.timeout(6_000)).catch(() => false)
  }

  // The handshake is bounded separately from the process kill-switch: a pooled
  // agent must not die on an arbitrary timer, but a wedged initialize must not
  // block callers forever either.
  const initSignal = opts.signal
    ? AbortSignal.any([opts.signal, AbortSignal.timeout(30_000)])
    : AbortSignal.timeout(30_000)

  try {
    const initResult = await peer.request('initialize', {
      protocolVersion: 1,
      clientInfo: { name: '@quonaro/dsh-plugin-devin', version: '0.1.0' },
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    }, initSignal)

    const authMethods = (initResult as { authMethods?: unknown[] } | null)?.authMethods
    if (Array.isArray(authMethods) && authMethods.length > 0) {
      const key = resolveDevinApiKey(env)
      if (key) {
        await peer.request('authenticate', { methodId: 'devin-browser', _meta: { api_key: key } }, initSignal)
      }
    }
    return { peer, initResult, handle, close }
  } catch (err) {
    await close()
    throw err
  }
}

/**
 * Open one session on an agent. Lazy-authenticates and retries once when the
 * server demands auth despite having advertised none (or the earlier attempt
 * found no key).
 */
export async function acpSessionNew(agent: AcpAgent, env: readonly string[], cwd: string, signal?: AbortSignal): Promise<unknown> {
  const params = { cwd, mcpServers: [] }
  try {
    return await agent.peer.request('session/new', params, signal)
  } catch (err) {
    if (!isAuthRequired(err)) throw err
    const key = resolveDevinApiKey(forwardedEnv(env))
    if (!key) throw err
    await agent.peer.request('authenticate', { methodId: 'devin-browser', _meta: { api_key: key } }, signal)
    return await agent.peer.request('session/new', params, signal)
  }
}

/* ---- one-shot connection (used by model discovery) ---- */

export interface AcpConnection {
  readonly agent: AcpAgent
  readonly sessionId: string
  /** Raw session/new result — carries modes and configOptions. */
  readonly sessionResult: unknown
  close(): Promise<void>
}

/**
 * Spawn an agent, open one session, and hand both back. For one-shot probes
 * like discovery — generation goes through {@link AcpPool} instead.
 */
export async function connectAcp(
  ctx: Context,
  opts: AcpSpawnOptions & { timeoutMs: number },
): Promise<AcpConnection> {
  const timeout = AbortSignal.timeout(opts.timeoutMs)
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout
  const agent = await spawnAcp(ctx, { ...opts, signal })
  try {
    const sessionResult = await acpSessionNew(agent, opts.env, opts.cwd, signal)
    const sessionId = (sessionResult as { sessionId?: string } | null)?.sessionId
    if (!sessionId) throw new AcpError('devin acp session/new returned no sessionId')
    return { agent, sessionId, sessionResult, close: agent.close }
  } catch (err) {
    await agent.close()
    throw err
  }
}

/* ---- prompt events ---- */

/** Events a session/prompt run produces, in arrival order. */
export type AcpPromptEvent =
  | { kind: 'text'; text: string }
  | { kind: 'thought'; text: string }
  | { kind: 'usage'; usage: { inputTokens?: number | undefined; outputTokens?: number | undefined; totalTokens?: number | undefined; cacheReadTokens?: number | undefined } }
  | { kind: 'done'; stopReason?: string | undefined }

interface AcpContentBlock {
  type: string
  text?: string
  data?: string
  mimeType?: string
  name?: string
  uri?: string
}

interface AcpSessionUpdate {
  sessionUpdate?: string
  content?: AcpContentBlock | AcpContentBlock[]
  used?: number
  _meta?: Record<string, unknown>
}

function metaNumber(meta: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = meta?.[`cognition.ai/${key}`] ?? meta?.[key]
  return typeof value === 'number' ? value : undefined
}

function chunkTexts(content: AcpSessionUpdate['content']): string[] {
  const blocks = Array.isArray(content) ? content : content ? [content] : []
  return blocks.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text!)
}

/** Simple push-queue bridging stdout callbacks into the async generator. */
function eventQueue<T>() {
  const items: T[] = []
  let waiter: (() => void) | undefined
  let closed = false
  return {
    push(item: T) { items.push(item); waiter?.() },
    close() { closed = true; waiter?.() },
    async *[Symbol.asyncIterator](): AsyncGenerator<T> {
      for (;;) {
        while (items.length) yield items.shift()!
        if (closed) return
        await new Promise<void>((resolve) => { waiter = resolve })
        waiter = undefined
      }
    },
  }
}

/** Mode ids Devin's ACP sessions understand, mapped from the plugin's flag vocabulary. */
const ACP_MODE: Record<string, string | undefined> = {
  'accept-edits': 'accept-edits',
  smart: 'smart',
  bypass: 'bypass',
  autonomous: 'bypass',
  // 'normal' has no ACP counterpart; leave the session default.
}

function advertisedModeIds(sessionResult: unknown): string[] {
  const modes = (sessionResult as { modes?: { availableModes?: { id?: string }[] } } | null)?.modes?.availableModes
  return (modes ?? []).map((m) => m.id).filter((id): id is string => typeof id === 'string')
}

interface AcpConfigOptionShape {
  id?: string
  category?: string
  options?: { value?: unknown }[]
}

/** The model select option advertised by session/new, when one exists. */
function modelOption(sessionResult: unknown): AcpConfigOptionShape | undefined {
  const options = (sessionResult as { configOptions?: AcpConfigOptionShape[] } | null)?.configOptions
  return (options ?? []).find((o) => o.category === 'model' || (o.id !== 'mode' && (o.id ?? '').includes('model')))
}

/**
 * Choose the permission option a headless client can reasonably grant: prefer
 * allow-once, then any allow, then the first option. Returns the outcome
 * payload for `session/request_permission`.
 */
export function permissionOutcome(params: unknown): unknown {
  const options = (params as { options?: { optionId?: string; kind?: string }[] } | null)?.options ?? []
  const pick =
    options.find((o) => o.kind === 'allow_once') ??
    options.find((o) => typeof o.kind === 'string' && o.kind.startsWith('allow')) ??
    options[0]
  return pick?.optionId
    ? { outcome: { outcome: 'selected', optionId: pick.optionId } }
    : { outcome: { outcome: 'cancelled' } }
}

/* ---- pool: one agent process, many sessions ---- */

/** One conversation's session on a pooled connection. */
interface SessionState {
  /** ACP session id. */
  id: string
  /** Devin model currently selected ('' = session default). */
  model: string
  /** How many transcript messages the agent has already been sent. */
  sentCount: number
  lastUsed: number
  /** Single-flight chain: one turn at a time per session. */
  busy: Promise<void>
  release: (() => void) | undefined
  /** Per-turn agent→client request handler (permission, fs, terminal). */
  onRequest?: ((msg: { id: number; method: string; params: unknown }) => void) | undefined
  /** Per-turn session/update sink. */
  onUpdate?: ((update: AcpSessionUpdate | undefined) => void) | undefined
}

/** One pooled `devin acp` process and every session living on it. */
interface PooledConnection {
  agent: AcpAgent
  key: string
  closed: boolean
  lastUsed: number
  /** Serializes session/new so concurrent first-turns cannot orphan a session. */
  createChain: Promise<unknown>
  /** acp sessionId → state (routing key for agent notifications). */
  sessions: Map<string, SessionState>
  /** harness conversation key → state (stable session across calls). */
  conversations: Map<string, SessionState>
  /** Model configOption captured from the first session/new, for validation. */
  catalog: AcpConfigOptionShape | undefined
}

export interface PoolSessionOptions {
  /** Connection key parts — also the spawn spec when a new process is needed. */
  spawn: AcpSpawnOptions
  /** Harness conversation id (GenerateOptions.sessionId); '' = ephemeral session. */
  conversationKey: string
  /** Devin model value ('' = session default). */
  model: string
  permissionMode?: string | undefined
  /** Total transcript message count of the incoming request. */
  totalMessages: number
  signal?: AbortSignal | undefined
}

/** A conversation's session view: what the caller needs to compose the turn. */
export interface PoolSession {
  /** ACP session id. */
  id: string
  /**
   * Messages already sent to this session. `created` sessions always report 0
   * (send the whole transcript); reused ones report the previous total, so the
   * caller sends `messages.slice(sentCount)`.
   */
  sentCount: number
  /** True when the agent just created this session and holds no history. */
  created: boolean
}

export interface PoolTurnOptions {
  /**
   * Content blocks for this turn, built lazily once the session's previous
   * turn finishes. Evaluating the prompt at send time lets a queued turn slice
   * off whatever the earlier turn already sent — building it upfront would
   * duplicate history the session received while this turn waited.
   */
  prompt: () => readonly unknown[] | Promise<readonly unknown[]>
  /** Total transcript message count; recorded as sent once the prompt is written. */
  totalMessages: number
  signal?: AbortSignal | undefined
}

function connKey(spawn: AcpSpawnOptions): string {
  return [spawn.devinPath, spawn.cwd, spawn.env.join(''), (spawn.extraArgs ?? []).join('')].join(' ')
}

/**
 * Pool of `devin acp` processes and their sessions.
 *
 * Keying mirrors acp2api's session manager: a connection is one process per
 * spawn spec; an ACP session is what a harness conversation maps to. A fresh
 * session must get the whole transcript (it holds no history); a reused one
 * gets only the unsent tail. ACP v1 cannot delete a session, so {@link reap}
 * drops idle session indexes and only reclaims processes.
 */
export class AcpPool {
  private readonly conns = new Map<string, Promise<PooledConnection>>()
  private readonly connChains = new Map<string, Promise<unknown>>()

  constructor(private readonly ctx: Context) {}

  /** Live connection for one spawn spec, starting a process when absent/dead. */
  private async connection(spawn: AcpSpawnOptions): Promise<PooledConnection> {
    const key = connKey(spawn)

    // Serialize per key so two concurrent calls cannot spawn two agents.
    const prev = this.connChains.get(key) ?? Promise.resolve()
    let release: () => void = () => {}
    this.connChains.set(key, prev.then(() => new Promise<void>((r) => { release = r })))
    await prev.catch(() => {})

    try {
      const existing = this.conns.get(key)
      if (existing) {
        const conn = await existing.catch(() => undefined)
        if (conn && !conn.closed) return conn
        this.conns.delete(key)
      }

      const pending = (async (): Promise<PooledConnection> => {
        const agent = await spawnAcp(this.ctx, spawn)
        const conn: PooledConnection = {
          agent,
          key,
          closed: false,
          lastUsed: Date.now(),
          createChain: Promise.resolve(),
          sessions: new Map(),
          conversations: new Map(),
          catalog: undefined,
        }
        agent.peer.onRequest = (msg) => this.dispatchRequest(conn, msg)
        agent.peer.onNotification = (method, params) => this.dispatchNotification(conn, method, params)
        void agent.handle.done.then(() => {
          conn.closed = true
          conn.sessions.clear()
          conn.conversations.clear()
        })
        return conn
      })()

      this.conns.set(key, pending)
      try {
        return await pending
      } catch (err) {
        this.conns.delete(key)
        throw err
      }
    } finally {
      release()
    }
  }

  /** Route one agent→client request to the owning session's handler. */
  private dispatchRequest(conn: PooledConnection, msg: { id: number; method: string; params: unknown }): void {
    const sessionId = (msg.params as { sessionId?: string } | null)?.sessionId
    const st = sessionId ? conn.sessions.get(sessionId) : undefined
    if (st?.onRequest) {
      st.onRequest(msg)
      return
    }
    if (msg.method === 'session/request_permission') {
      conn.agent.peer.respond(msg.id, permissionOutcome(msg.params))
    } else {
      conn.agent.peer.respondError(msg.id, -32601, `not supported by dsh-plugin-devin: ${msg.method}`)
    }
  }

  private dispatchNotification(conn: PooledConnection, method: string, params: unknown): void {
    if (method !== 'session/update') return
    const sessionId = (params as { sessionId?: string } | null)?.sessionId
    const st = sessionId ? conn.sessions.get(sessionId) : undefined
    st?.onUpdate?.((params as { update?: AcpSessionUpdate }).update)
  }

  /**
   * Resolve the session for one conversation, creating it when absent or
   * stale. `created` tells the caller the agent holds no history and the turn
   * must carry the whole transcript; a reused session gets only the tail
   * after `sentCount`.
   */
  async session(opts: PoolSessionOptions): Promise<{ conn: PooledConnection; st: SessionState; session: PoolSession }> {
    const conn = await this.connection(opts.spawn)
    const convKey = opts.conversationKey

    const lookup = (): SessionState | undefined => {
      if (!convKey) return undefined
      const existing = conn.conversations.get(convKey)
      // Strictly fewer sent than the new total means an unsent tail exists;
      // equal-or-more means the history was rewritten (compaction, retry) and
      // this session is stale — abandon it; ACP v1 cannot delete it anyway.
      if (existing && existing.sentCount < opts.totalMessages) {
        existing.lastUsed = Date.now()
        return existing
      }
      if (existing) conn.conversations.delete(convKey)
      return undefined
    }

    let existing = lookup()
    if (!existing) {
      // Serialize creation per connection — a lost race would orphan a session.
      const prev = conn.createChain
      let release: () => void = () => {}
      conn.createChain = prev.then(() => new Promise<void>((r) => { release = r }))
      await prev.catch(() => {})
      try {
        existing = lookup()
        if (!existing) {
          existing = await this.newSession(conn, opts)
        }
      } finally {
        release()
      }
    }

    await this.applyModel(conn, existing, opts.model, opts.signal)
    return { conn, st: existing, session: { id: existing.id, sentCount: existing.sentCount, created: existing.sentCount === 0 } }
  }

  private async newSession(conn: PooledConnection, opts: PoolSessionOptions): Promise<SessionState> {
    const sessionResult = await acpSessionNew(conn.agent, opts.spawn.env, opts.spawn.cwd, opts.signal)
    conn.catalog ??= modelOption(sessionResult)
    const sessionId = (sessionResult as { sessionId?: string } | null)?.sessionId
    if (!sessionId) throw new AcpError('devin acp session/new returned no sessionId')

    const st: SessionState = {
      id: sessionId,
      model: '',
      sentCount: 0,
      lastUsed: Date.now(),
      busy: Promise.resolve(),
      release: undefined,
    }
    conn.sessions.set(sessionId, st)
    if (opts.conversationKey) conn.conversations.set(opts.conversationKey, st)
    conn.lastUsed = Date.now()

    const modeId = opts.permissionMode ? ACP_MODE[opts.permissionMode] : undefined
    if (modeId && advertisedModeIds(sessionResult).includes(modeId)) {
      // Best-effort and bounded: a server ignoring set_mode must not stall the turn.
      await Promise.race([
        conn.agent.peer.request('session/set_mode', { sessionId, modeId }, opts.signal).catch(() => undefined),
        new Promise<void>((resolve) => setTimeout(resolve, 5_000).unref()),
      ])
    }
    return st
  }

  /**
   * Apply the requested Devin model through session/set_config_option. An
   * unknown value fails when the catalog is known — silently running the
   * wrong model answers a question nobody asked.
   */
  private async applyModel(
    conn: PooledConnection,
    st: SessionState,
    model: string,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!model || model === st.model) return
    const option = conn.catalog
    if (option?.options?.length && !option.options.some((o) => o.value === model)) {
      throw new AcpError(`devin does not offer model '${model}'`, -32000)
    }
    if (!option?.id) return
    await conn.agent.peer.request('session/set_config_option', { sessionId: st.id, configId: option.id, value: model }, signal)
      .then(() => { st.model = model })
      .catch(() => undefined) // best-effort: older servers may lack the method
  }

  /**
   * Run one turn on a session: queue behind any in-flight turn, send
   * session/prompt, and yield mapped session/update events until the prompt
   * response arrives. `sentCount` advances once the prompt is written — an
   * aborted turn still reached the agent, so resending would duplicate it.
   */
  async *turn(
    entry: { conn: PooledConnection; st: SessionState },
    opts: PoolTurnOptions,
  ): AsyncGenerator<AcpPromptEvent> {
    const { conn, st } = entry

    // Single-flight: a second turn on this session queues behind the first.
    // The release stays local — storing it on the session lets a queued turn
    // overwrite it and leaves the earlier turn's `busy` pending forever.
    const prev = st.busy
    let release: () => void = () => {}
    st.busy = new Promise<void>((resolve) => { release = resolve })
    st.release = release // busy marker for the reaper
    await prev.catch(() => {})

    try {
      yield* this.driveTurn(conn, st, opts)
    } finally {
      st.lastUsed = Date.now()
      conn.lastUsed = Date.now()
      release()
      if (st.release === release) st.release = undefined
    }
  }

  /** The prompt half of {@link turn}: session/prompt + session/update pump. */
  private async *driveTurn(
    conn: PooledConnection,
    st: SessionState,
    opts: PoolTurnOptions,
  ): AsyncGenerator<AcpPromptEvent> {
    const { peer } = conn.agent
    const queue = eventQueue<AcpPromptEvent>()

    st.onRequest = (msg) => {
      if (msg.method === 'session/request_permission') {
        peer.respond(msg.id, permissionOutcome(msg.params))
      } else {
        peer.respondError(msg.id, -32601, `not supported by dsh-plugin-devin: ${msg.method}`)
      }
    }
    st.onUpdate = (update) => {
      switch (update?.sessionUpdate) {
        case 'agent_message_chunk':
          for (const text of chunkTexts(update.content)) queue.push({ kind: 'text', text })
          break
        case 'agent_thought_chunk':
          for (const text of chunkTexts(update.content)) queue.push({ kind: 'thought', text })
          break
        case 'usage_update':
          queue.push({
            kind: 'usage',
            usage: {
              inputTokens: metaNumber(update._meta, 'inputTokens'),
              outputTokens: metaNumber(update._meta, 'outputTokens'),
              totalTokens: update.used,
            },
          })
          break
      }
    }

    let promptError: unknown
    const onAbort = () => {
      peer.notify('session/cancel', { sessionId: st.id })
      promptError ??= new AcpError('turn aborted')
      queue.close()
    }
    opts.signal?.addEventListener('abort', onAbort, { once: true })

    try {
      const prompt = await opts.prompt()
      const request = peer.request('session/prompt', { sessionId: st.id, prompt }, opts.signal)
      st.sentCount = opts.totalMessages
      request
        .then((result) => {
          const r = result as {
            stopReason?: string
            usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number; cachedReadTokens?: number }
          } | undefined
          if (r?.usage) {
            queue.push({
              kind: 'usage',
              usage: {
                inputTokens: r.usage.inputTokens,
                outputTokens: r.usage.outputTokens,
                totalTokens: r.usage.totalTokens,
                cacheReadTokens: r.usage.cachedReadTokens,
              },
            })
          }
          queue.push({ kind: 'done', stopReason: r?.stopReason })
        })
        .catch((err: unknown) => { promptError ??= err })
        .finally(() => queue.close())

      for await (const event of queue) yield event
      if (promptError) throw promptError
    } finally {
      opts.signal?.removeEventListener('abort', onAbort)
      st.onRequest = undefined
      st.onUpdate = undefined
    }
  }

  /**
   * Drop idle session indexes and reclaim idle processes. Sessions cannot be
   * deleted over ACP v1, so expiry only forgets them locally — the next call
   * creates a fresh session and replays.
   */
  reap(idleMs: number): void {
    const now = Date.now()
    for (const conn of this.conns.values()) {
      void conn.then((c) => {
        if (c.closed) return
        for (const [sid, st] of c.sessions) {
          if (!st.release && now - st.lastUsed > idleMs) {
            c.sessions.delete(sid)
            for (const [key, s] of c.conversations) {
              if (s === st) c.conversations.delete(key)
            }
          }
        }
        if (c.sessions.size === 0 && now - c.lastUsed > idleMs) {
          c.closed = true
          void c.agent.close()
          for (const [key, p] of this.conns) {
            if (p === conn) this.conns.delete(key)
          }
        }
      }).catch(() => {})
    }
  }

  /** Terminate every pooled process. Idempotent. */
  async close(): Promise<void> {
    const conns = [...this.conns.values()]
    this.conns.clear()
    for (const pending of conns) {
      const conn = await pending.catch(() => undefined)
      if (conn) {
        conn.closed = true
        await conn.agent.close()
      }
    }
  }
}
