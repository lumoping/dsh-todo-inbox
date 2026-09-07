/**
 * Smoke test against the BUILT bundles (lib/index.js host + lib/client.js
 * browser), not the sources — it validates what actually ships.
 *
 *   pnpm run build && node scripts/smoke-test.mjs
 *
 * Host side: a stub ctx provides fs / tools / webServer / effect; tools are
 * executed end to end, persistence is checked on disk, an external file edit
 * is picked up by the poll tick, and the /todo-inbox/api HTTP routes are
 * exercised through the registered handler.
 *
 * Browser side: a fake window.__ModuleLoader__ captures the client factory,
 * `require` resolves the module-table externals from node_modules, and apply()
 * is invoked against a stub slots registry to assert the sidebar registration.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const nodeRequire = createRequire(import.meta.url)

const ROOT = new URL('..', import.meta.url).pathname
let failures = 0

function check(name, fn) {
  try {
    fn()
    console.log(`  ok  ${name}`)
  } catch (error) {
    failures += 1
    console.error(`FAIL  ${name}\n      ${error?.message ?? error}`)
  }
}

// ── host half ───────────────────────────────────────────────────────────────

const dir = mkdtempSync(join(tmpdir(), 'todo-inbox-smoke-'))
const dataPath = join(dir, 'todo-inbox.json')

const registeredTools = []
const registeredRoutes = []
const registeredSections = []

const ctx = {
  tools: { register: (tool) => { registeredTools.push(tool) } },
  webServer: { register: (route) => { registeredRoutes.push(route); return () => {} } },
  systemPrompt: { section: (section) => { registeredSections.push(section); return () => {} } },
  effect: (fn) => { fn() },
}

const { apply } = await import('../lib/index.js')

console.log('\n[host] loading and mounting lib/index.js')
check('plugin entry exports (name/inject/apply)', () => {
  const mod = { apply }
  assert.equal(typeof mod.apply, 'function')
  assert.equal(typeof apply, 'function')
})

const host = await import('../lib/index.js')
const name = host.name
const inject = host.inject
check('name = todo-inbox, injects tools/webServer/systemPrompt', () => {
  assert.equal(name, 'todo-inbox')
  assert.deepEqual(inject, ['tools', 'webServer', 'systemPrompt'])
})

apply(ctx, { dataPath })

const tool = (toolName) => {
  const found = registeredTools.find((t) => t.name === toolName)
  assert.ok(found, `tool ${toolName} registered`)
  return found
}
check('three model tools registered', () => {
  assert.deepEqual(registeredTools.map((t) => t.name).sort(), ['inbox_add', 'inbox_done', 'inbox_list'])
})
check('one /todo-inbox/api prefix route registered', () => {
  assert.equal(registeredRoutes.length, 1)
  assert.equal(registeredRoutes[0].kind, 'prefix')
  assert.equal(registeredRoutes[0].path, '/todo-inbox/api')
})

check('prompt discipline section registered', () => {
  assert.equal(registeredSections.length, 1)
  assert.equal(registeredSections[0].name, 'todo-inbox:discipline')
  assert.ok(registeredSections[0].text.includes('inbox_add'))
})

const exec = async (toolName, args) => {
  const t = tool(toolName)
  const result = await t.execute(args, { agent: { sessionId: 'smoke-session' } })
  return result
}

console.log('\n[host] tool round trip')
let added
check('inbox_add persists an item', async () => {
  const result = await exec('inbox_add', { type: 'merge-mr', title: 'merge MR !1234', link: 'https://mr/1234' })
  assert.equal(result.ok, true)
  assert.equal(result.pending, 1)
  added = result.id
  const onDisk = JSON.parse(readFileSync(dataPath, 'utf8'))
  assert.equal(onDisk.items.length, 1)
  assert.equal(onDisk.items[0].title, 'merge MR !1234')
  assert.equal(onDisk.items[0].source, 'smoke-session')
})
check('inbox_list returns the pending item', async () => {
  const result = await exec('inbox_list', {})
  assert.equal(result.pending, 1)
  assert.equal(result.items.length, 1)
  assert.equal(result.items[0].id, added)
})
check('inbox_done marks it done (no longer pending)', async () => {
  const result = await exec('inbox_done', { id: added })
  assert.equal(result.ok, true)
  assert.equal(result.pending, 0)
  const listed = await exec('inbox_list', {})
  assert.equal(listed.items.length, 0)
  const onDisk = JSON.parse(readFileSync(dataPath, 'utf8'))
  assert.notEqual(onDisk.items[0].doneAt, null)
})

console.log('\n[host] external file edit poll')
check('poll tick reloads an external edit', async () => {
  const before = JSON.parse(readFileSync(dataPath, 'utf8'))
  before.items.push({
    id: 'external-1', type: 'review', title: 'review PR #9', detail: '', link: '',
    dueAt: null, createdAt: new Date().toISOString(), source: 'file-edit', doneAt: null,
  })
  writeFileSync(dataPath, JSON.stringify(before))
  // Wait for the 5s poll interval.
  await new Promise((resolve) => setTimeout(resolve, 5600))
  const listed = await exec('inbox_list', {})
  assert.equal(listed.pending, 1)
  assert.equal(listed.items[0].id, 'external-1')
})

console.log('\n[host] HTTP bridge')
const req = (method, pathname, body) => ({
  method,
  url: pathname,
  headers: { host: '127.0.0.1:3080' },
  async *[Symbol.asyncIterator]() {
    if (body) yield JSON.stringify(body)
  },
})
const send = async (method, pathname, body) => {
  const res = {
    status: 0, payload: null,
    writeHead(status, _headers) { this.status = status },
    end(text) { this.payload = JSON.parse(text) },
  }
  await registeredRoutes[0].handler(req(method, pathname, body), res)
  return res
}
let httpResult
check('GET /todo-inbox/api/items', async () => {
  const res = await send('GET', '/todo-inbox/api/items')
  assert.equal(res.status, 200)
  assert.equal(res.payload.ok, true)
  assert.equal(res.payload.pending, 1)
  httpResult = res.payload
})
check('POST /todo-inbox/api/done', async () => {
  const res = await send('POST', '/todo-inbox/api/done', { id: 'external-1' })
  assert.equal(res.status, 200)
  assert.equal(res.payload.ok, true)
  assert.equal(res.payload.pending, 0)
})
check('POST /todo-inbox/api/add then remove', async () => {
  const addRes = await send('POST', '/todo-inbox/api/add', { title: 'approve work order #77', type: 'approve-order' })
  assert.equal(addRes.payload.ok, true)
  const id = addRes.payload.id
  const rmRes = await send('POST', '/todo-inbox/api/remove', { id })
  assert.equal(rmRes.payload.ok, true)
  assert.equal(rmRes.payload.pending, 0)
})
check('cross-origin request is fenced', async () => {
  const evil = {
    method: 'GET', url: '/todo-inbox/api/items',
    headers: { host: '127.0.0.1:3080', origin: 'https://evil.example' },
    async *[Symbol.asyncIterator]() {},
  }
  const res = { status: 0, payload: null, writeHead(s, _h) { this.status = s }, end(t) { this.payload = JSON.parse(t) } }
  await registeredRoutes[0].handler(evil, res)
  assert.equal(res.status, 403)
})

// ── browser half ────────────────────────────────────────────────────────────

console.log('\n[client] loading lib/client.js through the module loader')
let captured = null
const moduleTable = { /* resolved below per specifier */ }
globalThis.window = {
  __ModuleLoader__: {
    load: ({ id, factory }) => { captured = { id, factory } },
  },
}

