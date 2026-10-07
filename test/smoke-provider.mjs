// Smoke test for the provider half: load lib/provider.js in a stub context,
// capture the registered adapter, and run one generation end-to-end against a
// fake `devin` binary that streams output.
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn as spawnChild } from 'node:child_process'
import assert from 'node:assert/strict'

const plugin = await import('../lib/provider.js')
assert.equal(plugin.name, '@quonaro/dsh-plugin-devin/provider')
assert.equal(typeof plugin.apply, 'function')

// Fake devin: streams two stdout lines then exits 0.
const dir = mkdtempSync(join(tmpdir(), 'dsh-plugin-devin-prov-'))
const fakeDevin = join(dir, 'devin')
writeFileSync(fakeDevin, '#!/bin/sh\necho "chunk-one"\nsleep 0.05\necho "chunk-two $1"\n')
chmodSync(fakeDevin, 0o755)

let registered = null
const configurable = []
const ctx = {
  llm: {
    registerAdapter: (providers, adapter) => { registered = { providers, adapter }; return () => {} },
    registerConfigurableProviders: (entries) => { configurable.push(...entries); return () => {} },
  },
  effect: (fn) => { const dispose = fn(); return () => dispose?.() },
  subprocess: {
    async resolveExecutable(cmd) { return cmd },
    spawn(spec) {
      const child = spawnChild(spec.argv[0], spec.argv.slice(1), { cwd: spec.cwd, env: { ...process.env, ...spec.env } })
      const errBuf = []
      child.stderr.on('data', (d) => errBuf.push(d))
      return {
        pid: child.pid,
        stdin: undefined,
        stdout: child.stdout,
        stderr: child.stderr,
        collected: {
          stderr: { readFrom: () => ({ text: Buffer.concat(errBuf).toString(), nextOffset: 0, lossy: false }) },
        },
        done: new Promise((res) => child.on('close', (exitCode, signal) => res({ exitCode, signal }))),
        terminate() { child.kill('SIGTERM') },
        async waitForExit() { return true },
      }
    },
  },
}
const config = Object.fromEntries(
  Object.entries({
    devinPath: fakeDevin, permissionMode: 'accept-edits', cloud: false, cwd: '',
    timeoutMs: 60000, stderrMaxBytes: 65536, respectWorkspaceTrust: false,
    forwardEnv: [], extraArgs: [],
    models: [{ id: 'default', devinModel: '', name: 'Devin (account default)' }],
    brief: 'TEST-BRIEF',
    transport: 'print', maxImages: 8, maxImageBytes: 5242880,
    localSessionTitles: true,
    autoDiscoverModels: false, discoveryTimeoutMs: 15000, discoveryCacheMs: 300000,
    sessionIdleMs: 900000,
  }).map(([k, v]) => [k, { get: () => v }]),
)

plugin.apply(ctx, config)
assert.deepEqual(registered.providers, ['devin'])
assert.equal(registered.adapter.providerInfo('devin').name, 'Devin ACP')
assert.equal(configurable[0].provider, 'devin')

const models = await registered.adapter.listModels('devin')
assert.equal(models[0].id, 'default')
assert.equal(models[0].provider, 'devin')

// One generation: system + user message in, streamed text out.
const chunks = []
const prepared = await registered.adapter.prepareCall('devin', 'default')
for await (const chunk of prepared.stream({
  provider: 'devin',
  model: 'default',
  messages: [
    { role: 'user', content: [{ type: 'text', text: 'do the thing' }] },
  ],
})) {
  chunks.push(chunk)
}

const types = chunks.map((c) => c.type)
assert.deepEqual(types[0], 'block-start')
assert.equal(types.at(-1), 'finish')
assert.equal(chunks.at(-1).reason.kind, 'stop')
const text = chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')
assert.match(text, /chunk-one/)
assert.match(text, /chunk-two/)
console.log('smoke-provider: PASS')
