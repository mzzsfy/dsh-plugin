# @mzzsfy/dsh-shell-select

Windows shell 链接管:禁用官方 `pwsh` 工具与执行器,替换为可配置多客户端的 `shell` 工具——pwsh / git bash / cmd / WSL / 任意第三方实现,自定义路径,多个客户端并存,设默认,模型经工具参数按名选择。

**宿主要求 ≥ 0.1.7-rc.1**:预设面用 preset-* 声明行(patch 引用 `@deepseek-ai/dsh-agent-preset`,0.1.7 起提供);装到更旧宿主会因该包缺失导致组合树加载失败——0.1.5 及以下请勿安装本包。

## 工作方式

- **运行时接管**:bundle 补丁不静态禁用官方 `tool-pwsh`、`pwsh-sandbox` 两行——boot 期官方 pwsh 链先服务,主行(`ctx.shell` 执行器 + `shell` 工具 + systemPrompt 段)apply 落定后经 `entry.update` 运行时禁用官方两行(dsh-market 同款,内存态不持久),再挂载执行器接管。本包任意死法(import 崩/apply 崩/被禁/卸载)下官方行保持启用,官方 pwsh 链自服务,系统不出现 shell 全灭窗口;重启后由行树声明态收敛。web 行(设置页数据通道,`inject: ['webServer', 'settings']` 声明式门控——服务就绪才激活)与 guard 哨兵行同 patch 插入。
- 配置事实源 = 主行 Config(dsh 0.1.7 settings 面以 profile 条目为存储,ns `shell-select`);自带设置页经 `settings.configure({ auto: false })` 抑制原生自动页,写路径 `settings.replace`,配置变更由 cordis 行重载活生效(工具描述随行重建即时更新)。
- client 半区 `dsh.client.inject` 声明(官方机制,dsh-client-file-upload 等官方包同款):保证 client 运行时模块表中 `primitives`/`slots` 面在场;primitives 另有 try/catch 降级自绘兜底。
- 本包执行器完整实现官方 `ctx.shell` seam(`resolve`/`run`/`start`/`runFor`/`startFor`/`entryFor`/`sandboxMode`),结构官方 PwshLocalExecutor 同构(实例状态/方法全公有——cordis 服务代理会把经 `ctx.shell` 调用的方法 `this` 重定向到阴影对象,`#` 私有触发品牌检查错误)。
- preset 面收口(0.1.7 架构):agent 面整体移入会话预设(preset-* 声明行内联 roster,web 表面在根组合树禁用全部 agent 工具行)。本包 patch insert 自带预设 `shell-select`(standard 内联 roster 全量 − tool-pwsh 行,逐项同构官方 standard.patch.yml)并覆写 `agent-preset-registry` 的 default:win32 默认预设切到本包预设(POSIX 保持 standard,行为与上游一致)。用户显式选择其他预设恒优先——官方 minimal/cordis/ptc 预设自带 persistent pwsh 终端链,显式选用时不在接管范围。上游预设漂移由 `test/preset-drift.test.mjs` 逐行守卫,升级后按官方实文对表。
- 沙箱语义官方同构:`danger-full-access` 直跑;受限模式经 `ctx.sandbox.confine` 包装并按官方方言分类拒绝/runner 失败,权限模型不变。
- 死态自愈:用户 patch 层禁用主行的窗口(接管中 runtime-disable 残留)内,guard 哨兵(id 含 `/`,市场不写该层)代挂官方 `dsh-tool-pwsh` + `dsh-pwsh-sandbox` 恢复 host 面服务与 boot 组合(预载失败退避重试,至多 3 次),任一方复活先卸代挂。哨兵/复活让位语义逐项同构 `dsh-llm-pi-gateway`。边界:cordis 服务按 fiber 树解析,代挂对 agent preset 作用域不可见,死态窗口新会话的 preset tool-pwsh 行拒挂(报错清晰)属预期。
- escape hatch(用户想用官方 pwsh 链):market 禁用 shell-select 或 user patch 写 `- id: shell-select / disabled: true`——主行退场后官方行保持启用自服务,重启后官方自然回归;删除禁行重启即恢复接管。(官方两行带平台表达式,行级 `disabled: false` 与宿主默认启用同形,不作让位信号。)
- POSIX 上本包全部行停用,官方 bash 链不受影响。