const clientPath = join(ROOT, 'lib/client.js')
const clientSource = readFileSync(clientPath, 'utf8')

const clientModule = { exports: {} }
const clientRequire = (specifier) => {
  assert.ok(
    [
      'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client',
      'cordis', '@deepseek-ai/dsh-client-ui-slots',
      '@deepseek-ai/dsh-client-ui-primitives',
    ].includes(specifier),
    `unexpected runtime require: ${specifier}`,
  )
  // ui-primitives is a pure-ESM package that createRequire cannot load; the
  // bundle only uses the icon component at render time (never during the
  // smoke test), so a minimal stub satisfies the factory.
  if (specifier === '@deepseek-ai/dsh-client-ui-primitives') {
    return { IconChecklistOutline14: () => null }
  }
  // createRoot needs a real DOM container; the smoke test has no DOM, so
  // return a no-op root.
  if (specifier === 'react-dom/client') {
    return { createRoot: () => ({ render: () => {}, unmount: () => {} }) }
  }
  return nodeRequire(specifier)
}

// Execute the bundle: banner calls window.__ModuleLoader__.load; the factory
// is captured, not run yet.
// eslint-disable-next-line no-new-func
new Function('window', 'require', 'module', 'exports', clientSource)(globalThis.window, clientRequire, clientModule, clientModule.exports)

