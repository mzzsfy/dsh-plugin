# @mzzsfy/dsh-shell-select

Windows shell 链接管:禁用官方 `pwsh` 工具与执行器,替换为可配置多客户端的 `shell` 工具——pwsh / git bash / cmd / WSL / 任意第三方实现,自定义路径,多个客户端并存,设默认,模型经工具参数按名选择。

## 工作方式

- bundle 补丁按 id 禁用官方 `tool-pwsh`、`pwsh-sandbox` 两行,插入本包主行(`ctx.shell` 执行器 + `shell` 工具 + 设置节 + 浏览器设置页路由)与 guard 哨兵行;卸载本包即补丁消失,官方行自动复位。
- client 半区 `dsh.client.inject` 声明(官方机制,dsh-client-file-upload 等官方包同款):保证 client 运行时模块表中 `primitives`/`slots` 面在场;primitives 另有 try/catch 降级自绘兜底。
- 本包执行器完整实现官方 `ctx.shell` seam(`resolve`/`run`/`start`/`runFor`/`startFor`/`entryFor`/`sandboxMode`),结构官方 PwshLocalExecutor 同构(实例状态/方法全公有——cordis 服务代理会把经 `ctx.shell` 调用的方法 `this` 重定向到阴影对象,`#` 私有触发品牌检查错误)。agent preset 注入的官方 `pwsh` 工具因此照常可用:经 `ctx.shell` 代理走默认客户端;`shell` 工具提供多客户端选择面。
- 沙箱语义官方同构:`danger-full-access` 直跑;受限模式经 `ctx.sandbox.confine` 包装并按官方方言分类拒绝/runner 失败,权限模型不变。
- 死态自愈:用户 patch 层禁用主行的窗口内,guard 哨兵(id 含 `/`,市场不写该层)代挂官方 `dsh-tool-pwsh` + `dsh-pwsh-sandbox` 恢复 host 面服务与 boot 组合(预载失败退避重试,至多 3 次),任一方复活先卸代挂。哨兵/复活让位语义逐项同构 `dsh-llm-pi-gateway`。边界:cordis 服务按 fiber 树解析,代挂对 agent preset 作用域不可见,死态窗口新会话的 preset tool-pwsh 行拒挂(报错清晰)属预期。
- POSIX 上本包全部行停用,官方 bash 链不受影响。

## 工具

`shell` 工具(官方 `pwsh` 工具逐调用镜像):

- 参数:`command`、`description`、`shell`(客户端 id,缺省用默认)、`timeoutMs`、`workdir`、`run_in_background`,沙箱升权面与官方一致。
- 输出标记与官方逐字同构:`[exit code: N]`、`[killed by signal: X]`、`[timed out after …]`、`[sandbox: …]`、截断 spill 提示;terminal 卡退出 pill 照常复原。

## 会话卡(tool.call.toolview)

注册 keyed slot `tool.call.toolview`(key `shell`/`pwsh`/`bash` 三支,priority -1)替换默认通用卡,官方 `terminalCardModel` 同构派生(argsRaw + 结果文本尾部退出标记)。`pwsh`/`bash` 两支覆盖官方工具名:死态窗口 guard 代挂官方 tool-pwsh 时,其调用行同样获得增强卡;persistent 形(无 description)与后台 ack、isError、溢出预览一样回退简版行,不误渲染:

- 折叠行:状态点(失败红/中断黄/其余工具图标)+ `Shell` 标题 + 描述首行摘要,失败摘要红显。
- 展开卡:状态点 + cwd 末段目录 + 客户端名徽标(模型传了 `shell` 参数时)+ 失败 pill(退出码/信号)+ 复制命令/复制输出按钮 + 命令折行带行号 + 输出区(横向滚动,竖向限高)。
- 非终端意图回退简版行:摘要 + 可展开原文 + 检查按钮。
- 图标取官方 `dsh-client-ui-primitives`(StateDot/IconApi/IconInspect/Chevron),模块表缺席时降级自绘。

## 配置(settings 命名空间 `shell-select`)

