/**
 * ACP model discovery for dsh-plugin-devin/provider.
 *
 * Spawns `devin acp` via {@link connectAcp} (initialize + session/new over
 * newline-delimited JSON-RPC, with lazy authenticate) and reads the advertised
 * `configOptions` — the entry with `category: 'model'` carries the account's
 * real model catalog. Result is cached in-process; failures return null so
 * callers can fall back to the static config table.
 *
 * @module dsh-plugin-devin/discover
 */

import type { Context } from '@deepseek-ai/cordis'
import { connectAcp } from './acp.ts'

/** One advertised model discovered over ACP. */
export interface DiscoveredModel {
  id: string
  name: string
  description?: string | undefined
  /** `cognition.ai/supportsImages` capability flag, when the catalog declares it. */
  supportsImages?: boolean | undefined
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
  _meta?: Record<string, unknown>
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

function supportsImages(opt: AcpSelectOption): boolean | undefined {
  const flag = opt._meta?.['cognition.ai/supportsImages']
  return typeof flag === 'boolean' ? flag : undefined
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
        supportsImages: supportsImages(item),
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
  const conn = await connectAcp(ctx, {
    devinPath: opts.devinPath,
    env: opts.env,
    cwd: opts.cwd,
    timeoutMs: opts.timeoutMs,
    stderrMaxBytes: opts.stderrMaxBytes,
    signal: opts.signal,
  })
  try {
    return modelsFromSessionNew(conn.sessionResult)
  } finally {
    await conn.close()
  }
}