## 工具

`shell` 工具(官方 `pwsh` 工具逐调用镜像):

- 参数:`command`、`description`、`shell`(客户端 id,缺省用默认)、`timeoutMs`、`workdir`、`run_in_background`,沙箱升权面与官方一致。
- 输出标记与官方逐字同构:`[exit code: N]`、`[killed by signal: X]`、`[timed out after …]`、`[sandbox: …]`、截断 spill 提示;terminal 卡退出 pill 照常复原。

## 会话卡(tool.call.toolview)

注册 keyed slot `tool.call.toolview`(key `shell`/`pwsh`/`bash` 三支,priority -1)替换默认通用卡,官方 `terminalCardModel` 同构派生(argsRaw + 结果文本尾部退出标记)。`pwsh`/`bash` 两支覆盖官方工具名:死态窗口 guard 代挂官方 tool-pwsh 时,其调用行同样获得增强卡;persistent 形(无 description)与后台 ack、isError、溢出预览一样回退简版行,不误渲染:

- 折叠行:状态点(失败红/中断黄/其余工具图标)+ `Shell` 标题 + 描述首行摘要,失败摘要红显。
- 展开卡:状态点 + cwd 末段目录 + 客户端名徽标 + 失败 pill(退出码/信号)+ 复制命令/复制输出按钮 + 命令折行带行号 + 输出区(横向滚动,竖向限高)。徽章忠实于执行事实:每次调用结果尾附 `[shell: <id>]` 标记(模型可见,官方退出标记同族),卡片按标记回放实际生效的客户端——缺省调用在配置事后变更或跨宿主查看时不被查看时读数改写;无标记的历史块回退显式参数 → 当前 default 推导。
- 非终端意图回退简版行:摘要 + 可展开原文 + 检查按钮。
- 图标取官方 `dsh-client-ui-primitives`(StateDot/IconApi/IconInspect),模块表缺席时降级自绘。行首无展开箭头,与官方组件一致,可展开性由指针与整行点击承载。

## 配置(行条目 `shell-select`,settings 面同名 ns)

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

### 命令黑名单(deny)

- 配置节顶层 `deny`:正则字符串数组,对模型提交的整条命令文本匹配(大小写不敏感),命中即拒绝——**deny 绝对,无豁免语义**;空数组 = 不拦截(出厂默认)。
- 精细放行在模式内用正则前瞻表达:`deny: ['rm -rf\\s+(?!\\S*node_modules)']` 禁 rm -rf 但放行清依赖目录;默认放行系统下独立 allow 列表的唯一语义就是覆盖 deny,与"deny 绝对"矛盾,故不设。
- 拦截点在执行器 runFor/startFor 入口:经 `ctx.shell` 代理的消费方(如 hooks 桥)与 preset 预设切换前的官方 pwsh 工具同样受管。拒绝以模型可见标记返回:`[blocked by shell-select: matches deny pattern …]`,后台任务在启动前同步拒绝,不产生僵尸任务。
- 定位是防误触护栏而非安全边界:整文本正则挡不住间接包装(编码/嵌套壳),真正的边界始终是访问模式与沙箱。坏正则条目容错跳过,不瘫执行链;设置页为逐条规则编辑器(每条规则独立行,行级即时校验并标错,保存时按行定位拦截非法正则)。

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
    - id: shell-select/web
      name: '@mzzsfy/dsh-shell-select/web'
```


## dsh 版本兼容

宿主要求 ≥0.1.7-rc.1(bundle patch 引用 0.1.7 才有的 dsh-agent-preset 宿主包,更旧宿主安装即 boot 失败,README 已声明不视为缺陷)。主测 0.1.7-rc.2:设置面 7 格过(自动探测/自定义路径/坏路径徽标/黑名单往返含行号拦截/默认热更落盘/preset 接管入册);工具调用链格需 LLM tool use 模拟器,当前 E(执行层语义由 217 单测覆盖);运行时接管(Round 29)9291 keep 宿主实证 runtime-disable→fiber 激活+INV-6 残影稳定。

测试:`node --test "test/*.test.mjs"`(包目录内)。
