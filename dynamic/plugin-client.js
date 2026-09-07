// ============================================================
// todo-inbox — 全局待办收件箱（browser 半）
// 用法：作为 cordis_define 的 code.client。
// 符号环境：React / console / styles / host（无 window/document/fetch）。
// 纯 React.createElement，无 JSX / import。
// ============================================================

return {
  inject: ['slots', 'timer'],
  apply(ctx) {
    const slots = ctx.get('slots')
    if (slots === undefined) return

    styles.insert(`
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
    `)

    function InboxAction(props) {
      const [state, setState] = React.useState({ items: [], pending: 0, loaded: false })
      const [open, setOpen] = React.useState(false)

      const refresh = React.useCallback(async () => {
        try {
          const r = await host.call('inbox.list', null)
          setState({ items: r.items || [], pending: r.pending || 0, loaded: true })
        } catch (err) {
          console.error('[todo-inbox] list 失败', err)
        }
      }, [])

      React.useEffect(() => {
        refresh()
        const disposer = ctx.interval(refresh, 10000)
        return disposer
      }, [refresh])

      const act = async (method, id) => {
        try {
          await host.call(method, { id })
        } catch (err) {
          console.error('[todo-inbox]', method, '失败', err)
        }
        refresh()
      }

      const count = state.pending
      const wide = Boolean(props && props.wide)

      return React.createElement('div', { className: 'tib-root' },
        React.createElement('button', {
          className: 'tib-bell',
          onClick: () => setOpen(!open),
          title: '全局待办收件箱（跨会话）',
        },
          wide ? '待办' : '📋',
          count > 0
            ? React.createElement('span', { className: 'tib-badge' }, String(count))
            : null,
        ),
        open
          ? React.createElement('div', { className: 'tib-panel' },
            React.createElement('div', { className: 'tib-panel-head' },
              React.createElement('span', null, '待办收件箱' + (count > 0 ? '（' + count + '）' : '')),
              React.createElement('button', { className: 'tib-refresh', onClick: refresh }, '刷新'),
            ),
            React.createElement('div', { className: 'tib-list' },
              !state.loaded
                ? React.createElement('div', { className: 'tib-empty' }, '加载中…')
                : state.items.length === 0
                  ? React.createElement('div', { className: 'tib-empty' }, '暂无待办 🎉')
                  : state.items.map((item) => {
                    const meta = [
                      item.type,
                      item.source ? '来自 ' + item.source : null,
                      item.dueAt ? '截止 ' + String(item.dueAt).replace('T', ' ').slice(0, 16) : null,
                    ].filter(Boolean).join(' · ')
                    return React.createElement('div', { className: 'tib-item', key: item.id },
                      React.createElement('div', null,
                        React.createElement('div', { className: 'tib-item-title' }, item.title),
                        item.detail
                          ? React.createElement('div', { className: 'tib-item-meta' }, item.detail)
                          : null,
                        meta
                          ? React.createElement('div', { className: 'tib-item-meta' }, meta)
                          : null,
                      ),
                      React.createElement('div', { className: 'tib-item-actions' },
                        item.link
                          ? React.createElement('a', { className: 'tib-link', href: item.link, target: '_blank', rel: 'noreferrer' }, '打开')
                          : null,
                        React.createElement('button', { className: 'tib-done', onClick: () => act('inbox.done', item.id) }, '完成'),
                        React.createElement('button', { className: 'tib-rm', onClick: () => act('inbox.remove', item.id) }, '删除'),
                      ),
                    )
                  }),
            ),
          )
          : null,
      )
    }

    slots.inject('sidebar.footer.action', () => slots.register(
      { name: 'sidebar.footer.action', id: 'todo-inbox' },
      InboxAction,
    ))
  },
}
