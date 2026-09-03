# @mzzsfy/dsh-agent-shell

DSH 插件:agent 的命令行执行面板。自动拉起 [`@mzzsfy/mcp-ssh`](../mcp-ssh) 的 MCP server 并桥接为 DSH 工具,提供 better-sidebar 标签页实现 **AI 与用户共同操作 bash** —— 间接 SSH、操控本地、密码人机协同。

## 功能

- **agent 工具**:自动注册 `mcp__agent-shell__run / start / read / send / kill / listHosts / checkHost / upload / download`(全命令兼容,SSH 走系统 ssh)
- **黑白名单护栏**:内置危险命令黑名单;被拦命令挂起等待,**你在面板上批准后继续执行**
- **人机协同**:命令需要密码 / y/n 确认 / 人机验证时,agent 用 `start` 启动,你在标签页里直接输入接管 —— 类比浏览器 MCP 的用户代点
- **UI 双形态**:
  - 装了 [dsh-better-sidebar](https://www.npmjs.com/package/dsh-better-sidebar):自动注册 `Agent Shell` 标签页(执行流实时滚动、审批按钮、会话输入框)
  - 没装:访问 `http://127.0.0.1:3080/agent-shell` 简陋页,功能一致
- **server 自动守护**:子进程意外退出自动重启(指数退避,上限 5 次)

## 安装

```sh
dsh plugin add @mzzsfy/dsh-agent-shell
```

依赖 `tools` 与 `webServer` 服务(web 组成默认都有)。

## 使用

1. 重启 DSH 后 agent 即拥有 `mcp__agent-shell__*` 九个工具
2. 打开 better-sidebar 的 `+` 菜单 → `Agent Shell`,或访问 `/agent-shell`
3. agent 执行的每条命令实时进入执行流;SSH 密码在 `~/.ssh/config` 的 Host 块内写 `# @password: xxx` 即自动注入(不进模型上下文)

## 配置

配置文件 `~/.dsh/dsh-agent-shell/config.json`(面板"黑白名单"区可直接编辑保存):

```json
{
  "mode": "blacklist",
  "blacklist": ["自定义正则"],
  "whitelist": ["^git\\s+status"],
  "approvalMode": "ui",
  "approvalTimeoutMs": 90000
}
```

## 与 DSH 自带 shell 工具的关系

DSH 内置 bash/终端是沙箱会话;本插件走独立 MCP 通道,定位是**与用户协同的任意命令执行 + SSH**。两者可并存;不希望 agent 使用本工具时在 DSH 工具开关里禁用对应条目即可。
