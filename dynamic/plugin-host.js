// ============================================================
// todo-inbox — 全局待办收件箱（host 半）
// 用法：替换下方 DATA_PATH 后，作为 cordis_define 的 code.host。
// 约束：纯 JavaScript，无 import/require/TypeScript；不能访问
// process/window/globalThis 之外的环境；文件读写走注入的 fs 服务。
// ============================================================

// ── 配置：数据文件绝对路径（父目录必须存在）────────────────────
// 推荐 $HOME/.dsh/todo-inbox.json（$DSH_HOME 目录必然存在）。
// 由激活会话的 agent 用 bash 求出真实绝对路径后替换本行。
const DATA_PATH = '__INBOX_PATH__'

return {
  inject: ['fs', 'timer'],
  async apply(ctx) {
    const fs = ctx.fs

    // 内存态：items = [{ id, type, title, detail, link, dueAt, createdAt, source, doneAt|null }]
    // 数据文件是唯一权威；内存只是缓存。外部（其他会话的 agent 直接编辑文件）
    // 的改动由轮询拾取，插件自己的写入也先落盘再更新缓存。
    let items = []
    let lastSeen = '' // 最近一次读/写的文件内容，用于检测外部改动
    let chain = Promise.resolve() // 串行化读写，避免并发覆盖

    const target = await fs.resolve(DATA_PATH)

    const validItem = (x) =>
      x && typeof x === 'object' && typeof x.id === 'string'
      && typeof x.title === 'string' && x.title.length > 0

    async function loadFromDisk() {
      let text
      try {
        text = await fs.readText(target)
      } catch (err) {
        // 文件不存在或不可读：空收件箱
        lastSeen = ''
        items = []
        return
      }
      lastSeen = text
      try {
        const parsed = JSON.parse(text)
        if (parsed && Array.isArray(parsed.items)) {
          items = parsed.items.filter(validItem)
        } else {
          items = []
        }
      } catch (err) {
        console.error('todo-inbox: 数据文件解析失败，跳过', DATA_PATH, String(err))
        items = []
      }
    }

    async function persist() {
      const payload = { version: 1, updatedAt: new Date().toISOString(), items }
      const text = JSON.stringify(payload, null, 2)
      await fs.writeText(target, text)
      lastSeen = text
    }

    // 所有读写排进同一条链，避免读-改-写交错
    function enqueue(fn) {
      const run = chain.then(fn)
      chain = run.catch(() => {})
      return run
    }

    function pendingItems() {
      return items.filter((it) => !it.doneAt)
    }

    function pendingCount() {
      return pendingItems().length
    }

    // 只投影标量叶子字段（动态插件规范：不整体透传运行时对象）
    function compact(it) {
      return {
        id: it.id,
        type: it.type,
        title: it.title,
        detail: it.detail,
        link: it.link,
        dueAt: it.dueAt,
        createdAt: it.createdAt,
        source: it.source,
        doneAt: it.doneAt,
      }
    }

    function nextId() {
      return 'i' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8)
    }

    function sourceOf(exec) {
      try {
        if (exec && exec.agent) {
          return String(exec.agent.sessionId || exec.agent.id || '')
        }
      } catch (err) {}
      return ''
    }

    const renderJson = (args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }]

    const inboxAdd = harness.defineTool({
      name: 'inbox_add',
      description:
        '记录一条“等待人类处理”的全局待办（合并 MR、审批工单、评审、发布等）。'
        + '任何会话都能添加；用户会从侧边栏的待办收件箱面板看到全部待办。',
      parameters: {
        type: {
          type: 'string',
          enum: ['merge-mr', 'approve-order', 'review', 'release', 'other'],
          description: '待办类型',
        },
        title: { type: 'string', required: true, description: '一句话说明需要人类做什么，例如“合并 MR !1234”' },
        detail: { type: 'string', description: '补充说明（可选）' },
        link: { type: 'string', description: '相关链接，如 MR / 工单地址（可选）' },
        due: { type: 'string', description: '截止时间，ISO 8601 字符串（可选），如 2026-09-08T10:00:00+08:00' },
      },
      output: { schema: { type: 'object', additionalProperties: true }, render: renderJson },
      async execute(args, exec) {
        const title = String(args && args.title ? args.title : '').trim()
        if (!title) return { ok: false, error: 'empty_title', pending: pendingCount() }
        const item = {
          id: nextId(),
          type: (args && args.type) || 'other',
          title,
          detail: args && args.detail ? String(args.detail) : '',
          link: args && args.link ? String(args.link) : '',
          dueAt: args && args.due ? String(args.due) : null,
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
    })

    const inboxDone = harness.defineTool({
      name: 'inbox_done',
      description: '把一条全局待办标记为已完成。',
      parameters: {
        id: { type: 'string', required: true, description: '待办 id（来自 inbox_list）' },
      },
      output: { schema: { type: 'object', additionalProperties: true }, render: renderJson },
      async execute(args) {
        const id = args && args.id ? String(args.id) : ''
        return enqueue(async () => {
          const item = items.find((it) => it.id === id)
          if (!item) return { ok: false, error: 'not_found', pending: pendingCount() }
          item.doneAt = new Date().toISOString()
          await persist()
          return { ok: true, id, pending: pendingCount() }
        })
      },
    })

    const inboxList = harness.defineTool({
      name: 'inbox_list',
      description: '列出当前所有未完成的全局待办（跨会话收件箱）。',
      parameters: {},
      output: { schema: { type: 'object', additionalProperties: true }, render: renderJson },
      async execute() {
        return { ok: true, pending: pendingCount(), items: pendingItems().map(compact) }
      },
    })

    // 面板 RPC：browser 半通过 host.call(method, args) 调用
    harness.handle('inbox.list', async () => ({
      ok: true,
      pending: pendingCount(),
      items: pendingItems().map(compact),
      path: DATA_PATH,
    }))
    harness.handle('inbox.done', async (args) => {
      const id = args && args.id ? String(args.id) : ''
      return enqueue(async () => {
        const item = items.find((it) => it.id === id)
        if (!item) return { ok: false, error: 'not_found', pending: pendingCount() }
        item.doneAt = new Date().toISOString()
        await persist()
        return { ok: true, id, pending: pendingCount() }
      })
    })
    harness.handle('inbox.remove', async (args) => {
      const id = args && args.id ? String(args.id) : ''
      return enqueue(async () => {
        const before = items.length
        items = items.filter((it) => it.id !== id)
        if (items.length === before) return { ok: false, error: 'not_found', pending: pendingCount() }
        await persist()
        return { ok: true, id, pending: pendingCount() }
      })
    })

    harness.registerTool(ctx, inboxAdd)
    harness.registerTool(ctx, inboxDone)
    harness.registerTool(ctx, inboxList)

    // 启动：先加载，然后每 5 秒拾取外部改动（其他会话的 agent 直接编辑数据文件也能入库）
    await loadFromDisk()
    ctx.interval(async () => {
      await enqueue(async () => {
        let text
        try {
          text = await fs.readText(target)
        } catch (err) {
          return
        }
        if (text !== lastSeen) {
          await loadFromDisk()
        }
      })
    }, 5000)
  },
}
