# 激活提示词：定义并运行 todo-inbox 插件/Activate Prompt: Define & Run the todo-inbox Plugin

> **Contributors**: lumoping ｜ **最后更新**：2026-09-07 ｜ [GitHub](https://github.com/lumoping/dsh-todo-inbox/blob/main/dynamic/activate-prompt.md)

> **说明**：动态插件路线（运行期临时，重启丢失）已被仓库根目录的**静态插件包**取代（`package.json` + `src/` + `cordis.patch.yml`）。本文件仅在静态版安装前、想临时体验时使用。

把下方整段内容粘贴到一个**新建的、选择了 `cordis` preset 的会话**里（会话不能已有任何产出，否则无法切换 preset）。激活会话的 agent 会按 cordis 技能的标准流程：inspect → define → run，过程中需要你在面板里批准一次运行。

---

## 任务（把下面整段发给 cordis 会话）

请用动态 Cordis 插件的方式，在当前 DSH 进程里定义并运行一个名为 **todo-inbox** 的插件：全局待办收件箱（跨会话）。插件源码已经写好并做了语法与行为验证，位于本仓库的 `dynamic/` 目录：

- Host 半：`dynamic/plugin-host.js`
- Browser 半：`dynamic/plugin-client.js`

请按以下步骤执行，**不要改变两个代码半体的业务逻辑，只允许替换数据路径**：

### 0. 先读源码并确定数据路径

1. 用 read 读上面两个文件，理解它们。
2. 用 bash 执行 `echo "$HOME/.dsh/todo-inbox.json"` 得到数据文件的**绝对路径**（`~/.dsh` 目录必然存在，无需新建目录）。把 `plugin-host.js` 里的 `__INBOX_PATH__` 替换成该绝对路径。除这一处外不得改动源码。

### 1. Inspect 验证（cordis 技能要求：写代码前先查真实接口）

依次执行（用 `cordis_inspect_list` 找到对应 Provider，再用 `cordis_inspect_query` 查精确契约）：

- Host `Builtin` 里的 `harness`：确认 `defineTool` / `registerTool` / `handle` 的签名与源码用法一致。
- Host `Service` 里的 `fs`：确认 `resolve(path)` / `readText(target)` / `writeText(target, content)` 可用；`timer`：确认 `ctx.interval(fn, ms)` 用法。
- Client `Service` 里的 `timer`：确认 client 侧 `ctx.interval` 同样可用。
- Client `Slots.listSubTree`：查 `sidebar.footer.action` 的注册协议（list / root scope、register options），确认 `slots.inject(name, () => slots.register({ name, id }, Component))` 的写法。
- `Tool.listTools`：确认 `inbox_add` / `inbox_done` / `inbox_list` 没有被占用。

如果某个接口与源码用法有出入（例如方法名不同），**只做最小适配**并保持行为一致；如果完全一致，直接进入下一步。

### 2. Define

调用 `cordis_define`：

- `plugin.kind: "new"`，`idPrefix`：`tbi`（3 个字母）
- `purpose`：全局待办收件箱（跨会话）
- `code.host`：`plugin-host.js` 全文（已替换数据路径）
- `code.client`：`plugin-client.js` 全文
- 不要使用 JSX / TypeScript / import，源码已经是纯 JavaScript

### 3. Run

调用 `cordis_run`（`mode: "run"`）。如果返回 `awaiting-approval`，**结束本轮工具流，不要轮询**——用户会在 Cordis 面板里批准（建议点双勾，覆盖该插件未来的新版本）。等系统通过状态更新 / steering 通知最终结果。

### 4. 验证

- 调用 `inbox_list`，应返回 `{ ok: true, pending: 0, items: [] }`。
- 调用 `inbox_add` 添加一条测试待办（例如 `{ type: "review", title: "测试：请检查收件箱面板" }`），然后 `inbox_list` 应能看到它。
- 告诉用户：**浏览器左侧侧边栏底部（设置按钮旁边）现在应出现“待办”按钮（折叠时是 📋 图标），带红色数字角标，点击弹出收件箱面板**；面板里有“完成 / 删除”按钮和链接。
- 请在另一个普通会话（standard preset）里问一句“用 inbox_list 看看收件箱”，确认 `inbox_*` 工具是否在**其他会话**可见。如实汇报结果：
  - 若可见：一切正常。
  - 若不可见：说明动态工具注册在当前会话的 scope 内，这不影响收件箱面板（全局 root scope）。回退方案：任何会话的 agent 都可以直接用 read/write 编辑数据文件来加待办（文件格式见 README），插件每 5 秒自动拾取外部改动。

### 5. 收尾

- 不要 git commit，不要修改 DSH 仓库文件。
- 运行成功后，向用户汇报：插件 id、运行状态、数据文件路径、验证结果、工具在其他会话的可见性结论。
- 提醒用户：**动态插件定义只存在于当前 DSH 进程**，dsh web 重启后需要在新会话里用这份提示词重新 define + run（数据文件不丢）。

---

## 用户操作备忘

- 批准运行：打开 Cordis 面板（侧边栏底部的插件按钮），对 `cordis_run` 请求点批准（双勾 = 以后新版本免批准）。
- 日常使用：点侧边栏底部“待办”按钮查看跨会话待办；点“完成/删除”处理；点“打开”跳转链接。
- 各会话的 agent 使用方式：调用 `inbox_add`（若工具可见），或直接编辑数据文件（通用回退）。