```yaml
shell-select:
  shells:
    - id: pwsh
      name: PowerShell
      kind: pwsh        # pwsh | bash | cmd | wsl
      path: ""          # 留空自动探测;bash 形探测序含 msys2 锚位(见下)
      args: []          # 留空用形态默认;自定义模板以 {command} 为命令占位
      login: false      # bash 形 true 时 -lc 登录壳(-lc 只取 /usr/bin;/mingw64/bin 需另配 env MSYSTEM=MINGW64)
      distro: ""        # wsl 形发行版(如 Ubuntu-22.04),留空用 wsl 默认;args 模板条目忽略
      env: {}           # 条目级环境变量,如 { MSYSTEM: MINGW64 };wsl 形键自动经 WSLENV 透传
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

出厂默认即上述三客户端;浏览器「设置 → Shell 管理」页可增删改、探测路径、扫描本机、编辑发行版与环境变量(环境编辑态每行一条 `K=V`)。第三方实现:任意可执行文件 + 自定义 args 模板。

env 优先级(同键高右):内置覆盖集(NO_COLOR/PAGER/GIT_PAGER)< 条目 `env` < 调用方环境(spec.env + 会话 `DSH_*` 事实)。wsl 形把条目 env 与调用方环境全部键(WSLENV 本身除外)追加进 WSLENV 白名单,过 WSL 边界不静默失效。

### 命令黑白名单(deny/allow)

- 配置节顶层 `deny` / `allow`:各为正则字符串数组,对模型提交的整条命令文本匹配(大小写不敏感)。命中 `deny` 即拒绝执行;命中 `allow` 的命令豁免检查(处理"禁 rm -rf 但放行清 node_modules"类需求)。两者皆空 = 不拦截(出厂默认)。
- 拦截点在执行器 runFor/startFor 入口:经 `ctx.shell` 代理的官方 pwsh 工具同样受管。拒绝以模型可见标记返回:`[blocked by shell-select: matches deny pattern …]`,后台任务在启动前同步拒绝,不产生僵尸任务。
- 定位是防误触护栏而非安全边界:整文本正则挡不住间接包装(编码/嵌套壳),真正的边界始终是访问模式与沙箱。坏正则条目容错跳过,不瘫执行链;设置页两个多行文本域编辑(每行一条正则),保存时校验正则合法性。

### bash 形探测与 msys2

- 候选序:`Program Files\Git\bin` → `Program Files (x86)\Git\bin` → `LocalAppData\Programs\Git\bin` → `C:\msys64\usr\bin\bash.exe` → `C:\msys64\bin\bash.exe` → PATH 扫描。
- `msys2.exe` 在管道 stdio 下静默失败(exit 0 零字节),永不入候选;System32\bash.exe 是 WSL 转发器,PATH 扫描一律排除 SystemRoot 下条目。
- msys2 条目建议配 `login: true`(`-lc` 登录壳拉起 `/etc/profile`)与 `env: { MSYSTEM: MINGW64 }`(启用 /mingw64/bin 的 gcc/make);git-bash 无需 login(自带 PATH)。
- wsl 形:`wsl [--exec | -d <distro> --exec] bash -c {command}`;条目 env 与调用方环境全部键(WSLENV 本身除外)经 WSLENV 追加透传,继承的 WSLENV 条目保留、显式配置项优先。

## 已知边界

- **受限模式 × Cygwin 系运行时**(git-bash/msys2):confine 包装后 Cygwin mmap 在受限令牌下崩溃(`CreateFileMapping … fatal error`,exit 256)。命令失败可见、错误自解释,模型可换客户端或升权重跑;危险模式与 pwsh/cmd/wsl 不受影响。与 dsh-bash-terminal-ts 观察一致,属 Cygwin 运行时限制而非本包缺陷。
- wsl 形在未安装发行版的机器上:wsl.exe 输出 UTF-16 帮助文本,呈现为乱码;正常发行版下 bash 输出走管道为 UTF-8 不受影响。
- 竞品来源主张的评审结论:不受配置清单约束的模型自选任意终端未采纳(本包的按名选择以设置页清单为边界,越界即报配置指引,官方升权面已覆盖安全需求);不受限 bash 危害面不做;交互式 PTY 终端本轮不做,列入路线图后续立项。

## 组合

```yaml
- insert:
    - id: shell-select
      name: '@mzzsfy/dsh-shell-select'
    - id: shell-select/guard
      name: '@mzzsfy/dsh-shell-select/guard'
```

测试:`node --test "test/*.test.mjs"`(包目录内)。
