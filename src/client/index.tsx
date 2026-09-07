/**
 * dsh-todo-inbox browser half: the global inbox panel.
 *
 * Registers a root-scope `sidebar.footer.action` (visible in every session):
 * a "待办" button with a pending-count badge that toggles a floating panel.
 * Data comes from the host half through plain HTTP routes under
 * /todo-inbox/api (fetch, same origin); the panel refreshes every 10s.
 *
 * The bundle is compiled to a window.__ModuleLoader__ closure; react and the
 * slots contract resolve through the module table at runtime, so this file
 * must not runtime-import anything else (type-only imports are erased).
 *
 * @module dsh-todo-inbox/client
 */

import React from 'react'

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

const CSS = `
  .tib-root { position: relative; color-scheme: light dark; font-size: 12px; }
  .tib-bell {
    display: flex; align-items: center; gap: 6px; width: 100%;
    padding: 8px 12px; border: 0; cursor: pointer; background: transparent;
    color: light-dark(#333, #ccc);
  }
  .tib-bell:hover { background: light-dark(rgba(0,0,0,.06), rgba(255,255,255,.08)); }
  .tib-badge {
    margin-left: auto; min-width: 18px; padding: 1px 5px; border-radius: 10px;
    text-align: center; font-size: 11px; font-weight: 600;
    background: light-dark(#d93025, #f28b82); color: #fff;
  }
  .tib-panel {
    position: fixed; right: 16px; bottom: 64px; width: 400px; max-width: calc(100vw - 32px);
    max-height: 60vh; overflow: auto; z-index: 9999;
    border: 1px solid light-dark(#ddd, #444);
    border-radius: 10px; box-shadow: 0 8px 30px rgba(0,0,0,.25);
    background: light-dark(#fff, #222); color: light-dark(#222, #eee);
  }
  .tib-panel-head {
    display: flex; align-items: center; justify-content: space-between;
    padding: 10px 12px; border-bottom: 1px solid light-dark(#eee, #333);
    font-weight: 600;
  }
  .tib-refresh { border: 0; background: transparent; cursor: pointer; color: inherit; font-size: 12px; }
  .tib-list { padding: 6px; }
  .tib-empty { padding: 18px 12px; text-align: center; color: light-dark(#888, #999); }
  .tib-item {
    display: flex; align-items: flex-start; justify-content: space-between; gap: 8px;
    padding: 8px 6px; border-bottom: 1px solid light-dark(#f0f0f0, #333);
  }
  .tib-item:last-child { border-bottom: 0; }
  .tib-item-title { font-weight: 600; word-break: break-word; }
  .tib-item-meta { margin-top: 2px; color: light-dark(#888, #999); font-size: 11px; }
  .tib-item-actions { display: flex; gap: 6px; flex-shrink: 0; }
  .tib-link { color: light-dark(#1a73e8, #8ab4f8); text-decoration: none; }
  .tib-done, .tib-rm {
    border: 1px solid light-dark(#ddd, #444); border-radius: 6px; cursor: pointer;
    background: transparent; color: inherit; font-size: 11px; padding: 2px 8px;
  }
  .tib-done:hover { border-color: #34a853; color: #34a853; }
  .tib-rm:hover { border-color: #d93025; color: #d93025; }
  .tib-path { padding: 6px 12px 10px; color: light-dark(#999, #777); font-size: 11px; }
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

function InboxAction(props: { wide?: boolean }) {
  const [state, setState] = React.useState<ListPayload>({ ok: true, pending: 0, items: [] })
  const [loaded, setLoaded] = React.useState(false)
  const [open, setOpen] = React.useState(false)

  const refresh = React.useCallback(async () => {
    try {
      const payload = await listItems()
      setState(payload)
      setLoaded(true)
    } catch (error) {
      console.error('[todo-inbox] list failed', error)
    }
  }, [])

  React.useEffect(() => {
    void refresh()
    const timer = setInterval(() => { void refresh() }, 10000)
    return () => clearInterval(timer)
  }, [refresh])

  const act = async (method: 'done' | 'remove', id: string): Promise<void> => {
    try {
      await mutate(method, { id })
    } catch (error) {
      console.error(`[todo-inbox] ${method} failed`, error)
    }
    void refresh()
  }

  const count = state.pending
  const wide = Boolean(props.wide)

  return (
    <div className="tib-root">
      <button
        className="tib-bell"
        onClick={() => setOpen(!open)}
        title="全局待办收件箱（跨会话）"
      >
        {wide ? '待办' : '📋'}
        {count > 0 ? <span className="tib-badge">{String(count)}</span> : null}
      </button>
      {open ? (
        <div className="tib-panel">
          <div className="tib-panel-head">
            <span>待办收件箱{count > 0 ? `（${String(count)}）` : ''}</span>
            <button className="tib-refresh" onClick={() => void refresh()}>刷新</button>
          </div>
          <div className="tib-list">
            {!loaded ? (
              <div className="tib-empty">加载中…</div>
            ) : state.items.length === 0 ? (
              <div className="tib-empty">暂无待办 🎉</div>
            ) : (
              state.items.map((item) => {
                const meta = [
                  item.type,
                  item.source ? `来自 ${item.source}` : null,
                  item.dueAt ? `截止 ${item.dueAt.replace('T', ' ').slice(0, 16)}` : null,
                ].filter(Boolean).join(' · ')
                return (
                  <div className="tib-item" key={item.id}>
                    <div>
                      <div className="tib-item-title">{item.title}</div>
                      {item.detail ? <div className="tib-item-meta">{item.detail}</div> : null}
                      {meta ? <div className="tib-item-meta">{meta}</div> : null}
                    </div>
                    <div className="tib-item-actions">
                      {item.link
                        ? <a className="tib-link" href={item.link} target="_blank" rel="noreferrer">打开</a>
                        : null}
                      <button className="tib-done" onClick={() => void act('done', item.id)}>完成</button>
                      <button className="tib-rm" onClick={() => void act('remove', item.id)}>删除</button>
                    </div>
                  </div>
                )
              })
            )}
          </div>
          {state.path ? <div className="tib-path">数据文件：{state.path}</div> : null}
        </div>
      ) : null}
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

  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register(
    { name: 'sidebar.footer.action', id: 'todo-inbox' },
    InboxAction,
  ))
}
