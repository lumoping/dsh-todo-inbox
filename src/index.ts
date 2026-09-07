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
    + 'When your work produces an action that waits on the human — merge an MR, approve a work order, '
    + 'review something, release, roll back after a future event, or any follow-up you name in your reply '
    + '("after X completes, do Y") — you MUST call `inbox_add` in the same turn. Never leave such an action '
    + 'only in prose: if you wrote it in the reply, it belongs in the inbox. Use `inbox_list` to check what '
    + 'is still pending, and `inbox_done` once the human confirms it is handled.',
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
        items = ((parsed as { items: unknown[] }).items).filter(validItem)
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
      return String(agent?.sessionId ?? agent?.id ?? '')
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
      'Record one item waiting on the human in the GLOBAL todo inbox (merge MR, '
      + 'approve work order, review, release, rollback after a future event...). '
      + 'TRIGGER RULE: whenever your reply names a future human action, call this '
      + 'tool in the same turn — never mention it only in prose. Any session can '
      + 'add; the user sees every pending item in the sidebar inbox section.',
    parameters: {
      type: {
        type: 'string',
        enum: ['merge-mr', 'approve-order', 'review', 'release', 'other'],
        description: 'Item type',
      },
      title: { type: 'string', required: true, description: 'One line saying what the human must do, e.g. "merge MR !1234"' },
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
      } },
      render: renderJson,
    },
    execute(args: { id?: string }) {
      const id = String(args.id ?? '')
      return enqueue(async () => {
        const item = items.find((candidate) => candidate.id === id)
        if (item === undefined) return { ok: false, pending: pendingCount() }
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
          source: item.source,
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

  const apiHandler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!fence(req)) {
      writeJson(res, 403, { ok: false, error: 'forbidden' })
      return
    }
    const pathname = new URL(req.url ?? '/', 'http://dsh.local').pathname
    const method = pathname.slice(API_PREFIX.length + 1) // '/todo-inbox/api/<method>'
    try {
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
