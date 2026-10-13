/**
 * dsh-todo-inbox host half: a process-wide global todo inbox.
 *
 * Any session's agent can record "waiting on human" todos through the
 * inbox_add / inbox_done / inbox_list model tools (registered once at the
 * root realm, visible to every session). Items persist to a JSON file
 * (~/.dsh/todo-inbox.json by default, overridable via row `config.dataPath`)
 * which is the single source of truth: agents may also edit the file
 * directly, and a 5-second poll picks external edits up.
 *
 * The browser half talks to this host through plain HTTP routes under
 * /todo-inbox/api (registered on the shared webserver) — no remote-bridge
 * machinery needed, exactly like other third-party bundles.
 *
 * Persistence uses node:fs directly, NOT the injected `fs` service: the app's
 * fs service applies the workspace sandbox policy (writes to ~/.dsh/... are
 * denied), while a static host plugin runs in the real host process with full
 * Node privileges — same as other static bundles (e.g. dsh-better-sidebar).
 *
 * No Config schema: the row config passes through raw and unknown fields are
 * ignored, so a boot-time schema/version mismatch can never fail the plugin
 * tree.
 *
 * @module dsh-todo-inbox/host
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
// Type-only: pulls the ctx.webServer / ctx.tools / ctx.systemPrompt service
// declarations onto Context; value imports stay out of the bundle.
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-system-prompt'

export const name = 'todo-inbox'
export const inject = ['tools', 'webServer', 'systemPrompt']

/** One inbox item (mirrors the data-file record; all scalar fields). */
export interface InboxItem {
  id: string
  type: string
  title: string
  detail: string
  link: string
  dueAt: string | null
  createdAt: string
  source: string
  doneAt: string | null
}

export interface TodoInboxConfig {
  /** Absolute path of the JSON data file; parent directory must exist. */
  dataPath?: string
}

/** API prefix for the browser half (registered as a webserver prefix route). */
const API_PREFIX = '/todo-inbox/api'

/** A bare (unprefixed) session id: the persisted `header.id` form agents used to record. */
const BARE_SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu

/**
 * Normalize a session source to the canonical session id the client services
 * expect: the client session list uses the persisted `header.id`, which carries
 * the `session-` prefix. Sources recorded before that fix (bare ids) are
 * upgraded on read.
 *
 * Only a bare UUID is rewritten. Sources that are not session ids at all — an
 * empty string, or `api` for an item added from the sidebar — must pass
 * through untouched, or they would masquerade as a session (`api` would become
 * the bogus `session-api`) and the UI would offer a jump to nowhere.
 */
function normalizeSource(source: string): string {
  if (source === '' || source.startsWith('session-')) return source
  return BARE_SESSION_ID.test(source) ? `session-${source}` : source
}

// ── "where did this come from" excerpt ─────────────────────────────────────
//
// dsh 0.2 exposes no way to open a Session *at a position* (uiWorkspace's
// navigation state is only { sessionId, subagentAddress }, the conversation
// service has no scroll, and the transcript has no URL deep link), so the
// sidebar cannot scroll the user back to the moment an item was recorded.
// Instead this half reads the source Session's log and hands the browser half
// a compact excerpt of that moment, which it renders inline.

/** One line of the excerpt, in the order it happened. */
interface ContextLine {
  /** `you` = the human request, `agent` = assistant prose, `tool` = a tool call. */
  role: 'you' | 'agent' | 'tool'
  text: string
}

/** Structural view of a Session event; unknown shapes are skipped, never thrown on. */
interface LooseEvent {
  seq?: unknown
  time?: unknown
  type?: unknown
  data?: unknown
}

const CONTEXT_PROMPT_MAX = 280
const CONTEXT_AGENT_MAX = 200
const CONTEXT_AGENT_LINES = 2
const CONTEXT_TOOL_LINES = 6

