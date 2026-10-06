/**
 * Shared internals for dsh-plugin-devin entry points: the ctx.subprocess structural
 * face, env forwarding, and devin CLI argv assembly.
 *
 * The Context declaration merging lives here (not per entry point) so both
 * `dsh-plugin-devin` and `dsh-plugin-devin/provider` can import it without colliding.
 * @module dsh-plugin-devin/shared
 */

/** Minimal structural face of @deepseek-ai/dsh-subprocess (ctx.subprocess). */
export interface SubprocessLike {
  resolveExecutable(command: string, env?: Readonly<Record<string, string>>, signal?: AbortSignal): Promise<string>
  spawn(spec: {
    argv: readonly string[]
    cwd: string
    stdio: {
      stdin: 'ignore' | 'pipe' | { readonly data: string }
      stdout: 'pipe' | 'inherit' | { maxBytes: number; spill?: { maxBytes: number } }
      stderr: 'pipe' | 'inherit' | { maxBytes: number; spill?: { maxBytes: number } }
    }
    graceMs: number
    signal?: AbortSignal | undefined
    env?: NodeJS.ProcessEnv | undefined
  }): {
    readonly pid: number
    readonly stdin: NodeJS.WritableStream | undefined
    readonly stdout: NodeJS.ReadableStream | undefined
    readonly stderr: NodeJS.ReadableStream | undefined
    readonly collected: {
      readonly stdout?: { readFrom(offset: number): { text: string; nextOffset: number; lossy: boolean; spillPath?: string } }
      readonly stderr?: { readFrom(offset: number): { text: string; nextOffset: number; lossy: boolean; spillPath?: string } }
    }
    readonly done: Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>
    terminate(): void
    waitForExit(signal?: AbortSignal): Promise<boolean>
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    subprocess: SubprocessLike
  }
}

/** Collect the env entries a forwardEnv list names, skipping unset variables. */
export function forwardedEnv(names: readonly string[]): Record<string, string> {
  const env: Record<string, string> = {}
  for (const key of names) {
    const value = process.env[key]
    if (value !== undefined) env[key] = value
  }
  return env
}

export interface DevinCliFlags {
  model?: string | undefined
  permissionMode?: string | undefined
  cloud?: boolean | undefined
  resume?: string | undefined
  respectWorkspaceTrust?: boolean | undefined
  extraArgs?: readonly string[] | undefined
}

/**
 * Assemble `devin --print` argv (without the executable itself).
 * The prompt is always last, behind `--`, so it can never parse as a flag.
 */
export function devinPrintArgv(flags: DevinCliFlags, prompt: string): string[] {
  const argv: string[] = []
  if (flags.model) argv.push('--model', flags.model)
  if (flags.permissionMode) argv.push('--permission-mode', flags.permissionMode)
  if (flags.cloud) argv.push('--cloud')
  if (flags.resume) argv.push('--resume', flags.resume)
  if (!flags.respectWorkspaceTrust) argv.push('--respect-workspace-trust', 'false')
  if (flags.extraArgs) argv.push(...flags.extraArgs)
  argv.push('-p', '--', prompt)
  return argv
}
