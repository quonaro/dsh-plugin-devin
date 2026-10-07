// Smoke test for the ACP transport and its pooled sessions: a fake `devin`
// binary speaks ndjson JSON-RPC, records every request to a JSONL log, and
// echoes image block counts back in the streamed text — proving that one
// process serves many conversations, a fresh session gets the whole
// transcript, a reused one gets only the tail, and a dead process replays.
import { mkdtempSync, writeFileSync, chmodSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn as spawnChild } from 'node:child_process'
import assert from 'node:assert/strict'

const plugin = await import('../lib/provider.js')
assert.equal(plugin.name, '@quonaro/dsh-plugin-devin/provider')

const dir = mkdtempSync(join(tmpdir(), 'dsh-plugin-devin-acp-'))
const logPath = join(dir, 'acp-requests.jsonl')

const img1Path = join(dir, 'shot1.png')
const img1Bytes = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')
writeFileSync(img1Path, img1Bytes)
const img2Path = join(dir, 'shot2.png')
const img2Bytes = Buffer.from('89504e470d0a1a0a0000000e49484453', 'hex')
writeFileSync(img2Path, img2Bytes)

// Fake agent: session/new hands out s1, s2, …; every session/prompt streams
// one text chunk ("turn N images:I bytes:B") on the requesting session.
const fakeDevin = join(dir, 'devin')
writeFileSync(fakeDevin, `#!/usr/bin/env node
const fs = require('node:fs')
const readline = require('node:readline')
const rl = readline.createInterface({ input: process.stdin })
const logPath = process.env.FAKE_ACP_LOG
const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\\n')
const log = (entry) => fs.appendFileSync(logPath, JSON.stringify({ pid: process.pid, ...entry }) + '\\n')
let nextSession = 0
let turn = 0
const update = (sessionId, u) => send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: u } })
rl.on('line', (line) => {
  let msg
  try { msg = JSON.parse(line) } catch { return }
  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, promptCapabilities: { image: true } } })
  } else if (msg.method === 'session/new') {
    const sessionId = 's' + (++nextSession)
    log({ method: 'session/new', sessionId })
    send({ jsonrpc: '2.0', id: msg.id, result: {
      sessionId,
      modes: { currentModeId: 'accept-edits', availableModes: [{ id: 'accept-edits' }, { id: 'bypass' }] },
      configOptions: [{ id: 'model', category: 'model', type: 'select', currentValue: 'default-model',
        options: [{ value: 'default-model' }, { value: 'swe-1-6-fast' }] }],
    } })
  } else if (msg.method === 'session/set_mode') {
    log({ method: 'session/set_mode', sessionId: msg.params.sessionId, modeId: msg.params.modeId })
    send({ jsonrpc: '2.0', id: msg.id, result: {} })
  } else if (msg.method === 'session/set_config_option') {
    log({ method: 'session/set_config_option', sessionId: msg.params.sessionId, configId: msg.params.configId, value: msg.params.value })
    send({ jsonrpc: '2.0', id: msg.id, result: {} })
  } else if (msg.method === 'session/prompt') {
    const prompt = msg.params.prompt ?? []
    const images = prompt.filter((b) => b.type === 'image')
    const bytes = images.reduce((n, b) => n + Buffer.from(b.data ?? '', 'base64').length, 0)
    const text = prompt.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\\n')
    const n = ++turn
    log({ method: 'session/prompt', sessionId: msg.params.sessionId, turn: n, images: images.length, bytes, text })
    update(msg.params.sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'turn ' + n + ' images:' + images.length + ' bytes:' + bytes + ' ' } })
    update(msg.params.sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'done' } })
    update(msg.params.sessionId, { sessionUpdate: 'usage_update', used: 42, _meta: { 'cognition.ai/inputTokens': 30, 'cognition.ai/outputTokens': 12 } })
    send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn', usage: { inputTokens: 30, outputTokens: 12, totalTokens: 42 } } })
  } else if (msg.method !== undefined && msg.id !== undefined) {
    send({ jsonrpc: '2.0', id: msg.id, result: {} })
  }
})
`)
chmodSync(fakeDevin, 0o755)