check('bundle registers id dsh-todo-inbox', () => {
  assert.ok(captured, 'window.__ModuleLoader__.load was called')
  assert.equal(captured.id, 'dsh-todo-inbox')
})

const factory = captured.factory
// The closure factory (intro declares its own module/exports) RETURNS the
// plugin API — the loader captures that return value, not an outer object.
const clientApi = factory(clientRequire)

check('client plugin entry (name/inject/apply)', () => {
  assert.deepEqual(clientApi.inject, ['slots'])
  assert.equal(typeof clientApi.apply, 'function')
})

let injectedSlot = null
const clientCtx = {
  effect: (fn) => { fn() },
  slots: {
    inject: (slot, factory2) => { injectedSlot = { slot, factory2 } },
    register: (_options, component) => component,
  },
}
let styleTags = 0
globalThis.document = {
  querySelector: () => null,
  getElementById: () => null,
  createElement: () => ({ dataset: {}, textContent: '', remove: () => {} }),
  head: { appendChild: () => { styleTags += 1 } },
  body: { appendChild: () => {} },
}
clientApi.apply(clientCtx)
check('apply() injects sidebar.footer.action', () => {
  assert.equal(injectedSlot.slot, 'sidebar.footer.action')
})
check('apply() injects the plugin style tag', () => {
  assert.equal(styleTags, 1)
})

console.log('\n[client] renderDetail (safe markdown subset)')
check('bold / italic / code / link / bare URL', () => {
  const nodes = clientApi.renderDetail('**b** *i* `c` [x](https://a.b) https://c.d', 'k')
  // Separator spaces render as plain text nodes; compare element types only.
  const types = nodes.filter((n) => typeof n !== 'string').map((n) => n.type)
  assert.deepEqual(types, ['strong', 'em', 'code', 'a', 'a'])
})
check('unsafe protocol renders as literal text, never a link', () => {
  const nodes = clientApi.renderDetail('see [x](javascript:alert(1)) ok', 'k')
  const joined = nodes.map((n) => (typeof n === 'string' ? n : `[${n.type}]`)).join('')
  assert.ok(joined.includes('[x](javascript:alert(1))'))
  assert.ok(!joined.includes('[a]'), 'javascript: must not become an <a>')
})
check('unmatched markdown stays literal', () => {
  const nodes = clientApi.renderDetail('**unclosed', 'k')
  assert.equal(nodes.join(''), '**unclosed')
})

// ── teardown ────────────────────────────────────────────────────────────────

rmSync(dir, { recursive: true, force: true })
console.log('\n' + (failures === 0 ? 'SMOKE TEST PASS' : `SMOKE TEST FAILED (${failures} failure(s))`))
process.exit(failures === 0 ? 0 : 1)
