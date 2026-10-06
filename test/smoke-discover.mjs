// Smoke test for ACP model discovery: a fake `devin` binary speaks ndjson
// JSON-RPC — answers initialize, and session/new with a configOptions model list.
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn as spawnChild } from 'node:child_process'
import assert from 'node:assert/strict'

const plugin = await import('../lib/provider.js')
assert.equal(plugin.name, '@quonaro/dsh-plugin-devin/provider')

const dir = mkdtempSync(join(tmpdir(), 'dsh-plugin-devin-disc-'))
const fakeDevin = join(dir, 'devin')
writeFileSync(fakeDevin, `#!/usr/bin/env node
const readline = require('node:readline')
const rl = readline.createInterface({ input: process.stdin })
rl.on('line', (line) => {
  let msg
  try { msg = JSON.parse(line) } catch { return }
  if (msg.method === 'initialize') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } }) + '\\n')
  } else if (msg.method === 'session/new') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {
      sessionId: 'fake',
      configOptions: [
        { id: 'mode', category: 'mode', type: 'select', currentValue: 'code', options: [{ value: 'code', name: 'Code' }] },
        { id: 'model', category: 'model', type: 'select', currentValue: 'swe-2-high', options: [
          { value: 'adaptive', name: 'Adaptive' },
          { value: 'swe-2-high', name: 'SWE-2' },
          { options: [{ value: 'grouped-model', name: 'Grouped One' }], name: 'Group A' }
        ] }
      ]
    } }) + '\\n')
  }
})
`)
chmodSync(fakeDevin, 0o755)

let registered = null
const ctx = {
  llm: {
    registerAdapter: (providers, adapter) => { registered = { providers, adapter }; return () => {} },
    registerConfigurableProviders: () => () => {},
  },
  subprocess: {
    async resolveExecutable(cmd) { return cmd },
    spawn(spec) {
      const child = spawnChild(spec.argv[0], spec.argv.slice(1), { cwd: spec.cwd, env: { ...process.env, ...spec.env } })
      return {
        pid: child.pid,
        stdin: child.stdin,
        stdout: child.stdout,
        stderr: child.stderr,
        collected: {},
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
    brief: 'B', localSessionTitles: true,
    autoDiscoverModels: true, discoveryTimeoutMs: 15000, discoveryCacheMs: 300000,
  }).map(([k, v]) => [k, { get: () => v }]),
)

plugin.apply(ctx, config)
const models = await registered.adapter.listModels('devin')
const ids = models.map((m) => m.id)
assert.deepEqual(ids, ['default', 'adaptive', 'swe-2-high', 'grouped-model'])
assert.equal(models[2].name, 'SWE-2')
assert.match(models[0].description, /swe-2-high/)
console.log('smoke-discover: PASS')