let registered = null
let teardown = () => {}
const spawned = []
const ctx = {
  llm: {
    registerAdapter: (providers, adapter) => { registered = { providers, adapter }; return () => {} },
    registerConfigurableProviders: () => () => {},
  },
  effect: (fn) => { const dispose = fn(); teardown = dispose ?? (() => {}); return () => dispose?.() },
  get(name) {
    if (name === 'attachments') {
      return { imageHostPath: (ref) => ref.path }
    }
    return undefined
  },
  subprocess: {
    async resolveExecutable(cmd) { return cmd },
    spawn(spec) {
      const child = spawnChild(spec.argv[0], spec.argv.slice(1), {
        cwd: spec.cwd,
        env: { ...process.env, ...spec.env, FAKE_ACP_LOG: logPath },
      })
      spawned.push(child)
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
    timeoutMs: 15000, stderrMaxBytes: 65536, respectWorkspaceTrust: false,
    forwardEnv: ['FAKE_ACP_LOG'], extraArgs: [],
    models: [
      { id: 'default', devinModel: '', name: 'Devin (account default)' },
      { id: 'fast', devinModel: 'swe-1-6-fast', name: 'Devin Fast' },
    ],
    brief: 'TEST-BRIEF', localSessionTitles: true,
    transport: 'acp', maxImages: 8, maxImageBytes: 5242880,
    autoDiscoverModels: false, discoveryTimeoutMs: 15000, discoveryCacheMs: 300000,
    sessionIdleMs: 900000,
  }).map(([k, v]) => [k, { get: () => v }]),
)

plugin.apply(ctx, config)
const prepared = await registered.adapter.prepareCall('devin', 'default')
const preparedFast = await registered.adapter.prepareCall('devin', 'fast')

const readLog = () => readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
const stream = async (opts) => {
  const chunks = []
  for await (const chunk of prepared.stream({ provider: 'devin', model: 'default', ...opts })) chunks.push(chunk)
  return chunks
}
const streamFast = async (opts) => {
  const chunks = []
  for await (const chunk of preparedFast.stream({ provider: 'devin', model: 'fast', ...opts })) chunks.push(chunk)
  return chunks
}
const imageBlock = (name, path, bytes) => ({
  type: 'image',
  attachment: { attachmentId: name, mediaType: 'image/png', bytes, width: 1, height: 1, name, path },
})
const userMsg = (text, ...blocks) => ({ role: 'user', content: [{ type: 'text', text }, ...blocks] })
const asstMsg = (text) => ({ role: 'assistant', content: [{ type: 'text', text }] })

// --- 1. First turn on conversation A: fresh session gets the full transcript + image.
const chunks1 = await stream({
  sessionId: 'conv-a',
  messages: [userMsg('U1-ALPHA', imageBlock('shot1.png', img1Path, img1Bytes.length))],
})
assert.equal(chunks1.at(-1).type, 'finish')
assert.equal(chunks1.at(-1).reason.kind, 'stop')
const text1 = chunks1.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')
assert.match(text1, new RegExp(`turn 1 images:1 bytes:${img1Bytes.length}`))

let log = readLog()
assert.equal(spawned.length, 1, 'one agent process expected')
assert.equal(log.filter((e) => e.method === 'session/new').length, 1)
assert.equal(log.filter((e) => e.method === 'session/set_mode')[0].modeId, 'accept-edits')
const prompt1 = log.filter((e) => e.method === 'session/prompt')[0]
assert.equal(prompt1.sessionId, 's1')
assert.match(prompt1.text, /TEST-BRIEF/)
assert.match(prompt1.text, /<transcript>/)
assert.match(prompt1.text, /U1-ALPHA/)

// --- 2. Same conversation, grown transcript: same session, only the tail is sent.
const chunks2 = await stream({
  sessionId: 'conv-a',
  messages: [
    userMsg('U1-ALPHA', imageBlock('shot1.png', img1Path, img1Bytes.length)),
    asstMsg('A1-BRAVO'),
    userMsg('U2-CHARLIE', imageBlock('shot2.png', img2Path, img2Bytes.length)),
  ],
})
assert.equal(chunks2.at(-1).reason.kind, 'stop')
const text2 = chunks2.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')
assert.match(text2, new RegExp(`turn 2 images:1 bytes:${img2Bytes.length}`))

log = readLog()
assert.equal(spawned.length, 1, 'second turn must reuse the process')
assert.equal(log.filter((e) => e.method === 'session/new').length, 1, 'second turn must reuse the session')
const prompt2 = log.filter((e) => e.method === 'session/prompt')[1]
assert.equal(prompt2.sessionId, 's1', 'conversation A must stay on session s1')
assert.match(prompt2.text, /U2-CHARLIE/)
assert.match(prompt2.text, /A1-BRAVO/)
assert.doesNotMatch(prompt2.text, /U1-ALPHA/, 'reused session must not get a replay')
assert.doesNotMatch(prompt2.text, /<transcript>/)

