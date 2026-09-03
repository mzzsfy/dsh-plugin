---
name: agent-shell
description: 使用 agent-shell MCP 工具安全执行本地与 SSH 命令,包括黑白名单拦截时的处理、交互会话中让用户输入密码、文件传输。当需要运行命令、远程操作主机、上传下载文件、或命令需要密码/确认时使用此技能。
---

# agent-shell 命令执行指南

通过 agent-shell 的 9 个 MCP 工具执行命令:`run` / `start` / `read` / `send` / `kill` / `listHosts` / `checkHost` / `upload` / `download`。

## 工具选择

- 常规命令用 `run`:同步等待完成,返回 exitCode/stdout/stderr/durationMs。本机不传 `host`;SSH 传 `host`(别名,先 `listHosts` 确认)。
- 长驻程序(dev server、watch、REPL)或需要交互的程序(安装器、需要输密码的命令)用 `start`,返回 sessionId:
  - `read`(sessionId, cursor) 读增量输出,cursor 传上次返回值
  - `send`(sessionId, text) 写一行输入(自动换行)
  - `kill`(sessionId) 终止
- 传文件用 `upload` / `download`(scp 语义)。
- 不确定 SSH 主机是否可达,先 `checkHost`。

## 安全护栏

- 内置危险命令黑名单(rm -rf /、mkfs、dd of=/dev/、shutdown 等)+ 用户可配置黑白名单。
- 被拦截时 `run` 返回 isError,信息含拦截原因:
  - 若环境开启了人工批准面板,命令会挂起等待,用户在面板上批准后自动继续 —— 此时不要重复调用,耐心等待返回;
  - 若直接拒绝(无批准通道),不要尝试变换写法绕过护栏(如拆分命令、base64 编码),这违背用户配置护栏的意图。确需执行,告知用户调整配置或让用户手动执行。
- 白名单模式(mode=whitelist)下只有命中白名单的命令直接放行。

## 密码与人机协同

- SSH 密码:在 ~/.ssh/config 的 Host 块内写 `# @password: 你的密码`,连接时自动经 askpass 注入,密码不会出现在任何输出、日志或模型上下文中。
- sudo/交互提示:用 `start` 启动,输出出现密码提示时优先提示用户在面板(如 DSH 的 Agent Shell 标签页)直接输入;用户不在时可用 `send` 代输(注意:代输的密码会留在会话记录里,敏感密码避免代输)。
- 用户在面板的输入与你通过 `send` 的输入进入同一 stdin,`read` 的输出包含双方操作结果。

## 输出与超时

- run 默认 120s 超时,`timeoutMs` 可调(上限 30min),超时杀整个进程树并返回已捕获输出。
- 超长输出会被头尾截断(标记 truncated);需要完整输出时重定向到文件再用 read 工具读文件。
- 非零退出码返回 isError 且带完整输出,这是正常数据,根据 stderr 内容决定修复方式。
