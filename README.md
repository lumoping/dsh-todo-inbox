# DSH 全局待办插件 dsh-todo-inbox / Global Todo Inbox Plugin

> **Contributors**: lumoping ｜ **最后更新**：2026-09-07 ｜ [GitHub](https://github.com/lumoping/dsh-todo-inbox/blob/main/README.md)

一个运行在 DeepSeek Harness Web GUI 上的**静态 DSH 插件包**：任何会话的 agent 都能登记"等待人类处理"的待办（合并 MR、审批工单、评审、发布等），用户在侧边栏的一个全局区块里查看、打开、完成、删除——不再因为并行多个会话而漏掉某条待办。

已产品化：随 profile 启动自动加载、进程重启不丢失、`inbox_*` 工具是 host 级注册（所有会话可见）。数据落盘 `$HOME/.dsh/todo-inbox.json`，agent 也可以直接编辑该文件（5 秒内被拾取）。

## 文件清单 / File Inventory

| 文件 | 作用 |
| --- | --- |
| `src/index.ts` | 插件 host 半：node:fs 数据持久化 + `inbox_add`/`inbox_done`/`inbox_list` 工具 + `/todo-inbox/api` HTTP 路由 + 5s 轮询拾取外部文件改动 |
| `src/client/index.tsx` | 插件 browser 半：侧边栏内嵌"待办"区块（宽态）+ 圆形按钮与可拖动浮窗（窄态兜底），10s 轮询 |
| `cordis.patch.yml` | bundle patch：一行 `insert` 挂载行（id `todo-inbox`） |
| `tsdown.config.ts` | 构建配置：host 产 `lib/index.js`，client 产 `lib/client.js`（`window.__ModuleLoader__` 闭包格式） |
| `scripts/smoke-test.mjs` | 针对**构建产物**的端到端冒烟测试（host 工具/持久化/轮询/HTTP + client 注册/markdown 渲染） |

## 架构 / Architecture

```
[任意会话的 agent]
   ├─ inbox_add / inbox_done / inbox_list（host 级工具，进程内所有会话可见）
   └─ 直接 read/write 编辑数据文件（通用回退，任何会话都可用）
              │
              ▼
   [数据文件 $HOME/.dsh/todo-inbox.json]  ← 唯一权威
              │  host 半：node:fs 写入落盘 + 5s 轮询拾取外部改动
              ▼
   [host 半] 内存缓存 + 串行化读写；注册 /todo-inbox/api HTTP 路由（webserver prefix）
              │  browser 半：fetch('/todo-inbox/api/items|done|remove|add')，同源 + origin 校验
              ▼
   [browser 半] sidebar.footer.action（root scope，跨会话全局）
               宽侧边栏：内嵌可折叠区块（图标+待办+角标，行内列表）
               窄侧边栏：圆形按钮 + 角标圆点 → 可拖动浮窗
```

- **Host 半**（静态 Cordis 插件，`inject: ['tools', 'webServer']`）：数据文件是唯一权威，内存只是缓存；持久化走 `node:fs/promises` 直写（**不**用注入的 `ctx.fs`——app 的 fs 服务有工作区沙箱，写 `~/.dsh/` 会被拒）；所有读写走同一条 promise 链串行化；每 5 秒读一次文件，内容变化即重新加载。
- **Browser 半**（`inject: ['slots']`）：注册 `sidebar.footer.action`（root scope）。宽态是内嵌区块（行内列表、hover 显现图标操作）；窄态是 36×36 圆形按钮（同 rail 设置按钮几何）+ 右上角角标圆点，点击展开浮窗兜底。
- **状态**：数据 / 展开态 / 浮窗位置都放在模块级 store 里，侧边栏宽↔窄切换导致的按钮重挂载不会丢失任何状态；轮询在插件加载时启动一次。
- **样式**：全部跟随 DSH 设计系统——字号用 `--dsh-content-font-size`，颜色用 `--dsw-alias-*` 语义 token（label-primary / label-secondary / label-tertiary / brand-primary / interactive-bg-hover 等），浮窗表面用 `--dsw-specific-menu` + elevation 配方，`light-dark()` 仅作兜底。图标全部来自 `@deepseek-ai/dsh-client-ui-primitives`（与官方 TodoPanel 同一个 checklist 图标）。
- client↔host 通信走 **webserver HTTP 路由**（`/todo-inbox/api` prefix），不依赖 api-remotes 装配——第三方插件无法向该固定装配注入新 remote，HTTP 是与 dsh-better-sidebar（`/sidebar/api`）一致的通用做法。
- 数据文件为纯 JSON，任何 agent 都能读懂并追加（见下）。

## 数据文件格式 / Data File Format

文件：`$HOME/.dsh/todo-inbox.json`（默认；可在挂载行的 `config.dataPath` 覆盖，父目录需已存在）

```json
{
  "version": 1,
  "updatedAt": "2026-09-07T09:00:00.000Z",
  "items": [
    {
      "id": "imtr00wpa-x0v54x",
      "type": "merge-mr",
      "title": "合并 MR !1234",
      "detail": "CI 已绿，支持 **markdown** 和 [链接](https://example.com)",
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
- `doneAt` 为 `null` 表示未完成（计入角标）；非 null 表示已完成（界面只显示未完成）
- `id` 必须唯一（任意字符串，如 `i` + 时间戳 + 随机后缀）
- `detail` 支持安全 markdown 子集：`**粗体**`、`*斜体*`、`` `代码` ``、`[文字](url)`、裸 URL 自动成链、换行；不安全协议（`javascript:` 等）按纯文本展示，绝不渲染 HTML

**任何会话的 agent 加待办的通用方式**：read 该文件 → 往 `items` 数组 push 一条（id 唯一、`doneAt: null`）→ write 回写。插件 5 秒内自动拾取。

## 构建与测试 / Build & Test

```bash
pnpm install
pnpm run build      # tsc 类型声明 → lib/types，tsdown → lib/index.js + lib/client.js
pnpm test           # node scripts/smoke-test.mjs：对构建产物跑端到端冒烟测试
pnpm run typecheck  # tsc --noEmit
```

`package.json` 的 `prepare` 脚本会自动构建，因此通过 `file:` 安装时无需手动先构建。

## 安装 / Install（本机 profile）

```bash
# 1. 构建
cd ~/dsh-todo-inbox && pnpm install && pnpm run build

# 2. 安装到 web profile（reconcile bundles 并挂载 cordis.patch.yml 的插入行）
dsh plugin --profile web add ~/dsh-todo-inbox

# 3. 重启 dsh web，验证：侧边栏底部出现"待办"区块；任意会话可调用 inbox_add 登记。
```

安装后即随 profile 启动自动加载，`inbox_*` 工具为 host 级注册、所有会话可见。

## 使用方式 / Usage

- **查看（宽侧边栏）**：侧边栏底部"待办"区块（checklist 图标 + 品牌色角标 = 未完成数）；点击区块头折叠/展开。列表每 10 秒自动刷新。
- **查看（窄侧边栏）**：圆形按钮 + 角标圆点；点击展开浮窗（可拖动头部，位置记忆）。
- **处理**：hover 某条待办显现操作图标——打开链接 ↗ / 完成 ✓ / 删除 ✕。
- **agent 登记**：任意会话 agent 调用 `inbox_add`（host 级工具，所有会话可见）；不可见时用上面"通用方式"直接编辑文件。
- **agent 查询**：`inbox_list` 返回未完成列表，任何会话可以据此在结尾提醒你"还有 N 条等你处理"。

## 已知局限 / Known Limitations

- **无系统推送**：界面刷新是轮询（host 5s / client 10s），没有浏览器通知；到期提醒请配合官方 Schedule overlay 使用。
- **单进程**：无跨进程同步——两个 dsh web 进程各自维护缓存，改同一文件可能互相覆盖（不建议）。
- **origin 校验**：HTTP 路由拒绝跨源请求（仅同源浏览器 fetch / 无 origin 的 curl 可用），没有更细的鉴权。
- **数据目录**：默认写到 `~/.dsh/todo-inbox.json`，父目录需已存在；挂载行未带 `config.dataPath` 时不会自动创建目录。
- **窄态列表**：56px rail 没有空间放列表，窄态用浮窗作为兜底展示面。

## 版本历史 / Changelog

- `0.1.0`：静态插件包产品化；随后迭代为**侧边栏内嵌区块**设计（宽态行内列表 + 窄态浮窗兜底）、node:fs 持久化（绕开 app fs 沙箱）、detail 安全 markdown 渲染、全量 DSH 设计系统对齐（token 颜色 / 官方图标 / Settings 几何 / 模块级 store 抗重挂载）。
