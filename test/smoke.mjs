// Smoke test: load the built bundle in a stub cordis context, assert the tool
// registers, and run it end-to-end against a fake `devin` shell script.
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs'
import { spawn as spawnChild } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'

const plugin = await import('../lib/index.js')
assert.equal(plugin.name, 'dsh-plugin-devin')
assert.equal(typeof plugin.apply, 'function')

// Fake devin CLI: echoes args, exits 0.
const dir = mkdtempSync(join(tmpdir(), 'dsh-plugin-devin-'))
const fakeDevin = join(dir, 'devin')
writeFileSync(fakeDevin, '#!/bin/sh\necho "FAKE-DEVIN-OK"\necho "$@"\n')
chmodSync(fakeDevin, 0o755)

const registered = []
const ctx = {
  tools: { register: (def) => registered.push(def) },
  inject: (_services, fn) => {},
  subprocess: {
    async resolveExecutable(cmd) { return cmd },
    spawn(spec) {
      const spawn = spawnChild
      const child = spawn(spec.argv[0], spec.argv.slice(1), { cwd: spec.cwd, env: { ...process.env, ...spec.env } })
      const buffers = { stdout: [], stderr: [] }
      child.stdout.on('data', (d) => buffers.stdout.push(d))
      child.stderr.on('data', (d) => buffers.stderr.push(d))
      const collected = {}
      for (const stream of ['stdout', 'stderr']) {
        collected[stream] = {
          readFrom: () => ({ text: Buffer.concat(buffers[stream]).toString(), nextOffset: 0, lossy: false }),
        }
      }
      return {
        pid: child.pid,
        collected,
        done: new Promise((res) => child.on('close', (exitCode, signal) => res({ exitCode, signal }))),
        terminate() { child.kill('SIGTERM') },
        async waitForExit() { return true },
      }
    },
  },
}
// ctx.inject signature check: our stub above is sync no-op; commands service absent — fine.
const config = Object.fromEntries(
  Object.entries({
    devinPath: fakeDevin, permissionMode: 'accept-edits', model: '', cloud: false,
    timeoutMs: 60000, maxOutputBytes: 1048576, respectWorkspaceTrust: false,
    forwardEnv: [], extraArgs: [],
  }).map(([k, v]) => [k, { get: () => v }]),
)

plugin.apply(ctx, config)
assert.equal(registered.length, 1)
const tool = registered[0]
assert.equal(tool.name, 'devin')

const result = await tool.execute(
  { prompt: 'hello from smoke' },
  { callId: 'smoke', name: 'devin', arguments: { prompt: 'hello from smoke' }, signal: new AbortController().signal },
)
assert.equal(result.ok, true)
assert.match(result.stdout, /FAKE-DEVIN-OK/)
assert.match(result.stdout, /--respect-workspace-trust false/)
assert.match(result.stdout, /hello from smoke/)
console.log('smoke: PASS')
