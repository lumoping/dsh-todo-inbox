/**
 * dsh-todo-inbox browser half: the global inbox, embedded in the sidebar.
 *
 * Wide sidebar: a collapsible section stacked above Settings — a header row
 * (checklist glyph + label + count badge + chevron) and an inline list of
 * pending items with hover-revealed icon actions. Rail sidebar: the standard
 * 36×36 circle button with a corner badge, opening a floating panel (the
 * rail has no room for a list; the panel is the rail-mode fallback surface).
 *
 * All state lives in a module-level store, so the sidebar's wide↔rail
 * crossfade (which remounts the slot occupant) never loses data, expansion,
 * or panel position. Polling starts once at apply time.
 *
 * `detail` renders a tiny safe markdown subset (bold / italic / inline code /
 * [text](url) / bare URLs / line breaks) as React elements — never raw HTML.
 *
 * The bundle is compiled to a window.__ModuleLoader__ closure; react,
 * react-dom/client and the ui-primitives icons resolve through the module
 * table at runtime, so this file must not runtime-import anything else
 * (type-only imports are erased).
 *
 * @module dsh-todo-inbox/client
 */

import React from 'react'
import { createRoot } from 'react-dom/client'
import {
  IconChecklistOutline14,
  IconCheckOutline16,
  IconCloseOutline16,
  IconRightUpOutline16,
  IconRefreshOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'

export const name = 'todo-inbox-client'
export const inject = ['slots']

/** Structural typing only — the loader supplies the real slot registry. */
interface SlotBridge {
  inject(slot: string, factory: () => unknown): void
  register(options: { name: string; id?: string }, component: unknown): unknown
}
interface ClientCtx {
  effect(callback: () => void | (() => void)): void
  slots: SlotBridge
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
  .tib-row-actions {
    display: flex; gap: 2px; flex: none;
    opacity: 0; transition: opacity 120ms ease;
  }
  .tib-row:hover .tib-row-actions, .tib-row:focus-within .tib-row-actions { opacity: 1; }
  .tib-icon-btn {
    display: grid; place-items: center; width: 22px; height: 22px; padding: 0;
    border: none; border-radius: 6px; background: transparent; cursor: pointer;
    color: var(--dsw-alias-label-tertiary, light-dark(#777, #999));
  }
  .tib-icon-btn:hover {
    background: var(--dsw-alias-bg-base, light-dark(rgba(0,0,0,.06), rgba(255,255,255,.1)));
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

  /* ── rail mode: circle button + floating panel fallback ────────────── */
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
  .tib-panel {
    position: fixed; left: 64px; bottom: 16px; width: 380px; max-width: calc(100vw - 32px);
    z-index: 9999; overflow: hidden;
    font-size: var(--dsh-content-font-size, 14px); line-height: 1.5;
    border: 0; border-radius: 12px;
    background: var(--dsw-specific-menu, var(--dsw-alias-bg-layer-3, light-dark(#fff, #2a2a2c));
    color: var(--dsw-alias-label-primary, light-dark(#222, #eee));
    --dsw-elevation-stroke-color: var(--dsw-alias-border-l4, light-dark(rgba(0,0,0,.06), rgba(255,255,255,.09)));
    box-shadow: var(--dsw-elevation-prominent,
      0 0 0 0.5px var(--dsw-elevation-stroke-color),
      0 3px 8px 0 rgba(0,0,0,.04), 0 0 20px 0 rgba(0,0,0,.05));
    --dsh-scrollbar-thumb: var(--dsw-alias-scrollbar-bg-l2);
    --dsh-scrollbar-thumb-hover: var(--dsw-alias-scrollbar-hover-l2);
    animation: tib-in 200ms cubic-bezier(.2, .9, .3, 1.2);
  }
  @keyframes tib-in {
    from { opacity: 0; transform: translateY(10px) scale(.97); }
    to   { opacity: 1; transform: translateY(0) scale(1); }
  }
  .tib-panel-head {
    display: flex; align-items: center; justify-content: space-between;
    padding: 12px 14px 10px; cursor: grab; user-select: none;
    border-bottom: 0.5px solid var(--dsw-alias-border-l1, light-dark(#eee, #333));
  }
  .tib-panel-head:active { cursor: grabbing; }
  .tib-title { display: flex; align-items: center; gap: 7px; font-weight: 600; }
  .tib-count { font-weight: 500; font-size: .88em; color: var(--dsw-alias-label-tertiary, light-dark(#888, #999)); }
  .tib-head-actions { display: flex; align-items: center; gap: 2px; }
  .tib-refresh, .tib-close {
    border: 0; background: transparent; cursor: pointer; font-size: 1em; padding: 4px 6px;
    border-radius: 6px; color: var(--dsw-alias-label-tertiary, light-dark(#777, #999));
    line-height: 1; display: inline-flex; align-items: center;
  }
  .tib-refresh:hover, .tib-close:hover {
    background: var(--dsw-alias-interactive-bg-hover, light-dark(rgba(0,0,0,.05), rgba(255,255,255,.07)));
    color: var(--dsw-alias-label-primary, light-dark(#222, #eee));
  }
  .tib-scroll { max-height: min(480px, 62vh); overflow-y: auto; padding: 4px 8px; }
  .tib-empty {
    padding: 30px 12px; text-align: center;
    color: var(--dsw-alias-label-tertiary, light-dark(#888, #999));
  }
  .tib-item {
    padding: 11px 6px;
    border-bottom: 0.5px solid var(--dsw-alias-border-l1, light-dark(#f0f0f0, #313131));
  }
  .tib-item:last-child { border-bottom: 0; }
  .tib-item-title { font-weight: 600; word-break: break-word; line-height: 1.4; }
  .tib-item-detail {
    margin-top: 3px; white-space: pre-wrap; word-break: break-word; line-height: 1.5;
    color: var(--dsw-alias-label-secondary, light-dark(#444, #ccc));
  }
  .tib-item-meta {
    margin-top: 4px; font-size: .88em; letter-spacing: .01em;
    color: var(--dsw-alias-label-tertiary, light-dark(#888, #999));
  }
  .tib-item-footer { display: flex; justify-content: flex-end; align-items: center; gap: 8px; margin-top: 8px; }
  .tib-done, .tib-rm {
    border-radius: 999px; cursor: pointer; font-size: .88em; padding: 3px 12px;
    font-family: inherit; line-height: 1.5;
  }
  .tib-done {
    border: 0;
    background: var(--dsw-alias-brand-primary, light-dark(#4259d1, #7a9bff));
    color: var(--dsw-alias-brand-primary-invert, #fff);
  }
  .tib-done:hover { opacity: .88; }
  .tib-rm {
    border: 0.5px solid var(--dsw-alias-border-l2, light-dark(#ddd, #444));
    background: transparent;
    color: var(--dsw-alias-label-primary-dimmed, light-dark(#666, #aaa));
  }
  .tib-rm:hover {
    border-color: var(--dsw-alias-state-error-primary, light-dark(#d93025, #f28b82));
    color: var(--dsw-alias-state-error-primary, light-dark(#d93025, #f28b82));
    background: var(--dsw-alias-interactive-bg-hover-danger, transparent);
  }
  .tib-path {
    padding: 7px 14px 9px; font-size: .82em;
    color: var(--dsw-alias-label-tertiary, light-dark(#999, #777));
    border-top: 0.5px solid var(--dsw-alias-border-l1, light-dark(#eee, #333));
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

// ── module-level store (survives sidebar remounts) ─────────────────────────

interface PanelPos { x: number; y: number }

interface InboxStore {
  state: ListPayload
  loaded: boolean
  wide: boolean
  /** Wide-mode inline section expansion. */
  sectionOpen: boolean
  /** Rail-mode floating panel visibility. */
  panelOpen: boolean
  pos: PanelPos | null
}

const inboxStore: {
  current: InboxStore
  listeners: Set<() => void>
} = {
  current: {
    state: { ok: true, pending: 0, items: [] },
    loaded: false,
    wide: true,
    sectionOpen: true,
    panelOpen: false,
    pos: null,
  },
  listeners: new Set(),
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
        title="待办（跨会话全局收件箱）"
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
            <div className="tib-empty-inline">暂无待办 🎉</div>
          ) : (
            state.items.map((item) => {
              const meta = itemMeta(item)
              return (
                <div className="tib-row" key={item.id}>
                  <div className="tib-row-top">
                    <span className="tib-row-title" title={item.title}>{item.title}</span>
                    <span className="tib-row-actions">
                      {item.link ? (
                        <a
                          className="tib-icon-btn"
                          href={item.link}
                          target="_blank"
                          rel="noreferrer"
                          title="打开链接"
                        >
                          <IconRightUpOutline16 size={14} />
                        </a>
                      ) : null}
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
                    <div className="tib-row-detail">{renderDetail(item.detail, item.id)}</div>
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

// ── rail mode: circle button + floating panel fallback ─────────────────────

function RailButton() {
  const { state, panelOpen } = useInboxStore()
  return (
    <button
      className="tib-bell"
      onClick={() => storeUpdate({ panelOpen: !panelOpen })}
      title="全局待办收件箱（跨会话）"
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
    if (inboxStore.current.wide !== wide) {
      // Leaving rail mode closes the fallback panel.
      storeUpdate(wide ? { wide, panelOpen: false } : { wide })
    }
  }, [wide])
  return (
    <div className={`tib-root ${wide ? 'wide' : 'rail'}`}>
      {wide ? <InlineSection /> : <RailButton />}
    </div>
  )
}

/** The rail-mode floating panel (portal-mounted; never in the sidebar tree). */
function InboxPanel() {
  const { state, loaded, wide, panelOpen, pos } = useInboxStore()
  const panelRef = React.useRef<HTMLDivElement>(null)
  const dragRef = React.useRef<{ startX: number; startY: number; baseX: number; baseY: number; moved: boolean } | null>(null)

  const onHeaderPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('button') !== null) return
    const el = panelRef.current
    if (el === null) return
    const rect = el.getBoundingClientRect()
    dragRef.current = { startX: e.clientX, startY: e.clientY, baseX: rect.left, baseY: rect.top, moved: false }
    const onMove = (ev: PointerEvent): void => {
      const drag = dragRef.current
      if (drag === null) return
      const dx = ev.clientX - drag.startX
      const dy = ev.clientY - drag.startY
      if (!drag.moved && Math.abs(dx) < 4 && Math.abs(dy) < 4) return
      drag.moved = true
      storeUpdate({ pos: { x: drag.baseX + dx, y: drag.baseY + dy } })
    }
    const onUp = (): void => {
      dragRef.current = null
      document.removeEventListener('pointermove', onMove)
      document.removeEventListener('pointerup', onUp)
    }
    document.addEventListener('pointermove', onMove)
    document.addEventListener('pointerup', onUp)
  }

  if (!panelOpen || wide) return null
  const panelStyle: React.CSSProperties = pos !== null
    ? { left: pos.x, top: pos.y, right: 'auto', bottom: 'auto' }
    : {}

  return (
    <div className="tib-panel" ref={panelRef} style={panelStyle}>
      <div className="tib-panel-head" onPointerDown={onHeaderPointerDown}>
        <span className="tib-title">
          待办
          {state.pending > 0 ? <span className="tib-count">{String(state.pending)}</span> : null}
        </span>
        <span className="tib-head-actions">
          <button className="tib-refresh" onClick={() => void refreshInbox()} title="刷新">
            <IconRefreshOutline16 size={14} />
          </button>
          <button className="tib-close" onClick={() => storeUpdate({ panelOpen: false })} title="关闭">✕</button>
        </span>
      </div>
      <div className="tib-scroll">
        {!loaded ? (
          <div className="tib-empty">加载中…</div>
        ) : state.items.length === 0 ? (
          <div className="tib-empty">暂无待办 🎉</div>
        ) : (
          state.items.map((item) => {
            const meta = itemMeta(item)
            return (
              <div className="tib-item" key={item.id}>
                <div className="tib-item-title">{item.title}</div>
                {item.detail ? (
                  <div className="tib-item-detail">{renderDetail(item.detail, item.id)}</div>
                ) : null}
                {meta ? <div className="tib-item-meta">{meta}</div> : null}
                <div className="tib-item-footer">
                  {item.link
                    ? <a className="tib-link" href={item.link} target="_blank" rel="noreferrer">打开 ↗</a>
                    : null}
                  <button className="tib-rm" onClick={() => void act('remove', item.id)}>删除</button>
                  <button className="tib-done" onClick={() => void act('done', item.id)}>完成</button>
                </div>
              </div>
            )
          })
        )}
      </div>
      {state.path ? <div className="tib-path">数据文件：{state.path}</div> : null}
    </div>
  )
}

export function apply(ctx: ClientCtx): void {
  ctx.effect(() => {
    if (typeof document === 'undefined') return
    if (document.querySelector('style[data-plugin-css="todo-inbox"]') !== null) return
    const tag = document.createElement('style')
    tag.dataset.pluginCss = 'todo-inbox'
    tag.textContent = CSS
    document.head.appendChild(tag)
  })

  // The rail-mode panel is a React portal into document.body so it survives
  // the sidebar's wide/rail crossfade and is never clipped by sidebar layout.
  ctx.effect(() => {
    if (typeof document === 'undefined') return
    startPolling()
    const host = document.createElement('div')
    host.id = 'todo-inbox-panel-host'
    document.body.appendChild(host)
    const root = createRoot(host)
    root.render(<InboxPanel />)
    return () => {
      root.unmount()
      host.remove()
      if (pollTimer !== null) { clearInterval(pollTimer); pollTimer = null }
    }
  })

  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register(
    { name: 'sidebar.footer.action', id: 'todo-inbox' },
    InboxAction,
  ))
}
