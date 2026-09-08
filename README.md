# DSH 待办插件 dsh-todo-inbox

一个 DeepSeek Harness Web 插件：任何会话的 agent 都能把"等待人类处理"的事（合并 MR、审批工单、评审、发布……）登记到一个全局待办收件箱，你在侧边栏里统一查看和处理，不再因为并行多个会话而漏掉。

## 功能

- **侧边栏入口**：宽侧边栏底部显示"待办"区块（未完成数角标），点击标题折叠/展开；窄侧边栏是圆形按钮，点击展开侧边栏。
- **处理待办**：待办标题若是外部链接则点击打开；详情内容点击跳转到登记它的来源会话；hover 显示 完成 ✓ / 删除 ✕。
- **跨会话共享**：所有会话的 agent 通过 `inbox_add` / `inbox_done` / `inbox_list` 工具读写同一个收件箱；数据落盘 `~/.dsh/todo-inbox.json`，进程重启不丢失。
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

agent 会调用 `inbox_add` 写入收件箱；你也可以让 agent 用 `inbox_list` 检查当前有几条待办。agent 也可以直接编辑 `~/.dsh/todo-inbox.json`（往 `items` 数组追加一条记录），5 秒内自动同步到界面。
