/**
 * dsh-todo-inbox browser half: the global inbox, embedded in the sidebar.
 *
 * Wide sidebar: a collapsible section stacked above Settings — a header row
 * (checklist glyph + label + count badge) and an inline list of pending
 * items with hover-revealed icon actions. Rail sidebar: the standard 36×36
 * circle button with a corner badge; clicking it expands the sidebar (the
 * rail has no room for a list).
 *
 * All state lives in a module-level store, so the sidebar's wide↔rail
 * crossfade (which remounts the slot occupant) never loses data or
 * expansion. Polling starts once at apply time.
 *
 * `detail` renders a tiny safe markdown subset (bold / italic / inline code /
 * [text](url) / bare URLs / line breaks) as React elements — never raw HTML.
 *
 * The bundle is compiled to a window.__ModuleLoader__ closure; react and the
 * ui-primitives icons resolve through the module table at runtime, so this
 * file must not runtime-import anything else (type-only imports are erased).
 *
 * @module dsh-todo-inbox/client
 */

import React from 'react'
import {
  IconChecklistOutline14,
  IconCheckOutline16,
  IconCloseOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'

export const name = 'todo-inbox-client'
export const inject = ['slots', 'sessions', 'layout']

/** Structural typing only — the loader supplies the real slot registry. */
interface SlotBridge {
  inject(slot: string, factory: () => unknown): void
  register(options: { name: string; id?: string }, component: unknown): unknown
}
/** Structural typing for the sessions service we use: open a session by id. */
interface SessionsBridge {
  open(id: string): void
}
/** Structural typing for the layout service we use: expand the sidebar. */
interface LayoutBridge {
  toggleSidebar(): void
}
interface ClientCtx {
  effect(callback: () => void | (() => void)): void
  slots: SlotBridge
  sessions: SessionsBridge
  layout: LayoutBridge
}

const API = '/todo-inbox/api'

/**
 * Design notes:
 * - The inline section mirrors the sidebar's own geometry: the header row
 *   uses the Settings trigger's padding/gap/text (8px gap, 14px label), rows
 *   use the 8px hover-radius family, and every color is a semantic alias
 *   token with a light-dark() fallback.
 * - Rows show a one-line title; detail (markdown-rendered) clamps to two
 *   lines; actions are icon buttons revealed on row hover / focus-within.
 * - The rail-mode panel is a menu surface (--dsw-specific-menu + l4 stroke
 *   ring + prominent shadow, the ContextMeter recipe), draggable by its
 *   header, with a 200ms rise-and-fade entrance.
 */
const CSS = `
  .tib-root { position: relative; }
  .tib-root.wide { width: calc(100% + 4px); margin: 4px -2px; }
  .tib-root.rail { width: 36px; margin: 8px 0 10px; }

  /* ── wide mode: inline section ─────────────────────────────────────── */
  .tib-section { padding-top: 2px; }
  .tib-section-head {
    display: flex; align-items: center; gap: 8px; width: 100%;
    height: 32px; padding: 0 10px 0 8px; box-sizing: border-box;
    border: none; border-radius: 10px; background: transparent; cursor: pointer;
    color: var(--dsw-alias-label-primary, light-dark(#333, #ccc));
    font-family: inherit; font-size: 14px; line-height: 22px;
  }
  .tib-section-head:hover {
    background: var(--dsw-alias-interactive-bg-hover, light-dark(rgba(0,0,0,.05), rgba(255,255,255,.07)));
  }
  .tib-head-icon { flex: none; display: grid; place-items: center; color: var(--dsw-alias-label-secondary, light-dark(#555, #bbb)); }
  .tib-head-label { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .tib-chevron { /* unused: header matches the plain icon+label Settings row */ }
    margin-left: auto; flex: none; display: grid; place-items: center;
    color: var(--dsw-alias-label-tertiary, light-dark(#888, #999));
  }
  .tib-badge {
    min-width: 18px; padding: 0 6px; height: 16px; line-height: 16px;
    border-radius: 999px; text-align: center; font-size: 11px; font-weight: 600;
    background: var(--dsw-alias-brand-primary, light-dark(#4259d1, #7a9bff));
    color: var(--dsw-alias-brand-primary-invert, #fff);
  }
  .tib-list-inline {
    max-height: min(260px, 32vh); overflow-y: auto; padding: 2px 2px 4px;
  }
  .tib-empty-inline {
    padding: 8px 10px; font-size: .88em;
    color: var(--dsw-alias-label-tertiary, light-dark(#888, #999));
  }
  .tib-row { padding: 5px 8px 5px 32px; border-radius: 8px; }
  .tib-row:hover {
    background: var(--dsw-alias-interactive-bg-hover, light-dark(rgba(0,0,0,.04), rgba(255,255,255,.06)));
  }
  .tib-row-top { display: flex; align-items: center; gap: 4px; }
  .tib-row-title {
    flex: 1; min-width: 0; font-weight: 500; overflow: hidden;
    text-overflow: ellipsis; white-space: nowrap;
  }
  a.tib-row-title { color: inherit; text-decoration: none; }
  a.tib-row-title:hover { color: var(--dsw-alias-link, light-dark(#1a73e8, #8ab4f8)); }
  .tib-row-actions {
    display: flex; gap: 2px; flex: none;
    opacity: 0; transition: opacity 120ms ease;
  }
  .tib-row:hover .tib-row-actions, .tib-row:focus-within .tib-row-actions { opacity: 1; }
  .tib-icon-btn {
    display: grid; place-items: center; width: 28px; height: 28px; padding: 0;
    border: none; border-radius: 50%; corner-shape: round;
    background: transparent; cursor: pointer;
    color: var(--dsw-alias-label-tertiary, light-dark(#777, #999));
  }
  .tib-icon-btn:hover {
    background: var(--dsw-alias-interactive-bg-hover, light-dark(rgba(0,0,0,.05), rgba(255,255,255,.07)));
    color: var(--dsw-alias-label-primary, light-dark(#222, #eee));
  }
  .tib-icon-btn.danger:hover {
    color: var(--dsw-alias-state-error-primary, light-dark(#d93025, #f28b82));
    background: var(--dsw-alias-interactive-bg-hover-danger, transparent);
  }
  .tib-row-detail {
    margin-top: 1px; font-size: .86em; line-height: 1.45;
    color: var(--dsw-alias-label-secondary, light-dark(#555, #bbb));
    white-space: pre-wrap; word-break: break-word;
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
  }
  .tib-row-detail-session { cursor: pointer; }
  .tib-row-detail-session:hover { color: var(--dsw-alias-label-primary, light-dark(#333, #ccc)); }
  .tib-row-meta {
    margin-top: 2px; font-size: .8em; letter-spacing: .01em;
    color: var(--dsw-alias-label-tertiary, light-dark(#999, #888));
  }
  .tib-link { color: var(--dsw-alias-link, light-dark(#1a73e8, #8ab4f8)); text-decoration: none; }
  .tib-link:hover { text-decoration: underline; }
  .tib-code {
    font-family: var(--ds-font-family-code, ui-monospace, monospace);
    font-size: .92em; padding: 0 4px; border-radius: 4px;
    background: var(--dsw-alias-bg-base, light-dark(#f0f0f0, #333));
  }

  /* ── rail mode: circle button only (click expands the sidebar) ─────── */
  .tib-bell {
    display: flex; align-items: center; justify-content: center;
    width: 36px; height: 36px; padding: 0;
    border: none; border-radius: 50%; corner-shape: round;
    background: transparent; cursor: pointer;
    color: var(--dsw-alias-label-primary, light-dark(#333, #ccc));
  }
  .tib-bell:hover {
    background: var(--dsw-alias-interactive-bg-hover, light-dark(rgba(0,0,0,.05), rgba(255,255,255,.07)));
  }
  .tib-bell .tib-badge {
    position: absolute; top: 1px; right: 1px;
    min-width: 14px; height: 14px; line-height: 14px; padding: 0 4px; font-size: 9px;
  }
`

interface InboxItem {
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

interface ListPayload {
  ok: boolean
  pending: number
  items: InboxItem[]
  path?: string
}

async function listItems(): Promise<ListPayload> {
  const response = await fetch(`${API}/items`)
  if (!response.ok) throw new Error(`inbox list failed: ${response.status}`)
  const payload = await response.json() as ListPayload
  return payload
}

async function mutate(method: 'done' | 'remove' | 'add', body: Record<string, unknown>): Promise<void> {
  const response = await fetch(`${API}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!response.ok) throw new Error(`inbox ${method} failed: ${response.status}`)
}

// ── tiny safe markdown subset (React elements only, no innerHTML) ──────────

function isSafeUrl(href: string): boolean {
  return /^(https?:|mailto:)/i.test(href)
}

/**
 * Render one detail string as React nodes. Supported: `inline code`, **bold**,
 * *italic*, [text](url), bare https?:// URLs, and line breaks (white-space:
 * pre-wrap). Anything unmatched renders as plain text — never HTML.
 * Exported for the smoke test; the loader only consumes name/inject/apply.
 */
export function renderDetail(text: string, keyBase: string): React.ReactNode[] {
  const out: React.ReactNode[] = []
  let rest = text
  let key = 0
  while (rest.length > 0) {
    const code = /^`([^`]+)`/.exec(rest)
    if (code !== null) {
      out.push(<code key={`${keyBase}-${key}`} className="tib-code">{code[1]}</code>)
      key += 1
      rest = rest.slice(code[0].length)
      continue
    }
    const link = /^\[([^\]]+)\]\(([^)\s]+)\)/.exec(rest)
    if (link !== null) {
      const href = link[2] ?? ''
      if (isSafeUrl(href)) {
        out.push(
          <a key={`${keyBase}-${key}`} className="tib-link" href={href} target="_blank" rel="noreferrer">{link[1]}</a>,
        )
      } else {
        out.push(link[0])
      }
      key += 1
      rest = rest.slice(link[0].length)
      continue
    }
    const bold = /^\*\*([^*]+)\*\*/.exec(rest)
    if (bold !== null) {
      out.push(<strong key={`${keyBase}-${key}`}>{renderDetail(bold[1] ?? '', `${keyBase}-${key}`)}</strong>)
      key += 1
      rest = rest.slice(bold[0].length)
      continue
    }
    const italic = /^\*([^*]+)\*/.exec(rest)
    if (italic !== null) {
      out.push(<em key={`${keyBase}-${key}`}>{renderDetail(italic[1] ?? '', `${keyBase}-${key}`)}</em>)
      key += 1
      rest = rest.slice(italic[0].length)
      continue
    }
    const url = /^https?:\/\/[^\s<>"')\]]+/.exec(rest)
    if (url !== null) {
      const href = url[0]
      out.push(<a key={`${keyBase}-${key}`} className="tib-link" href={href} target="_blank" rel="noreferrer">{href}</a>)
      key += 1
      rest = rest.slice(href.length)
      continue
    }
    // Plain text up to the next special character (backtick / star / bracket / URL).
    const nextSpecial = rest.search(/(`|\*|\[|https?:\/\/)/)
    if (nextSpecial <= 0) {
      // No marker (or a marker directly at 0 that none of the above matched —
      // e.g. an unmatched `*`): emit one character and keep going.
      out.push(rest.slice(0, 1))
      rest = rest.slice(1)
    } else {
      out.push(rest.slice(0, nextSpecial))
      rest = rest.slice(nextSpecial)
    }
  }
  return out
}

/** Jump to the session that recorded this item (source = session id). */
function openSourceSession(source: string): void {
  if (source === '' || inboxStore.sessions === null) return
  try {
    inboxStore.sessions.open(source)
  } catch (error) {
    console.error('[todo-inbox] open source session failed', error)
  }
}

// ── module-level store (survives sidebar remounts) ─────────────────────────

interface InboxStore {
  state: ListPayload
  loaded: boolean
  wide: boolean
  /** Wide-mode inline section expansion. */
  sectionOpen: boolean
}

const inboxStore: {
  current: InboxStore
  listeners: Set<() => void>
  /** Client sessions service, set at apply time; null in the smoke test. */
  sessions: SessionsBridge | null
  /** Client layout service, set at apply time; null in the smoke test. */
  layout: LayoutBridge | null
} = {
  current: {
    state: { ok: true, pending: 0, items: [] },
    loaded: false,
    wide: true,
    sectionOpen: true,
  },
  listeners: new Set(),
  sessions: null,
  layout: null,
}

function storeUpdate(patch: Partial<InboxStore>): void {
  inboxStore.current = { ...inboxStore.current, ...patch }
  for (const listener of inboxStore.listeners) listener()
}

function useInboxStore(): InboxStore {
  const [, force] = React.useReducer((x: number) => x + 1, 0)
  React.useEffect(() => {
    inboxStore.listeners.add(force)
    return () => { inboxStore.listeners.delete(force) }
  }, [])
  return inboxStore.current
}

let pollTimer: ReturnType<typeof setInterval> | null = null

async function refreshInbox(): Promise<void> {
  try {
    const payload = await listItems()
    storeUpdate({ state: payload, loaded: true })
  } catch (error) {
    console.error('[todo-inbox] list failed', error)
  }
}

function startPolling(): void {
  if (pollTimer !== null) return
  void refreshInbox()
  pollTimer = setInterval(() => { void refreshInbox() }, 10000)
}

async function act(method: 'done' | 'remove', id: string): Promise<void> {
  try {
    await mutate(method, { id })
  } catch (error) {
    console.error(`[todo-inbox] ${method} failed`, error)
  }
  void refreshInbox()
}

function itemMeta(item: InboxItem): string {
  return [
    item.type,
    item.source ? `来自 ${item.source}` : null,
    item.dueAt ? `截止 ${item.dueAt.replace('T', ' ').slice(0, 16)}` : null,
  ].filter(Boolean).join(' · ')
}

// ── wide mode: inline collapsible section ──────────────────────────────────

function InlineSection() {
  const { state, loaded, sectionOpen } = useInboxStore()
  return (
    <div className="tib-section">
      <button
        className="tib-section-head"
        onClick={() => storeUpdate({ sectionOpen: !sectionOpen })}
        title="待办"
      >
        <span className="tib-head-icon"><IconChecklistOutline14 size={16} /></span>
        <span className="tib-head-label">待办</span>
        {state.pending > 0 ? <span className="tib-badge">{String(state.pending)}</span> : null}
      </button>
      {sectionOpen ? (
        <div className="tib-list-inline">
          {!loaded ? (
            <div className="tib-empty-inline">加载中…</div>
          ) : state.items.length === 0 ? (
            <div className="tib-empty-inline">暂无</div>
          ) : (
            state.items.map((item) => {
              const meta = itemMeta(item)
              return (
                <div className="tib-row" key={item.id}>
                  <div className="tib-row-top">
                    {item.link ? (
                      <a className="tib-row-title" href={item.link} target="_blank" rel="noreferrer" title={item.title}>
                        {item.title}
                      </a>
                    ) : (
                      <span className="tib-row-title" title={item.title}>{item.title}</span>
                    )}
                    <span className="tib-row-actions">
                      <button
                        className="tib-icon-btn"
                        onClick={() => void act('done', item.id)}
                        title="完成"
                      >
                        <IconCheckOutline16 size={14} />
                      </button>
                      <button
                        className="tib-icon-btn danger"
                        onClick={() => void act('remove', item.id)}
                        title="删除"
                      >
                        <IconCloseOutline16 size={14} />
                      </button>
                    </span>
                  </div>
                  {item.detail ? (
                    <div
                      className="tib-row-detail tib-row-detail-session"
                      title="点击跳转到来源会话"
                      onClick={() => openSourceSession(item.source)}
                    >
                      {renderDetail(item.detail, item.id)}
                    </div>
                  ) : null}
                  {meta ? <div className="tib-row-meta">{meta}</div> : null}
                </div>
              )
            })
          )}
        </div>
      ) : null}
    </div>
  )
}

// ── rail mode: circle button; clicking expands the sidebar ─────────────────

function RailButton() {
  const { state } = useInboxStore()
  return (
    <button
      className="tib-bell"
      onClick={() => inboxStore.layout?.toggleSidebar()}
      title="待办（点击展开侧边栏）"
    >
      <IconChecklistOutline14 size={18} />
      {state.pending > 0 ? <span className="tib-badge">{String(state.pending)}</span> : null}
    </button>
  )
}

/** Slot occupant: pure view over the store; syncs the wide fact into it. */
function InboxAction(props: { wide?: boolean }) {
  const wide = Boolean(props.wide)
  React.useEffect(() => {
    if (inboxStore.current.wide !== wide) storeUpdate({ wide })
  }, [wide])
  return (
    <div className={`tib-root ${wide ? 'wide' : 'rail'}`}>
      {wide ? <InlineSection /> : <RailButton />}
    </div>
  )
}

export function apply(ctx: ClientCtx): void {
  inboxStore.sessions = ctx.sessions
  inboxStore.layout = ctx.layout
  ctx.effect(() => {
    if (typeof document === 'undefined') return
    if (document.querySelector('style[data-plugin-css="todo-inbox"]') !== null) return
    const tag = document.createElement('style')
    tag.dataset.pluginCss = 'todo-inbox'
    tag.textContent = CSS
    document.head.appendChild(tag)
  })

  ctx.effect(() => {
    if (typeof document === 'undefined') return
    startPolling()
    return () => {
      if (pollTimer !== null) { clearInterval(pollTimer); pollTimer = null }
    }
  })

  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register(
    { name: 'sidebar.footer.action', id: 'todo-inbox' },
    InboxAction,
  ))
}
