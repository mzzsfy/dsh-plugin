# @mzzsfy/mcp-ssh

agent-shell MCP server:给 AI 编码代理(Claude Code / OpenCode / Codex / DSH …)安全的命令行执行能力。

- **所有命令兼容**:本机走平台默认 shell(cmd / sh);SSH 走系统 `ssh` 二进制,密钥、agent、`~/.ssh/config`、ProxyJump 全兼容(采纳 [AiondaDotCom/mcp-ssh](https://github.com/aiondadotcom/mcp-ssh) 的原生二进制路线)
- **命令黑白名单护栏**:内置危险命令黑名单,用户可配置;拦截时支持人工批准(与用户共同操作)
- **交互会话人机协同**:`start/read/send/kill` 会话模型,代理与用户共享 stdin/stdout —— 命令需要密码、y/n 确认、人机验证时,用户可在面板直接接管输入(类比浏览器 MCP 的用户代点)
- **SSH 主机自动发现**:解析 `~/.ssh/config`(Include、多别名、跳过通配块)+ `known_hosts`;`# @password:` 注释经 askpass 注入,密码不进模型上下文
- **文件传输**:`upload` / `download`(scp)
- 标准 MCP stdio,零平台锁定

## 工具面

| 工具 | 说明 |
| --- | --- |
| `run` | 执行命令(本机或 SSH),同步返回 exitCode/stdout/stderr;被护栏拦截时挂起等人工批准或拒绝 |
| `start` | 启动交互/长驻会话,返回 sessionId |
| `read` | 读会话增量输出(字节游标) |
| `send` | 向会话写一行 stdin(代理与用户共用) |
| `kill` | 终止会话进程树 |
| `listHosts` | 列出 config/known_hosts 中的 SSH 主机 |
| `checkHost` | SSH 连通性测试 |
| `upload` / `download` | scp 文件传输 |

## 安装

### Claude Code

方式一(推荐,MCP 直连):

```sh
claude mcp add agent-shell -- npx -y @mzzsfy/mcp-ssh
```

方式二(plugin 包):把本包目录作为 Claude Code plugin 安装(`.claude-plugin/plugin.json` + `.mcp.json` + `skills/agent-shell` 已就绪),技能会教代理正确使用护栏与交互会话。

### OpenCode

`opencode.json`:

```json
{
  "mcp": {
    "agent-shell": {
      "type": "local",
      "command": ["npx", "-y", "@mzzsfy/mcp-ssh"]
    }
  }
}
```

### Codex

`~/.codex/config.toml`:

```toml
[mcp_servers.agent-shell]
command = "npx"
args = ["-y", "@mzzsfy/mcp-ssh"]
```

### DSH

装 [`@mzzsfy/dsh-agent-shell`](../dsh-agent-shell) 即可,自动拉起本 server 并提供面板 UI(better-sidebar 标签页或 `/agent-shell` 页面)。

## 配置

配置文件 `~/.agent-shell/config.json`(可用 `AGENT_SHELL_HOME` 改位置),运行中热加载:

```json
{
  "mode": "blacklist",
  "blacklist": ["我的额外黑名单正则"],
  "whitelist": ["^git\\s+status"],
  "approvalMode": "ui",
  "approvalTimeoutMs": 90000
}
```

- `mode=blacklist`(默认):命中黑名单的命令 → 审批或拒绝;`whitelist` 命中任何模式都放行
- `mode=whitelist`:不在白名单的命令一律走审批/拒绝
- `approvalMode=ui`:挂起等待面板批准(control 通道未开启时自动降级为 `deny`);`deny`:直接拒绝
- 内置黑名单始终生效,用户 `blacklist` 追加;正则用 JS 语法,大小写不敏感

## SSH 密码(可选)

`~/.ssh/config`:

```sshconfig
Host myserver
  HostName 10.0.0.5
  User root
  # @password: 你的密码
```

连接该主机时密码经 `SSH_ASKPASS` 环境注入,不出现在 argv、输出、事件流或模型上下文;`listHosts` 只会显示 `passwordAuth: true`。

## 交互会话(人机协同)

开启 control 通道(`AGENT_SHELL_CONTROL=1`,DSH 插件自动开启)后:

- 命令执行实时进入事件流,面板可见
- 被黑名单拦截的命令挂起,面板出现批准/拒绝按钮,批准后继续执行
- 交互会话输出实时可见,用户可直接输入(密码、确认、人机验证),代理通过 `read` 拿到结果

## 安全边界

- `ssh`/`scp` 永远 `shell:false` + argv 数组 + `--` 终止选项
- host 别名严格白名单且必须在 config/known_hosts 中存在(防 `-oProxyCommand=` 本地执行注入)
- scp 本地路径防"第二远端"写法;禁止写入 `~/.ssh`(该目录的 config 是信任边界,ProxyCommand 会被本机 shell 执行)
- control 通道只绑 127.0.0.1 + 随机 token
- 本工具默认可执行任意命令,请与黑白名单、审批流配合使用
