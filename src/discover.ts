/**
 * ACP model discovery for dsh-plugin-devin/provider.
 *
 * Spawns `devin acp`, performs the initialize + session/new handshake over
 * newline-delimited JSON-RPC (the same transport omniacp uses), and reads the
 * advertised `configOptions` — the entry with `category: 'model'` carries the
 * account's real model catalog. Result is cached in-process; failures return
 * null so callers can fall back to the static config table.
 *
 * @module dsh-plugin-devin/discover
 */

import type { Context } from '@deepseek-ai/cordis'
import { forwardedEnv } from './shared.ts'

/** One advertised model discovered over ACP. */
export interface DiscoveredModel {
  id: string
  name: string
  description?: string | undefined
}

/** Result of one successful discovery probe. */
export interface DiscoveryResult {
  models: DiscoveredModel[]
  /** The model id the agent currently has selected (configOption currentValue). */
  currentId?: string | undefined
}

/* ---- configOption vocabulary (mirrors omniacp's useStore extraction) ---- */

interface AcpSelectOption {
  value?: unknown
  name?: string
  label?: string
  description?: string
  options?: AcpSelectOption[]
  group?: string
}

interface AcpConfigOption {
  id: string
  name?: string
  category?: string
  type?: string
  currentValue?: unknown
  options?: AcpSelectOption[]
}

function isModeOption(c: AcpConfigOption): boolean {
  return c.category === 'mode' || c.id === 'mode' || c.id.includes('permission_mode') || c.id.includes('cognition/permission')
}

function isModelOption(c: AcpConfigOption): boolean {
  return c.category === 'model' || (!isModeOption(c) && c.id.includes('model'))
}

/** Flatten a select option's `options` (flat list or grouped sub-lists). */
function flattenOptions(opt: AcpConfigOption | undefined): DiscoveredModel[] {
  const out: DiscoveredModel[] = []
  for (const entry of opt?.options ?? []) {
    const items = Array.isArray(entry.options) ? entry.options : [entry]
    for (const item of items) {
      if (item.value === undefined || item.value === null) continue
      const id = String(item.value)
      out.push({
        id,
        name: item.name ?? item.label ?? id,
        description: item.description,
      })
    }
  }
  return out
}

/** Extract the model catalog from a session/new result. */
export function modelsFromSessionNew(result: unknown): DiscoveryResult | null {
  const configOptions = (result as { configOptions?: AcpConfigOption[] } | null)?.configOptions
  if (!Array.isArray(configOptions)) return null
  const modelOpt = configOptions.find(isModelOption)
  const models = flattenOptions(modelOpt)
  if (models.length === 0) return null
  const currentId = modelOpt?.currentValue === undefined ? undefined : String(modelOpt.currentValue)
  return { models, currentId }
}

/* ---- minimal ndjson JSON-RPC client over ctx.subprocess pipes ---- */

interface JsonRpcResponse {
  jsonrpc: string
  id?: number
  result?: unknown
  error?: { code: number; message: string }
  method?: string
  params?: unknown
}

/**
 * Discover the model catalog by probing `devin acp`.
 * The child is terminated once session/new answers (or the timeout aborts it).
 */
export async function discoverModelsViaAcp(
  ctx: Context,
  opts: {
    devinPath: string
    env: readonly string[]
    cwd: string
    timeoutMs: number
    stderrMaxBytes?: number | undefined
    signal?: AbortSignal | undefined
  },
): Promise<DiscoveryResult | null> {
  const env = forwardedEnv(opts.env)
  const executable = await ctx.subprocess.resolveExecutable(opts.devinPath, env, opts.signal)

  const timeout = AbortSignal.timeout(opts.timeoutMs)
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout

  const handle = ctx.subprocess.spawn({
    argv: [executable, 'acp'],
    cwd: opts.cwd,
    stdio: {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: { maxBytes: opts.stderrMaxBytes ?? 65_536 },
    },
    graceMs: 5_000,
    signal,
    env,
  })

  try {
    const stdin = handle.stdin
    const stdout = handle.stdout as NodeJS.ReadableStream | undefined
    if (!stdin || !stdout) return null

    const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
    let buffer = ''
    let nextId = 1

    // If the child dies mid-handshake, settle every in-flight request.
    void handle.done.then((outcome) => {
      const err = new Error(`devin acp exited early (code ${outcome.exitCode ?? `signal ${outcome.signal}`})`)
      for (const p of pending.values()) p.reject(err)
      pending.clear()
    })

    stdout.on('data', (chunk: Buffer | string) => {
      buffer += chunk.toString()
      let idx: number
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx)
        buffer = buffer.slice(idx + 1)
        if (!line.trim()) continue
        let msg: JsonRpcResponse
        try {
          msg = JSON.parse(line) as JsonRpcResponse
        } catch {
          continue
        }
        if (msg.id !== undefined && msg.method === undefined) {
          const p = pending.get(msg.id)
          if (p) {
            pending.delete(msg.id)
            if (msg.error) p.reject(new Error(`[${msg.error.code}] ${msg.error.message}`))
            else p.resolve(msg.result)
          }
        } else if (msg.method !== undefined && msg.id !== undefined) {
          // Agent → client request (fs/*, permission, …): refuse politely.
          stdin.write(JSON.stringify({
            jsonrpc: '2.0',
            id: msg.id,
            error: { code: -32601, message: 'not supported by dsh-plugin-devin discovery' },
          }) + '\n')
        }
      }
    })

    const request = (method: string, params: unknown): Promise<unknown> =>
      new Promise((resolve, reject) => {
        const id = nextId++
        pending.set(id, { resolve, reject })
        stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
      })

    await request('initialize', {
      protocolVersion: 1,
      clientInfo: { name: 'dsh-plugin-devin', version: '0.1.0' },
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
    })

    const session = await request('session/new', { cwd: opts.cwd, mcpServers: [] })
    return modelsFromSessionNew(session)
  } finally {
    handle.terminate()
    await handle.waitForExit(AbortSignal.timeout(6_000)).catch(() => false)
  }
}
