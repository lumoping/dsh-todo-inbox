# DSH 待办插件 dsh-todo-inbox

一个 DeepSeek Harness Web 插件：任何会话的 agent 都能把"等待人类处理"的事（合并 MR、审批工单、评审、发布……）登记到一个全局待办收件箱，你在侧边栏里统一查看和处理，不再因为并行多个会话而漏掉。

## 功能

- **侧边栏入口**：宽侧边栏底部显示"待办"区块（未完成数角标），点击标题折叠/展开；窄侧边栏是圆形按钮，点击展开侧边栏。
- **处理待办**：待办标题若是外部链接则点击打开；详情内容点击跳转到登记它的来源会话；hover 显示 完成 ✓ / 删除 ✕。
- **来源上下文**：元信息行上的「来源」按钮就地展开这条待办**是在哪一轮、从哪句话来的**（你当时的原话 + agent 当时的动作），不用跳过去翻历史。见下节。
- **跨会话共享**：所有会话的 agent 通过 `inbox_add` / `inbox_update` / `inbox_done` / `inbox_list` 工具读写同一个收件箱；数据落盘 `~/.dsh/todo-inbox.json`，进程重启不丢失。
- **detail 支持简单 markdown**：`**粗体**`、`*斜体*`、`` `代码` ``、`[文字](url)`、裸链接自动识别。

## 安装

```bash
cd ~/dsh-todo-inbox && pnpm install && pnpm run build
dsh plugin --profile web add ~/dsh-todo-inbox
# 重启 dsh web，侧边栏底部出现"待办"区块即成功
```

## 使用

**给人看**：待办出现在侧边栏（宽态为会话列表下方的区块，窄态为底部圆形按钮），角标是未完成数；hover 条目点 ✓ 完成、✕ 删除，点标题打开关联链接、点详情跳转来源会话。

**给 agent 用**：在任何会话里让 agent 登记待办，例如：

> "帮我登记一条待办：合并 xxx 仓库的 MR !1234"

agent 会调用 `inbox_add` 写入收件箱；你也可以让 agent 用 `inbox_list` 检查当前有几条待办。条目要改就用 `inbox_update`（原地改写，不会多出一条）。agent 也可以直接编辑 `~/.dsh/todo-inbox.json`（往 `items` 数组追加一条记录），5 秒内自动同步到界面。

## 来源上下文（为什么不是"跳转定位"）

点条目的「来源」会就地展开一段摘录：**第几轮**、你当时说的那句话、agent 当时调用了哪些工具。它解决的是"怎么知道这条待办从哪来"，而**不是**把会话滚动到那个位置——因为 DSH 0.2 没有对插件开放这个能力：

| 可能的入口 | 实际情况 |
|---|---|
| `uiWorkspace.openSession()` | 只接受 `SessionId \| SubagentAddress`，没有位置参数 |
| uiWorkspace 导航状态 | 只有 `{ sessionId, subagentAddress }` |
| `conversation` 服务 | 只有 `send / updateQueue / cancel / loadOlder`，没有滚动定位 |
| 会话内轮次导航轨 | 有 `activateTurn`，但那是 ui-chat 内部 ref，未对外发布 |
| Web URL | 会话不写进 URL，没有 deep link |

所以插件改为**把那一轮读出来给你看**：宿主半边通过 `sessionQuery.readSession()` 读取来源会话日志，以条目的 `createdAt` 为锚点，往前找到最近一条有正文的 `user/message` 作为"你说的"，再收集到锚点为止的 `assistant/message` 正文与 `tool/call` 名称。

几点实现约束：

- `sessionQuery` 是**可选**依赖，用 `ctx.get` 惰性取，不写进 `inject`——没装 session-query 的 profile 仍能加载本插件，只是「来源」显示"本机未装载会话检索服务"。
- 读取失败一律降级为明确错误码（`no_session` / `unavailable` / `unreadable` / `no_history`），不会让请求抛异常。
- 从界面自己新增的条目（`source` 为 `api`）没有来源会话，不给「来源」按钮。
- 摘录只覆盖**该轮**：会话后续的新消息不会混进来，正是为了免去翻历史。

## 什么该进待办

收件箱是**跨会话、且需要你亲自动手**的动作清单，不是决策日记。插件会往每个会话注入一段纪律说明来约束写入：

- **只登记**：会话结束后仍然存在、且需要你在会话之外动手的事——合并 MR、审批或发布工单、开权限或配额、发布、未来事件后回滚。
- **不登记**：本轮正在问你的问题或待选项、agent 自己会做的下一步、会话内进度（那些留在对话里，或用 harness 自带的 `todo_write`）。
- **先查再去重**：写入前先 `inbox_list`；若已有条目覆盖同一个动作，用 `inbox_update` 改写它，而不是新增一条近似重复。
- **标题写成一句动作短语**（40 字以内，如 `merge MR !1234`），原因、证据和 id 放进 `detail`，链接放进 `link`——侧边栏会截断长标题，段落式标题会变得无法辨认。
- 处理完用 `inbox_done` 关闭；条目已作废也用它关掉，而不是把它的含义改写成另一件事。
