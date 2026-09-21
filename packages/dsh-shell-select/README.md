# @mzzsfy/dsh-shell-select

Windows shell 链接管:禁用官方 `pwsh` 工具与执行器,替换为可配置多客户端的 `shell` 工具——pwsh / git bash / cmd / WSL / 任意第三方实现,自定义路径,多个客户端并存,设默认,模型经工具参数按名选择。

## 工作方式

- bundle 补丁按 id 禁用官方 `tool-pwsh`、`pwsh-sandbox` 两行,插入本包主行(`ctx.shell` 执行器 + `shell` 工具 + 设置节 + 浏览器设置页路由)与 guard 哨兵行;卸载本包即补丁消失,官方行自动复位。
- 本包执行器完整实现官方 `ctx.shell` seam(`resolve`/`run`/`start`/`runFor`/`startFor`/`entryFor`/`sandboxMode`),结构官方 PwshLocalExecutor 同构(实例状态/方法全公有——cordis 服务代理会把经 `ctx.shell` 调用的方法 `this` 重定向到阴影对象,`#` 私有触发品牌检查错误)。agent preset 注入的官方 `pwsh` 工具因此照常可用:经 `ctx.shell` 代理走默认客户端;`shell` 工具提供多客户端选择面。
- 沙箱语义官方同构:`danger-full-access` 直跑;受限模式经 `ctx.sandbox.confine` 包装并按官方方言分类拒绝/runner 失败,权限模型不变。
- 死态自愈:用户 patch 层禁用主行的窗口内,guard 哨兵(id 含 `/`,市场不写该层)代挂官方 `dsh-tool-pwsh` + `dsh-pwsh-sandbox` 恢复 host 面服务与 boot 组合(预载失败退避重试,至多 3 次),任一方复活先卸代挂。哨兵/复活让位语义逐项同构 `dsh-llm-pi-gateway`。边界:cordis 服务按 fiber 树解析,代挂对 agent preset 作用域不可见,死态窗口新会话的 preset tool-pwsh 行拒挂(报错清晰)属预期。
- POSIX 上本包全部行停用,官方 bash 链不受影响。

## 工具

`shell` 工具(官方 `pwsh` 工具逐调用镜像):

- 参数:`command`、`description`、`shell`(客户端 id,缺省用默认)、`timeoutMs`、`workdir`、`run_in_background`,沙箱升权面与官方一致。
- 输出标记与官方逐字同构:`[exit code: N]`、`[killed by signal: X]`、`[timed out after …]`、`[sandbox: …]`、截断 spill 提示;terminal 卡退出 pill 照常复原。

## 配置(settings 命名空间 `shell-select`)

```yaml
shell-select:
  shells:
    - id: pwsh
      name: PowerShell
      kind: pwsh        # pwsh | bash | cmd | wsl
      path: ""          # 留空自动探测(Program Files / PATH 等常见位置)
      args: []          # 留空用形态默认;自定义模板以 {command} 为命令占位
    - id: git-bash
      name: Git Bash
      kind: bash
      path: ""
    - id: cmd
      name: CMD
      kind: cmd
      path: ""
  default: pwsh
```

出厂默认即上述三客户端;浏览器「设置 → Shell 管理」页可增删改、探测路径、扫描本机。第三方实现:任意可执行文件 + 自定义 args 模板。

## 组合

```yaml
- insert:
    - id: shell-select
      name: '@mzzsfy/dsh-shell-select'
    - id: shell-select/guard
      name: '@mzzsfy/dsh-shell-select/guard'
```

测试:`node --test "test/*.test.mjs"`(包目录内)。
