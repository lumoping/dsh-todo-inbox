# DSH 全局待办收件箱插件 todo-inbox/Global Todo Inbox Plugin

> **Contributors**: lumoping ｜ **最后更新**：2026-09-07 ｜ [GitHub](https://github.com/lumoping/dsh-todo-inbox/blob/main/README.md)

一个运行在 DeepSeek Harness Web GUI 上的**动态 Cordis 插件**：任何会话的 agent 都能登记"等待人类处理"的待办（合并 MR、审批工单、评审、发布等），用户在侧边栏底部的一个全局面板里查看、完成、删除——不再因为并行多个会话而漏掉某条待办。

## 文件清单/File Inventory

| 文件 | 作用 |
| --- | --- |
| `plugin-host.js` | 插件 host 半：持久化 + `inbox_add` / `inbox_done` / `inbox_list` 工具 + `inbox.list/done/remove` RPC + 5 秒轮询拾取外部文件改动 |
| `plugin-client.js` | 插件 browser 半：侧边栏底部"待办"按钮（角标计数）+ 全局浮层面板 |
| `activate-prompt.md` | 粘贴到 `cordis` preset 新会话的激活提示词（inspect → define → run → 验证） |

## 架构/Architecture

```
[任意会话的 agent]
   ├─ inbox_add / inbox_done / inbox_list（工具，若对当前 scope 可见）
   └─ 直接 read/write 编辑数据文件（通用回退，任何会话都可用）
              │
              ▼
   [数据文件 $HOME/.dsh/todo-inbox.json]  ← 唯一权威
              │  插件 host 半：写入落盘 + 5s 轮询拾取外部改动
              ▼
   [host 半] 内存缓存 + 串行化读写 → harness.handle RPC
              │  host.call('inbox.list' | 'inbox.done' | 'inbox.remove')
              ▼
   [browser 半] 侧边栏 footer.action（root scope，跨会话全局）
              按钮角标（未完成数）+ 面板（每 10s 轮询刷新）
```

- **Host 半**（`inject: ['fs', 'timer']`）：数据文件是唯一权威，内存只是缓存；所有读写走同一条 promise 链串行化，避免并发覆盖；自己的写入先落盘再更新缓存；每 5 秒读一次文件，内容变化即重新加载（外部会话的 agent 直接编辑文件也能入库）。
- **Browser 半**（`inject: ['slots', 'timer']`）：注册 `sidebar.footer.action`（list / root scope，跨会话全局可见），每 10 秒通过 `host.call('inbox.list')` 刷新；"完成/删除"通过 `inbox.done` / `inbox.remove` RPC 落盘。
- 数据文件为纯 JSON，任何 agent 都能读懂并追加（见下）。

## 数据文件格式/Data File Format

文件：`$HOME/.dsh/todo-inbox.json`（默认；激活时可改）

```json
{
  "version": 1,
  "updatedAt": "2026-09-07T09:00:00.000Z",
  "items": [
    {
      "id": "imtr00wpa-x0v54x",
      "type": "merge-mr",
      "title": "合并 MR !1234",
      "detail": "CI 已绿，审批人也点了 approve",
      "link": "http://gitlab/.../merge_requests/1234",
      "dueAt": null,
      "createdAt": "2026-09-07T08:48:46.990Z",
      "source": "sess-abc",
      "doneAt": null
    }
  ]
}
```

- `type`：`merge-mr` | `approve-order` | `review` | `release` | `other`
- `doneAt` 为 `null` 表示未完成（计入面板角标）；非 null 表示已完成（面板只显示未完成）
- `id` 必须唯一（任意字符串，如 `i` + 时间戳 + 随机后缀）

**任何会话的 agent 加待办的通用方式**：read 该文件 → 往 `items` 数组 push 一条（id 唯一、`doneAt: null`）→ write 回写。插件 5 秒内自动拾取。

## 激活步骤/Activation Steps

1. 新建一个会话，选择 **`cordis`** preset（只能在会话还没有任何产出时选择）。
2. 把 `activate-prompt.md` 全文粘贴进会话。
3. 激活会话的 agent 会：替换数据路径 → inspect 验证接口 → `cordis_define` → `cordis_run`。
4. 在 Cordis 面板批准运行（建议双勾，覆盖未来新版本）。
5. 验证侧边栏底部出现"待办"按钮；用 `inbox_add` 加一条测试待办确认面板显示。

## 使用方式/Usage

- **查看**：点侧边栏底部"待办"按钮（折叠态为 📋 图标），红色角标 = 未完成数；面板每 10 秒自动刷新。
- **处理**：面板里点"完成"（标记 doneAt）或"删除"（移除记录）；有链接的条目点"打开"跳转。
- **agent 登记**：会话 agent 调用 `inbox_add`（若工具对该会话可见）；不可见时用上面"通用方式"直接编辑文件。
- **agent 查询**：`inbox_list` 返回未完成列表，任何会话可以据此在结尾提醒你"还有 N 条等你处理"。

## 已知局限/Known Limitations

- **动态插件只在当前 DSH 进程内有效**：`dsh web` 重启后定义丢失，需要重新 define + run（用 `activate-prompt.md`）；**数据文件不丢**。
- **无系统推送**：面板刷新是轮询（host 5s / client 10s），没有浏览器通知；到期提醒请配合官方 Schedule overlay 使用。
- **工具可见性取决于 scope**：动态工具注册在定义会话的 fiber/scope 内，其他 preset 的会话可能看不到 `inbox_*` 工具；面板是 root scope，任何会话都可见。
- **面板样式**用 `light-dark()` 适配明暗主题；如与主题观感不符，可在 `plugin-client.js` 的 CSS 里调整。
- 无跨进程同步：两个 dsh web 进程各自维护缓存，改同一文件可能互相覆盖（不建议）。

## 升级路径/Upgrade Path

当前是动态插件（临时、进程内）。若长期使用，可产品化为**静态插件包**（`packages/` 下的正式 DSH 包 + profile patch 挂载），获得：进程重启自动加载、host 级工具注册（所有会话可见）、正式配置项。需要时再说。