/** Collapse whitespace and clip to `max` characters (ellipsis included). */
function clip(value: string, max: number): string {
  const flat = value.replace(/\s+/gu, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/** Join the text blocks of one content array; reasoning and unknown blocks are dropped. */
function contentText(value: unknown): string {
  if (!Array.isArray(value)) return ''
  const parts: string[] = []
  for (const block of value) {
    if (typeof block !== 'object' || block === null) continue
    const candidate = block as { type?: unknown; text?: unknown }
    if (candidate.type === 'text' && typeof candidate.text === 'string') parts.push(candidate.text)
  }
  return parts.join('\n').trim()
}

function eventTime(event: LooseEvent): number | null {
  if (typeof event.time !== 'string') return null
  const parsed = Date.parse(event.time)
  return Number.isNaN(parsed) ? null : parsed
}

function eventData(event: LooseEvent): Record<string, unknown> {
  return typeof event.data === 'object' && event.data !== null ? event.data as Record<string, unknown> : {}
}

/**
 * Build the excerpt for one item from its source Session's event log.
 *
 * The anchor is the last event recorded at or before the item's `createdAt`
 * (the item is written inside the turn that earned it, so the human request
 * that caused it is the nearest `user/message` before that point). Only the
 * turn's own slice is read — later messages in the Session are irrelevant.
 * @param events - complete event log of the source Session, ascending.
 * @param createdAt - the item's creation instant (ISO 8601).
 * @returns the 1-based turn number and the excerpt lines.
 */
function buildExcerpt(events: readonly LooseEvent[], createdAt: string): { turn: number; lines: ContextLine[] } {
  const at = Date.parse(createdAt)
  let anchor = -1
  if (!Number.isNaN(at)) {
    for (let index = 0; index < events.length; index += 1) {
      const time = eventTime(events[index] as LooseEvent)
      if (time === null) continue
      if (time > at) break
      anchor = index
    }
  }
  if (anchor < 0) anchor = events.length === 0 ? -1 : 0

  let turn = 0
  for (let index = 0; index <= anchor; index += 1) {
    if ((events[index] as LooseEvent).type === 'turn/start') turn += 1
  }

  // Nearest human request at or before the anchor: the one that earned the item.
  let prompt = ''
  let promptIndex = -1
  for (let index = anchor; index >= 0; index -= 1) {
    const event = events[index] as LooseEvent
    if (event.type !== 'user/message') continue
    const text = contentText(eventData(event).content)
    if (text.length === 0) continue
    prompt = text
    promptIndex = index
    break
  }

  const lines: ContextLine[] = []
  if (prompt.length > 0) lines.push({ role: 'you', text: clip(prompt, CONTEXT_PROMPT_MAX) })

  let agentLines = 0
  let toolLines = 0
  const seenTools = new Set<string>()
  for (let index = promptIndex + 1; index <= anchor; index += 1) {
    const event = events[index] as LooseEvent
    if (event.type === 'assistant/message' && agentLines < CONTEXT_AGENT_LINES) {
      const data = eventData(event)
      const message = typeof data.message === 'object' && data.message !== null ? data.message as Record<string, unknown> : {}
      const text = contentText(message.content)
      if (text.length > 0) {
        lines.push({ role: 'agent', text: clip(text, CONTEXT_AGENT_MAX) })
        agentLines += 1
      }
      continue
    }
    if (event.type === 'tool/call' && toolLines < CONTEXT_TOOL_LINES) {
      const toolName = String(eventData(event).name ?? '')
      if (toolName === '' || seenTools.has(toolName)) continue
      seenTools.add(toolName)
      lines.push({ role: 'tool', text: toolName })
      toolLines += 1
    }
  }
  return { turn, lines }
}

/**
 * System-prompt section registered for every session: the trigger discipline
 * that turns "mentioned in prose" into "recorded in the inbox". Registered
 * in the tool-guidance band (after the read/write tool sections, before the
 * SDK section) so it lands next to the tool catalog it governs.
 */
const INBOX_PROMPT_SECTION = {
  name: 'todo-inbox:discipline',
  order: 1600,
  text:
    '## Global todo inbox\n'
    + 'A cross-session inbox of actions waiting on the human, shown in the sidebar.\n'
    + 'Add an item only when the human must act OUTSIDE this session and the item outlives it: merge an MR, '
    + 'approve or publish an order, grant a permission or quota, release, or roll back after a future event.\n'
    + 'Never add a question or choice you are raising in this turn, a step you will do yourself, or in-session '
    + 'progress — those stay in the conversation or in `todo_write`. The inbox is not a decision diary.\n'
    + '- `inbox_list` first. If a pending item already covers the same action, rewrite it with `inbox_update` '
    + 'rather than adding a near-duplicate.\n'
    + '- `inbox_add` one item per distinct human action: title = one short action phrase (under ~40 characters, '
    + 'e.g. "merge MR !1234"); reasoning, evidence and ids go in `detail`, the URL in `link`. The sidebar '
    + 'truncates long titles, so a paragraph there is unreadable.\n'
    + '- `inbox_done` once the human confirms it is handled, or to close an item that went stale.',
}

export function apply(ctx: Context, config?: TodoInboxConfig): void {
  const dataPath = typeof config?.dataPath === 'string' && config.dataPath.length > 0
    ? config.dataPath
    : join(homedir(), '.dsh', 'todo-inbox.json')

  // In-memory cache over the authoritative file. All reads/writes go through
  // one promise chain so no read-modify-write interleaves.
  let items: InboxItem[] = []
  let lastSeen = ''
  let chain: Promise<void> = Promise.resolve()

  const validItem = (x: unknown): x is InboxItem =>
    typeof x === 'object' && x !== null
    && typeof (x as InboxItem).id === 'string'
    && typeof (x as InboxItem).title === 'string'
    && (x as InboxItem).title.length > 0

  async function loadFromDisk(): Promise<void> {
    let text: string
    try {
      text = await readFile(dataPath, 'utf8')
    } catch {
      // File absent or unreadable: empty inbox.
      lastSeen = ''
      items = []
      return
    }
    lastSeen = text
    try {
      const parsed: unknown = JSON.parse(text)
      if (typeof parsed === 'object' && parsed !== null && Array.isArray((parsed as { items?: unknown }).items)) {
        items = ((parsed as { items: unknown[] }).items).filter(validItem).map((item) => ({
          ...item,
          source: normalizeSource(item.source),
        }))
      } else {
        items = []
      }
    } catch (error) {
      console.error(`[todo-inbox] data file parse failed, skipping: ${dataPath}`, error)
      items = []
    }
  }

  async function persist(): Promise<void> {
    const text = JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), items }, null, 2)
    await writeFile(dataPath, text, 'utf8')
    lastSeen = text
  }

  function enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = chain.then(fn)
    chain = run.then(() => undefined, () => undefined)
    return run
  }

  function pendingItems(): InboxItem[] {
    return items.filter((item) => item.doneAt === null)
  }

  function pendingCount(): number {
    return pendingItems().length
  }

  function compact(item: InboxItem): InboxItem {
    return { ...item }
  }

  function nextId(): string {
    return `i${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  }

  function sourceOf(exec: unknown): string {
    try {
      const agent = (exec as { agent?: { sessionId?: string; id?: string } } | undefined)?.agent
      const raw = String(agent?.sessionId ?? agent?.id ?? '')
      // Canonicalize to the prefixed session id `sessions.open()` expects
      // (the client list uses the persisted `header.id`).
      return normalizeSource(raw)
    } catch {
      return ''
    }
  }

  const renderJson = (_args: unknown, value: unknown) => [{
    type: 'text' as const,
    text: JSON.stringify(value, null, 2),
  }]

  // The discipline section: tools alone do not fire reliably — a model that
  // mentions "roll back after X" in prose may never think to call inbox_add.
  // One short prompt section makes the trigger explicit for every session.
  ctx.effect(() => ctx.systemPrompt.section(INBOX_PROMPT_SECTION))

  // ── model-facing tools ────────────────────────────────────────────────────

  ctx.tools.register(defineTool({
    name: 'inbox_add',
    description:
      'Record one action waiting on the human that outlives this session (merge '
      + 'MR, approve or publish a work order, grant a permission or quota, review, '
      + 'release, roll back after a future event). Do NOT record a question or '
      + 'choice still being raised in this turn, an in-session step, or work you '
      + 'will do yourself. Call `inbox_list` first: if a pending item already '
      + 'covers the same action, use `inbox_update` instead of adding a duplicate. '
      + 'Any session can add; the user sees every pending item in the sidebar.',
    parameters: {
      type: {
        type: 'string',
        enum: ['merge-mr', 'approve-order', 'review', 'release', 'other'],
        description: 'Item type',
      },
      title: { type: 'string', required: true, description: 'Short action phrase, under ~40 characters, e.g. "merge MR !1234"; put reasoning and evidence in detail' },
      detail: { type: 'string', description: 'Optional extra context' },
      link: { type: 'string', description: 'Optional link, e.g. the MR / work-order URL' },
      due: { type: 'string', description: 'Optional ISO 8601 deadline, e.g. 2026-09-08T10:00:00+08:00' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        ok: { type: 'boolean', required: true },
        id: { type: 'string' },
        pending: { type: 'integer', required: true },
      } },
      render: renderJson,
    },
    execute(args: { title?: string; type?: string; detail?: string; link?: string; due?: string }, exec) {
      const title = String(args.title ?? '').trim()
      if (title.length === 0) return Promise.resolve({ ok: false, pending: pendingCount() })
      const item: InboxItem = {
        id: nextId(),
        type: args.type ?? 'other',
        title,
        detail: args.detail ? String(args.detail) : '',
        link: args.link ? String(args.link) : '',
        dueAt: args.due ? String(args.due) : null,
        createdAt: new Date().toISOString(),
        source: sourceOf(exec),
        doneAt: null,
      }
      return enqueue(async () => {
        items.push(item)
        await persist()
        return { ok: true, id: item.id, pending: pendingCount() }
      })
    },
    presentCall: args => ({ card: 'generic', title: 'Add inbox item', kind: 'other', rawInput: args.title }),
  }))

  ctx.tools.register(defineTool({
    name: 'inbox_update',
    description:
      'Rewrite fields of one existing global inbox item in place, keeping its id '
      + 'and creation time. Use this instead of `inbox_add` when a pending item '
      + 'already covers the same human action and only its wording, evidence, type, '
      + 'link or deadline changed — revising an item must never leave a second, '
      + 'near-identical entry behind. Omitted fields stay untouched; pass an empty '
      + 'string to clear detail, link or due.',
    parameters: {
      id: { type: 'string', required: true, description: 'Item id (from inbox_list)' },
      title: { type: 'string', description: 'Replacement short action phrase, under ~40 characters' },
      type: {
        type: 'string',
        enum: ['merge-mr', 'approve-order', 'review', 'release', 'other'],
        description: 'Replacement item type',
      },
      detail: { type: 'string', description: 'Replacement context; an empty string clears it' },
      link: { type: 'string', description: 'Replacement URL; an empty string clears it' },
      due: { type: 'string', description: 'Replacement ISO 8601 deadline; an empty string clears it' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        ok: { type: 'boolean', required: true },
        id: { type: 'string' },
        pending: { type: 'integer', required: true },
        error: { type: 'string' },
      } },
      render: renderJson,
    },
    execute(args: { id?: string; title?: string; type?: string; detail?: string; link?: string; due?: string }) {
      const id = String(args.id ?? '')
      const title = args.title === undefined ? undefined : String(args.title).trim()
      if (title !== undefined && title.length === 0) {
        return Promise.resolve({ ok: false, id, pending: pendingCount(), error: 'empty_title' })
      }
      return enqueue(async () => {
        const item = items.find((candidate) => candidate.id === id)
        if (item === undefined) return { ok: false, id, pending: pendingCount(), error: 'not_found' }
        if (title !== undefined) item.title = title
        if (args.type !== undefined) item.type = String(args.type)
        if (args.detail !== undefined) item.detail = String(args.detail)
        if (args.link !== undefined) item.link = String(args.link)
        if (args.due !== undefined) {
          const due = String(args.due)
          item.dueAt = due.length > 0 ? due : null
        }
        await persist()
        return { ok: true, id, pending: pendingCount() }
      })
    },
    presentCall: args => ({ card: 'generic', title: 'Update inbox item', kind: 'other', rawInput: args.id }),
  }))

  ctx.tools.register(defineTool({
    name: 'inbox_done',
    description: 'Mark one global inbox item as done.',
    parameters: {
      id: { type: 'string', required: true, description: 'Item id (from inbox_list)' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        ok: { type: 'boolean', required: true },
        id: { type: 'string' },
        pending: { type: 'integer', required: true },
        error: { type: 'string' },
      } },
      render: renderJson,
    },
    execute(args: { id?: string }) {
      const id = String(args.id ?? '')
      return enqueue(async () => {
        const item = items.find((candidate) => candidate.id === id)
        if (item === undefined) return { ok: false, id, pending: pendingCount(), error: 'not_found' }
        item.doneAt = new Date().toISOString()
        await persist()
        return { ok: true, id, pending: pendingCount() }
      })
    },
    presentCall: args => ({ card: 'generic', title: 'Done inbox item', kind: 'other', rawInput: args.id }),
  }))

  ctx.tools.register(defineTool({
    name: 'inbox_list',
    description: 'List every pending item in the GLOBAL todo inbox (across all sessions).',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        ok: { type: 'boolean', required: true },
        pending: { type: 'integer', required: true },
        items: { type: 'array', items: { type: 'object', additionalProperties: true } },
      } },
      render: renderJson,
    },
    execute() {
      // Fresh object literals (not the named interface) so the schema-inferred
      // Record<string, JsonValue>[] return type is satisfied without casts.
      return Promise.resolve({
        ok: true,
        pending: pendingCount(),
        items: pendingItems().map((item) => ({
          id: item.id,
          type: item.type,
          title: item.title,
          detail: item.detail,
          link: item.link,
          dueAt: item.dueAt,
          createdAt: item.createdAt,
          source: normalizeSource(item.source),
          doneAt: item.doneAt,
        })),
      })
    },
    presentCall: () => ({ card: 'generic', title: 'List inbox items', kind: 'other', rawInput: 'pending' }),
  }))

  // ── browser-half HTTP bridge ──────────────────────────────────────────────

  function fence(req: IncomingMessage): boolean {
    const origin = req.headers.origin
    if (origin === undefined) return true // non-browser clients (curl, agents)
    try {
      return new URL(origin).host === (req.headers.host ?? '')
    } catch {
      return false
    }
  }

  async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
    let body = ''
    for await (const chunk of req) body += chunk
    if (body.length === 0) return {}
    try {
      const parsed: unknown = JSON.parse(body)
      return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : {}
    } catch {
      throw new Error('invalid json body')
    }
  }

  function writeJson(res: ServerResponse, status: number, value: unknown): void {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(value))
  }

  /**
   * Build the "where did this come from" excerpt for one item.
   *
   * The source Session log is read through the optional `sessionQuery` service
   * (mounted by dsh-session-query-sqlite, part of the base bundle). It is taken
   * lazily with `ctx.get` rather than declared in `inject`, so a profile without
   * session-query still loads this plugin — the excerpt then reports
   * `unavailable` instead of taking the whole plugin tree down. Every other
   * failure mode also degrades to an explicit code, never a thrown request.
   */
  async function contextFor(id: string): Promise<Record<string, unknown>> {
    const item = items.find((candidate) => candidate.id === id)
    if (item === undefined) return { ok: false, error: 'not_found' }
    const sessionId = normalizeSource(item.source)
    if (!sessionId.startsWith('session-')) return { ok: false, error: 'no_session' }
    const query = (ctx as unknown as { get?: (name: string) => unknown }).get?.('sessionQuery') as
      { readSession?: (sessionId: string) => Promise<{ events?: unknown }> } | undefined
    if (query === undefined || typeof query.readSession !== 'function') return { ok: false, error: 'unavailable' }

    let events: readonly LooseEvent[]
    try {
      const log = await query.readSession(sessionId)
      events = Array.isArray(log.events) ? log.events as readonly LooseEvent[] : []
    } catch {
      return { ok: false, error: 'unreadable' }
    }
    if (events.length === 0) return { ok: false, error: 'no_history' }

    const excerpt = buildExcerpt(events, item.createdAt)
    return {
      ok: true,
      id,
      sessionId,
      createdAt: item.createdAt,
      turn: excerpt.turn,
      lines: excerpt.lines,
    }
  }

  const apiHandler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!fence(req)) {
      writeJson(res, 403, { ok: false, error: 'forbidden' })
      return
    }
    const pathname = new URL(req.url ?? '/', 'http://dsh.local').pathname
    const method = pathname.slice(API_PREFIX.length + 1) // '/todo-inbox/api/<method>'
    try {
      if (req.method === 'GET' && method === 'context') {
        const id = new URL(req.url ?? '/', 'http://dsh.local').searchParams.get('id') ?? ''
        writeJson(res, 200, await contextFor(id))
        return
      }
      if (req.method === 'GET' && method === 'items') {
        writeJson(res, 200, { ok: true, pending: pendingCount(), items: pendingItems().map(compact), path: dataPath })
        return
      }
      if (req.method === 'POST' && method === 'done') {
        const args = await readBody(req)
        const id = String(args.id ?? '')
        writeJson(res, 200, await enqueue(async () => {
          const item = items.find((candidate) => candidate.id === id)
          if (item === undefined) return { ok: false, error: 'not_found', pending: pendingCount() }
          item.doneAt = new Date().toISOString()
          await persist()
          return { ok: true, id, pending: pendingCount() }
        }))
        return
      }
      if (req.method === 'POST' && method === 'remove') {
        const args = await readBody(req)
        const id = String(args.id ?? '')
        writeJson(res, 200, await enqueue(async () => {
          const before = items.length
          items = items.filter((candidate) => candidate.id !== id)
          if (items.length === before) return { ok: false, error: 'not_found', pending: pendingCount() }
          await persist()
          return { ok: true, id, pending: pendingCount() }
        }))
        return
      }
      if (req.method === 'POST' && method === 'add') {
        const args = await readBody(req)
        const title = String(args.title ?? '').trim()
        if (title.length === 0) {
          writeJson(res, 400, { ok: false, error: 'empty_title', pending: pendingCount() })
          return
        }
        const item: InboxItem = {
          id: nextId(),
          type: typeof args.type === 'string' ? args.type : 'other',
          title,
          detail: typeof args.detail === 'string' ? args.detail : '',
          link: typeof args.link === 'string' ? args.link : '',
          dueAt: typeof args.due === 'string' ? args.due : null,
          createdAt: new Date().toISOString(),
          source: 'api',
          doneAt: null,
        }
        writeJson(res, 200, await enqueue(async () => {
          items.push(item)
          await persist()
          return { ok: true, id: item.id, pending: pendingCount() }
        }))
        return
      }
      writeJson(res, 404, { ok: false, error: 'not_found' })
    } catch (error) {
      writeJson(res, 500, { ok: false, error: String(error) })
    }
  }

  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: API_PREFIX, handler: apiHandler }))

  // ── durability: initial load, then poll for external file edits ──────────

  ctx.effect(() => {
    const timer = setInterval(() => {
      void enqueue(async () => {
        let text: string
        try {
          text = await readFile(dataPath, 'utf8')
        } catch {
          return
        }
        if (text !== lastSeen) await loadFromDisk()
      })
    }, 5000)
    return () => clearInterval(timer)
  })

  chain = chain.then(loadFromDisk)
}
