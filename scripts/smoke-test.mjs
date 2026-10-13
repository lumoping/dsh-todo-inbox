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

async function check(name, fn) {
  try {
    // `await` matters: most checks are async, and a swallowed rejection would
    // report a false pass (and never reach the failure count).
    await fn()
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
await check('plugin entry exports (name/inject/apply)', () => {
  const mod = { apply }
  assert.equal(typeof mod.apply, 'function')
  assert.equal(typeof apply, 'function')
})

const host = await import('../lib/index.js')
const name = host.name
const inject = host.inject
await check('name = todo-inbox, injects tools/webServer/systemPrompt', () => {
  assert.equal(name, 'todo-inbox')
  assert.deepEqual(inject, ['tools', 'webServer', 'systemPrompt'])
})

apply(ctx, { dataPath })

const tool = (toolName) => {
  const found = registeredTools.find((t) => t.name === toolName)
  assert.ok(found, `tool ${toolName} registered`)
  return found
}
await check('four model tools registered', () => {
  assert.deepEqual(registeredTools.map((t) => t.name).sort(), ['inbox_add', 'inbox_done', 'inbox_list', 'inbox_update'])
})
await check('one /todo-inbox/api prefix route registered', () => {
  assert.equal(registeredRoutes.length, 1)
  assert.equal(registeredRoutes[0].kind, 'prefix')
  assert.equal(registeredRoutes[0].path, '/todo-inbox/api')
})

await check('prompt discipline section registered', () => {
  assert.equal(registeredSections.length, 1)
  assert.equal(registeredSections[0].name, 'todo-inbox:discipline')
  const text = registeredSections[0].text
  assert.ok(text.includes('inbox_add'))
  // The noise rules the section must keep carrying: scope, dedupe, short titles.
  assert.ok(text.includes('todo_write'), 'delegates in-session steps to todo_write')
  assert.ok(text.includes('inbox_update'), 'tells the model to revise rather than duplicate')
  assert.ok(text.includes('inbox_list'), 'requires checking for an existing item first')
  assert.ok(/40 characters/.test(text), 'bounds the title length')
})

/** Real dsh session ids are `session-<uuid>`; the agent hands over the bare uuid. */
const SESSION_UUID = '11111111-2222-4333-8444-555555555555'
const SESSION_ID = `session-${SESSION_UUID}`

const exec = async (toolName, args) => {
  const t = tool(toolName)
  const result = await t.execute(args, { agent: { sessionId: SESSION_UUID } })
  return result
}

console.log('\n[host] tool round trip')
let added
await check('inbox_add persists an item', async () => {
  const result = await exec('inbox_add', { type: 'merge-mr', title: 'merge MR !1234', link: 'https://mr/1234' })
  assert.equal(result.ok, true)
  assert.equal(result.pending, 1)
  added = result.id
  const onDisk = JSON.parse(readFileSync(dataPath, 'utf8'))
  assert.equal(onDisk.items.length, 1)
  assert.equal(onDisk.items[0].title, 'merge MR !1234')
  // normalizeSource canonicalizes to the prefixed id sessions.open()/uiWorkspace expects.
  assert.equal(onDisk.items[0].source, SESSION_ID)
})
await check('inbox_list returns the pending item', async () => {
  const result = await exec('inbox_list', {})
  assert.equal(result.pending, 1)
  assert.equal(result.items.length, 1)
  assert.equal(result.items[0].id, added)
})
await check('inbox_update rewrites fields in place, no new row', async () => {
  const before = JSON.parse(readFileSync(dataPath, 'utf8')).items[0]
  const result = await exec('inbox_update', {
    id: added, title: 'merge MR !1234 (rebase first)', type: 'review',
    detail: 'CI green, needs rebase', link: 'https://mr/1234',
  })
  assert.equal(result.ok, true)
  assert.equal(result.pending, 1, 'update must not change the pending count')
  const onDisk = JSON.parse(readFileSync(dataPath, 'utf8'))
  assert.equal(onDisk.items.length, 1, 'update must not append a row')
  const after = onDisk.items[0]
  assert.equal(after.id, before.id)
  assert.equal(after.createdAt, before.createdAt, 'update keeps the creation time')
  assert.equal(after.title, 'merge MR !1234 (rebase first)')
  assert.equal(after.type, 'review')
  assert.equal(after.detail, 'CI green, needs rebase')
  assert.equal(after.source, SESSION_ID, 'update keeps the source session')
})
await check('inbox_update leaves omitted fields alone and clears on empty string', async () => {
  const result = await exec('inbox_update', { id: added, detail: '', due: '' })
  assert.equal(result.ok, true)
  const after = JSON.parse(readFileSync(dataPath, 'utf8')).items[0]
  assert.equal(after.detail, '', 'an empty string clears detail')
  assert.equal(after.dueAt, null, 'an empty string clears the deadline')
  assert.equal(after.link, 'https://mr/1234', 'an omitted link stays untouched')
  assert.equal(after.title, 'merge MR !1234 (rebase first)', 'an omitted title stays untouched')
})
await check('inbox_update / inbox_done report why they failed', async () => {
  const blank = await exec('inbox_update', { id: added, title: '   ' })
  assert.equal(blank.ok, false)
  assert.equal(blank.error, 'empty_title')
  const missingUpdate = await exec('inbox_update', { id: 'no-such-id', title: 'x' })
  assert.equal(missingUpdate.ok, false)
  assert.equal(missingUpdate.error, 'not_found')
  const missingDone = await exec('inbox_done', { id: 'no-such-id' })
  assert.equal(missingDone.ok, false)
  assert.equal(missingDone.error, 'not_found')
  const onDisk = JSON.parse(readFileSync(dataPath, 'utf8'))
  assert.equal(onDisk.items.length, 1)
  assert.equal(onDisk.items[0].title, 'merge MR !1234 (rebase first)', 'a rejected update changes nothing')
})
await check('inbox_done marks it done (no longer pending)', async () => {
  const result = await exec('inbox_done', { id: added })
  assert.equal(result.ok, true)
  assert.equal(result.pending, 0)
  const listed = await exec('inbox_list', {})
  assert.equal(listed.items.length, 0)
  const onDisk = JSON.parse(readFileSync(dataPath, 'utf8'))
  assert.notEqual(onDisk.items[0].doneAt, null)
})

console.log('\n[host] external file edit poll')
await check('poll tick reloads an external edit', async () => {
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
await check('GET /todo-inbox/api/items', async () => {
  const res = await send('GET', '/todo-inbox/api/items')
  assert.equal(res.status, 200)
  assert.equal(res.payload.ok, true)
  assert.equal(res.payload.pending, 1)
  httpResult = res.payload
})
await check('POST /todo-inbox/api/done', async () => {
  const res = await send('POST', '/todo-inbox/api/done', { id: 'external-1' })
  assert.equal(res.status, 200)
  assert.equal(res.payload.ok, true)
  assert.equal(res.payload.pending, 0)
})
await check('POST /todo-inbox/api/add then remove', async () => {
  const addRes = await send('POST', '/todo-inbox/api/add', { title: 'approve work order #77', type: 'approve-order' })
  assert.equal(addRes.payload.ok, true)
  const id = addRes.payload.id
  const rmRes = await send('POST', '/todo-inbox/api/remove', { id })
  assert.equal(rmRes.payload.ok, true)
  assert.equal(rmRes.payload.pending, 0)
})
await check('cross-origin request is fenced', async () => {
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
      'react', 'react/jsx-runtime',
      'cordis', '@deepseek-ai/dsh-client-ui-slots',
      '@deepseek-ai/dsh-client-ui-primitives',
    ].includes(specifier),
    `unexpected runtime require: ${specifier}`,
  )
  // ui-primitives is a pure-ESM package that createRequire cannot load; the
  // bundle only uses the icon components at render time (never during the
  // smoke test), so a minimal stub satisfies the factory.
  if (specifier === '@deepseek-ai/dsh-client-ui-primitives') {
    return {
      IconChecklistOutlineRegular: () => null,
      IconCheckOutlineRegular: () => null,
      IconCloseOutlineRegular: () => null,
    }
  }
  return nodeRequire(specifier)
}

// Execute the bundle: banner calls window.__ModuleLoader__.load; the factory
// is captured, not run yet.
// eslint-disable-next-line no-new-func
new Function('window', 'require', 'module', 'exports', clientSource)(globalThis.window, clientRequire, clientModule, clientModule.exports)

await check('bundle registers id dsh-todo-inbox', () => {
  assert.ok(captured, 'window.__ModuleLoader__.load was called')
  assert.equal(captured.id, 'dsh-todo-inbox')
})

const factory = captured.factory
// The closure factory (intro declares its own module/exports) RETURNS the
// plugin API — the loader captures that return value, not an outer object.
const clientApi = factory(clientRequire)

await check('client plugin entry (name/inject/apply)', () => {
  assert.deepEqual(clientApi.inject, ['slots', 'uiWorkspace', 'layout'])
  assert.equal(typeof clientApi.apply, 'function')
})

let injectedSlot = null
const openedSessions = []
const clientCtx = {
  effect: (fn) => { fn() },
  slots: {
    inject: (slot, factory2) => { injectedSlot = { slot, factory2 } },
    register: (_options, component) => component,
  },
  uiWorkspace: { openSession: (id) => { openedSessions.push(id) } },
  layout: { toggleSidebar: () => {} },
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
await check('apply() injects sidebar.footer.action', () => {
  assert.equal(injectedSlot.slot, 'sidebar.footer.action')
})
await check('apply() injects the plugin style tag', () => {
  assert.equal(styleTags, 1)
})
await check('detail click navigates through uiWorkspace.openSession', () => {
  clientApi.openSourceSession('session-abc')
  assert.deepEqual(openedSessions, ['session-abc'])
  // A source that is not a session id must never navigate anywhere.
  clientApi.openSourceSession('api')
  clientApi.openSourceSession('')
  assert.deepEqual(openedSessions, ['session-abc'])
})
await check('client bundle drops the removed sessions.open face', () => {
  assert.ok(clientSource.includes('openSession'), 'should call uiWorkspace.openSession')
  assert.ok(!clientSource.includes('sessions.open('), 'should not call the removed sessions.open')
})

console.log('\n[client] renderDetail (safe markdown subset)')
await check('bold / italic / code / link / bare URL', () => {
  const nodes = clientApi.renderDetail('**b** *i* `c` [x](https://a.b) https://c.d', 'k')
  // Separator spaces render as plain text nodes; compare element types only.
  const types = nodes.filter((n) => typeof n !== 'string').map((n) => n.type)
  assert.deepEqual(types, ['strong', 'em', 'code', 'a', 'a'])
})
await check('unsafe protocol renders as literal text, never a link', () => {
  const nodes = clientApi.renderDetail('see [x](javascript:alert(1)) ok', 'k')
  const joined = nodes.map((n) => (typeof n === 'string' ? n : `[${n.type}]`)).join('')
  assert.ok(joined.includes('[x](javascript:alert(1))'))
  assert.ok(!joined.includes('[a]'), 'javascript: must not become an <a>')
})
await check('unmatched markdown stays literal', () => {
  const nodes = clientApi.renderDetail('**unclosed', 'k')
  assert.equal(nodes.join(''), '**unclosed')
})

// ── teardown ────────────────────────────────────────────────────────────────

rmSync(dir, { recursive: true, force: true })
console.log('\n' + (failures === 0 ? 'SMOKE TEST PASS' : `SMOKE TEST FAILED (${failures} failure(s))`))
process.exit(failures === 0 ? 0 : 1)