// --- 3. A different conversation gets its own session on the same process.
const chunks3 = await stream({
  sessionId: 'conv-b',
  messages: [userMsg('X1-DELTA')],
})
assert.equal(chunks3.at(-1).reason.kind, 'stop')
log = readLog()
assert.equal(spawned.length, 1)
assert.equal(log.filter((e) => e.method === 'session/new').length, 2, 'conversation B needs its own session')
const prompt3 = log.filter((e) => e.method === 'session/prompt')[2]
assert.equal(prompt3.sessionId, 's2')
assert.match(prompt3.text, /X1-DELTA/)
assert.match(prompt3.text, /<transcript>/, 'a fresh session gets the full transcript')

// --- 4. Model selection goes through session/set_config_option, not set_model.
const chunks4 = await streamFast({
  sessionId: 'conv-c',
  messages: [userMsg('F1-ECHO')],
})
assert.equal(chunks4.at(-1).reason.kind, 'stop')
log = readLog()
const setModel = log.filter((e) => e.method === 'session/set_config_option')
assert.equal(setModel.length, 1)
assert.equal(setModel[0].configId, 'model')
assert.equal(setModel[0].value, 'swe-1-6-fast')
assert.equal(setModel[0].sessionId, 's3')

// --- 5. Process death: the next turn respawns, recreates the session, replays.
spawned[0].kill('SIGKILL')
await new Promise((r) => setTimeout(r, 300))
const chunks5 = await stream({
  sessionId: 'conv-a',
  messages: [
    userMsg('U1-ALPHA'),
    asstMsg('A1-BRAVO'),
    userMsg('U2-CHARLIE'),
    asstMsg('A2-FOXTROT'),
    userMsg('U3-GOLF'),
  ],
})
assert.equal(chunks5.at(-1).reason.kind, 'stop')
log = readLog()
assert.equal(spawned.length, 2, 'a dead process must be respawned')
const newProcLog = log.filter((e) => e.pid === spawned[1].pid)
assert.equal(newProcLog.filter((e) => e.method === 'session/new').length, 1)
const prompt5 = newProcLog.filter((e) => e.method === 'session/prompt')[0]
assert.match(prompt5.text, /U1-ALPHA/, 'recreated session replays the whole transcript')
assert.match(prompt5.text, /U3-GOLF/)

// --- 6. Two concurrent turns on one conversation serialize and do not replay.
const msgsC1 = [userMsg('C1-HOTEL')]
const msgsC2 = [userMsg('C1-HOTEL'), asstMsg('C2-INDIA'), userMsg('C3-JULIETT')]
const [chunks6a, chunks6b] = await Promise.all([
  stream({ sessionId: 'conv-d', messages: msgsC1 }),
  stream({ sessionId: 'conv-d', messages: msgsC2 }),
])
assert.equal(chunks6a.at(-1).reason.kind, 'stop')
assert.equal(chunks6b.at(-1).reason.kind, 'stop')
log = readLog()
const convDPrompts = log.filter((e) => e.method === 'session/prompt' && (e.text.includes('C1-HOTEL') || e.text.includes('C3-JULIETT')))
assert.equal(convDPrompts.length, 2)
assert.equal(convDPrompts[0].sessionId, convDPrompts[1].sessionId, 'one conversation stays on one session')
const second = convDPrompts[1]
assert.match(second.text, /C3-JULIETT/)
assert.doesNotMatch(second.text, /C1-HOTEL/, 'the queued turn sends only the unsent tail')
assert.doesNotMatch(second.text, /<transcript>/)

// --- 7. A purpose call does not touch the conversation session.
const chunks7 = await stream({
  sessionId: 'conv-a',
  purpose: 'compaction',
  messages: [userMsg('SUMMARIZE-KILO')],
})
assert.equal(chunks7.at(-1).reason.kind, 'stop')
log = readLog()
const compactionPrompt = log.filter((e) => e.method === 'session/prompt' && e.text.includes('SUMMARIZE-KILO'))[0]
assert.ok(compactionPrompt.sessionId !== 's1', 'compaction uses an ephemeral session')

// Disposing the plugin must terminate the pooled agent processes; their pipes
// would otherwise keep this process alive.
await teardown()
await new Promise((r) => setTimeout(r, 200))
assert.ok(spawned.every((c) => c.killed || c.exitCode !== null), 'pooled agents must be terminated on dispose')

console.log('smoke-acp: PASS')
