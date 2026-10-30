# dsh-plugin

DSH(DeepSeek Harness)插件维护主仓库(monorepo)。

## 仓库结构

```
dsh-plugin/
├── packages/         # DSH 插件包
├── DEVELOPMENT/      # 开发规约(AGENTS.md 拆分主题)
├── scripts/          # 发版/开发态链接/CI 聚合测试脚本、compat 与 echo-upstream 工位
├── tests/            # 仓库级测试(聚合器/compat 判定/dev-link/publish/echo-upstream 等)
├── .github/          # CI workflows(test/compat)
└── docs/             # 本地资料(除注明外不入库)
```

> npm 发行的包统一使用`@mzzsfy/*`格式

## 插件一览

| 名称 | 功能 | 简单原理 | 类型 |
| --- | --- | --- | --- |
| @mzzsfy/dsh-usage-panel | 多平台 LLM 账号余额与额度面板:七类 provider(DeepSeek/OpenRouter/Kimi/智谱/MiniMax/NewApi/自定义端点)定期自动查询并画趋势图,用量/余额阈值与窗口重置多通道通知 | 定时调用各平台查询接口并存快照(统一查询间隔 + 指数退避防风控),快照分档留存,面板自绘 SVG 画余额/额度趋势;通知经公共 WS 总线分发,多窗口 IndexedDB 认领 | DSH 双端插件(settings 槽位 + web 路由) |
| @mzzsfy/dsh-usage-dash | 用量统计面板:天/小时/分钟三粒度 token 与请求统计、26 周活跃热力图、会话底栏官方数据后追加增强项与回合费用芯片、多条件分时段定价费用估算;复刻自 [HaoyueQin/dsh-usage-statistics-panel](https://github.com/HaoyueQin/dsh-usage-statistics-panel),致谢原作者 | host 端订阅会话事件采集用量落存储域,web 路由供面板查询;client 端设置面板 + 底栏追加与官方动作行回合费用芯片;定价规则按精确/通配与时段/星期/号段多条件匹配 | DSH 双端插件(storage 域 + web 路由 + 槽位注入) |
| @mzzsfy/dsh-maintain | 版本与运维一体化:自动发现新版本、受管 A/B 一键升级(候选验证 fail-closed)、安全重启,重启后页面自动恢复 | 监测 npm dist-tag 发现新版本;升级走 A/B 双目录编排(依赖树完整性 + 候选 CLI 冒烟通过才切换链接);重启走优雅退出(5 秒兜底),页面轮询检测宿主恢复后自动刷新 | DSH 双端插件(settings 槽位 + web 路由) |
| @mzzsfy/dsh-think-expand | 流式思考自动展开:始终显示最新一条思考,手动操作优先,打开会话仅展开最后一条,卸载无残留 | 纯前端观察流式渲染,新思考出现即收起上一条;设置卡提供「仅思考(默认)/全部消息」模式开关(localStorage 持久),可选开启独立的工具行展开机;默认形态安装即生效 | DSH 纯前端插件(client 模块,DOM 观察) |
| @mzzsfy/dsh-turn-notify | 回合事件通知:声音 / 系统弹窗 / 页内提示 / webhook / IM / 宿主桌面通知多通道,六类事件独立开关,多窗口只响一次 | host 端观察回合状态,client 端发声;多窗口经公共 WS 总线快照 + IndexedDB 原子认领唯一呈现;系统弹窗不可用(非回环/未授权)降级标题闪烁 | DSH 双端插件(host 观察投影 + client 发声) |
| @mzzsfy/dsh-session-manager | 会话生命周期管理:超期会话自动归档(阈值/周期可配)、归档面板(取消归档 / 删除进系统回收站或插件回收区 / 台账一键重挂载)、归档推送提示 | host 三路触发同一幂等归档评估(timer 软依赖缺失自动降级);取消归档后 10 分钟内评估短路防误归档;删除三次确认,系统回收站不可用自动降级插件回收区,台账承载重挂载 | DSH 双端插件(host 自动归档 + client 面板) |
| @mzzsfy/dsh-rs-workflow | 若水工作流:流程模板管理与一键释放为 Agent 预设组合——主循环编排七工具、分段推进、结构化产出契约强制校验、审批原语、运行记录无截断回看;模板经设置页管理 | host board 行挂 `/api/rsww/*`(模板/配置/运行记录/控制/释放);释放链把模板生成为 `rs-<id>` 预设组合(orchestrator 七工具 + template-tool 行);数据落自有文件不经宿主 settings | DSH 插件(host board 行 + 释放组合两角色) |
| @mzzsfy/dsh-llm-pi-gateway | 为官方 PiAiAdapter 提供会话标记增强:Anthropic 注入 `metadata.user_id`,Chat 补会话亲和头(`session_id` / `x-client-request-id`);官方 `llm-pi-ai` 保持启用并继续自服务 | 仅装饰官方 namespace 注册且结构匹配的 adapter;OpenAI 请求透传;不接管或注册 provider | DSH host 端插件(adapter 装饰器) |
| @mzzsfy/dsh-settings-nav-icons | 设置导航分区图标:把千篇一律的齿轮换成各分区专属图形,并为插件市场卡片头像槽提供插件图标,重载页面即恢复官方图标 | 观察设置导航 DOM 与市场卡片 DOM,按分区显示文本贴图;插件面板可声明自己的图标;取图链 声明→内置→关键词→哈希 | DSH 纯前端插件(DOM 观察) |
| @mzzsfy/dsh-auto-trust-all | 动态信任所有实际到达的 Host:泛域名等无法枚举的入口免改启动命令即可达,监听绑定归部署层,认证层(原生 cookie 与会话闸门)不动 | 包装 webServer 全部路由把 Host 头实时注册进 `connection.trustedHosts`(0.2.0 线 `webRuntime` 镜像);容量 maxHosts 默认 100 按 LRU 淘汰,注册/淘汰 console 直出可作入口审计 | DSH host 端插件(bundle patch + 路由包装) |
| @mzzsfy/dsh-shared-terminal | 共享交互式终端:AI `terminal` 单工具(open/list/read/write/wait/close)与 DSH 官方 Sidebar xterm 共用 Session terminal,用户可输入并查看当前屏幕 | 通过 DSH 官方 terminalController 管理终端;read 走私有 owner lookup 与 xterm active viewport;0.2.1-rc.2 起写入改自持 attach 泵(用户可随时接管) | DSH 双端插件(官方 terminal controller + Session result renderer) |
| @mzzsfy/dsh-stock-assistant | 股票单页面工具：沪深A股自选、搜索、基础行情、别名/置顶/排序、数据源与路由设置；页面状态不随会话切换销毁 | 根作用域 main + 左导航入口；Provider按市场/能力路由，报价同源归一；专用 stock_assistant 数据域保存自选/配置/缓存，不使用默认 settings；通知复用公共WS | DSH 双端插件(storage 域 + web 路由 + 全局工具页) |
| @mzzsfy/dsh-cron-board | 定时任务看板:环境变量集中管理(多值展开/dotenv 导入导出)+ cron 定时任务,执行体支持本地脚本与 dsh 会话任务(fresh 每次新建 / pinned 固定会话,可指定模型) | host 端 croner 解析 cron 触发,全局并发闸门与超时收尾;支持内联时区后缀 `T±N`;pinned 会话任务忙时自动跳过;会话任务经 sessionController 投递,投递即终态 | DSH 双端插件(web 路由 + settings 槽位) |
| @mzzsfy/dsh-common-tools | 公共依赖库:按插件空间隔离的 WebSocket 订阅/推送总线与 toast,两端 `setupCommonTools(ctx)` 自动绑定当前插件 | 插件就是通道,subscribe/publish 共享单条页面 WS;host 提供 presence,client 提供 toast;经 session-manager 占位条目装载 | 普通 npm 依赖非插件,插件管理不可见 |
| @mzzsfy/dsh-context-manager | 对话增强:历史输入浮层(`Alt+↑` 唤起,四范围导航与即时搜索,常用提示词收藏)、插话撤回、对话分叉(重写式 fork,原输入回填供编辑重发)、标题栏复制 sessionId、克隆仓库打开工作区 | Host 聚合工作区历史缓存(`~/.dsh/historyPrompt/`)经 `/api/context/*` 供浮层查询;分叉走宿主 sessions 服务面 fork+open;克隆注入官方浏览目录弹窗 | DSH 双端插件(host 路由 + client 注入) |
| @mzzsfy/dsh-boss-simulator | 公司管理模拟器:以老板身份安排任务,分派给部门自治执行,只接受汇报;含看板、时间线、中断恢复 | 管理员预设会话经单一 `boss_simulator` 工具派发任务,实施与独立验收派发到标准会话执行,报告经 durable 会话事件归并;GUI 看板 + 内嵌管理员聊天 + 侧边栏入口 | DSH 双端插件(host 角色行 + client 看板) |
| @mzzsfy/dsh-shell-select | Windows shell 接管:替换默认 pwsh 工具为可配置多客户端 shell 工具(git bash/WSL/cmd/pwsh,自定义路径,默认客户端,模型按名选择);命令 deny 黑名单,接管失败自动回退官方 pwsh 链 | 工具接管 + 配置校验管线(volatile ref 解箱 + 执行面 strict);bash 候选多锚位探测;web 行提供设置页与 POSIX 形态声明 | DSH host 端插件(工具接管 + 设置页) |
| @mzzsfy/dsh-tool-gate | 全局层工具白名单延迟加载:白名单内工具全量注入,白名单外统一打 deferLoading 标交宿主 deferred tool loading(API 服务端按需搜索激活);第三方路由降级折叠为占位 + `tool_search` 检索 | 声明式收敛(白名单为唯一事实源),行退场按 undo journal 还原原状;设置卡 GUI 配置 | DSH host 端插件(工具收敛 + 设置卡) |
| @mzzsfy/dsh-tunnel | 路径穿透隧道:在 dsh 宿主进程内把本地 TCP 端口反向代理出去(`/p/<name>` 子路径或 `<name>.*` 子域名),ai 经 `tunnel_open`/`tunnel_list`/`tunnel_close` 三工具自管 | 进程内反代,不引入 nginx/caddy 等外部反代;HTTP 前缀 strip 转发 + 声明式 WS upgrade,子域名全路径透传;REST + GUI 看板 + 设置卡,持久化随 `DSH_HOME` | DSH 双端插件(web 路由 + client 看板) |

## 安装与更新:缩短 pnpm 宽限期

pnpm 的 `minimumReleaseAge` 是新包发布后的安装宽限期(防供应链投毒)——刚发版的插件会因此装不上或装到旧版。建议永久改为 6 小时:

```sh
pnpm config set --global minimumReleaseAge 360
```

单位为分钟(6h = 6*60 = 360),写入全局 pnpm 配置,对所有项目生效。刚发版想立刻安装,可单次绕过:`pnpm install --config.minimum-release-age=0`。本仓库 `node scripts/dev-link.mjs all` 会把各已发布包线上最新版精确并集写入 profile 的 `minimumReleaseAgeExclude`(自家包装时不被拦;兜底参数 `--allow-fresh` 见 DEVELOPMENT/profile-link.md),故此建议只影响 profile 之外的场景。

## 开发与测试

要求 Node >= 22(各包 engines 字段;其中 dsh-settings-nav-icons 为 >=20)。各包 manifest 以 `dsh.compatibility.dshReleases` 逐版本声明 DSH 完整版本兼容性(实测过的版本记 `compatible`,未经实测验证的版本声明 `unknown`,以各包 manifest 为准)。

- 包内测试:18 个包全部含 test/ 目录,统一 `npm test` 入口(多数包为 `node --test "test/*.test.mjs"`;cron-board/tunnel/turn-notify/usage-panel 四包经 `--experimental-test-module-mocks --import ./test/_mocks.common-tools.mjs` 预载公共依赖桩;shared-terminal 为自定义入口 `node test/run.mjs`,以各包 scripts.test 为准)
- CI 测试(`.github/workflows/test.yml`):push 按改动范围收敛(全部改动落在 `packages/<X>/` 只测 X + 冒烟与仓库根测试;触及非包路径回退全量),每 3 天定时与手动触发为全量;amd64/arm64 双架构并行,各跑 10 轮(smoke-load + 全部含 test/ 目录的包自动发现 + 仓库根 tests/ + 公共模拟器 scripts/echo-upstream 测试单元;测试文件按平台过滤,`*.linux.test.mjs`/`*.win.test.mjs` 专属,CI 只跑 linux 侧;宿主 peer 以钉版包装入仓库根 node_modules 作解析桥,包间依赖以 @mzzsfy 符号链接解析、不经 registry,均不入库)
- CI 兼容性测试(`.github/workflows/compat.yml`):每 3 天定时 + 手动触发,真实 dsh 宿主双槽窗口逐版本全家桶 boot(主测完全适配判定 + 基线不崩溃判定,均阻塞);不被 push 触发,方法见 docs/兼容性测试/测试与隔离方法.md(本地维护,不入库)

### 宿主兼容性

兼容性目标策略(2026-09-27 起):双槽窗口——主测 = 各渠道 dist-tag 指向版本中最新的 rc(渠道全无 rc 时取各渠道指向版本中语义化版本最大者;与基线同版本则窗口缩为单主测),完全适配(阻塞);基线 = dist-tag `latest` 指向版本,不崩溃底线(阻塞);三版本完全兼容不再执行(难度与收益不成比例)。窗口唯一规则实现为 `node scripts/compat/window.mjs`(实算随 dist-tag 滑动,本节版本号仅为写作日快照,与脚本输出不一致时以脚本为准):2026-10-26 实算 0.2.1-rc.3(主测)/ 0.2.1-rc.2(基线)。各包 manifest `dsh.compatibility.dshReleases` 为逐版本实测登记(存档非承诺,兼容面以窗口实测为准),`dsh.hostMin` 由 compat 装载层按包过滤(声明包:auto-trust-all/boss-simulator/llm-pi-gateway/shared-terminal/shell-select/tool-gate)。逐包测试进度见 docs/兼容性测试/逐包测试进度.md(仅该文件本地维护,不入库)。

以下为 2026-09-27 Round 30 实测记录(历史留档,当时窗口仍为三版本:0.1.2-rc.1 基线 / 0.1.5-rc.3 主测 / 0.1.7-rc.2 完全兼容目标;其中 dsh-shell-select 预设架构当时要求 ≥0.1.7-rc.1,对当时基线不可安装——该例外随窗口滑动已不再成立,hostMin 过滤现由装载层通用承载):

- **0.1.7-rc.2(完全兼容)**:宿主 SettingsForms 形态(settings 无 register/get)下,六包(context-manager/cron-board/session-manager/turn-notify/usage-dash/usage-panel)settings 读/写循环端到端可用——双形态适配:legacy 方法面(settings.register+update)与 0.1.7 静态 Config(volatile schema)+ configEditor.edit 写入并存,运行期以 `register && update` 双在检测分派。真机验收:六包 HTTP 写读闭环 + profile cordis.patch.yml 逐字段落盘 + Playwright UI 分区渲染(含 usage-dash 定价表格回读、turn-notify 深合并芯片态)。
- **0.1.5-rc.3 / 0.1.2-rc.1(不崩溃底线,实测通过)**:同套代码 legacy 分支回归,六包写读经宿主 settings.yaml 命名空间段,行为与适配前一致(双形态检测在旧宿主恒走原路径,零行为漂移)。
- 例外:dsh-shell-select 预设架构要求 ≥0.1.7-rc.1(`@deepseek-ai/dsh-agent-preset` 依赖),0.1.2-rc.1/0.1.5-rc.3 上不可安装(peerDependencies 已声明门槛;bundle patch 的 preset 行在旧宿主 import 失败会阻断 boot,隔离夹具以 `--only` 白名单排除该包);0.1.7-rc.2 全家桶全装。

## 开发态链接(dev-link)

```sh
node scripts/dev-link.mjs all          # 归一 profile 依赖行(^线上最新)+ 对账 dsh.profile.bundles + 挂工作副本 junction
node scripts/dev-link.mjs <包名>       # 单包模式
node scripts/dev-link.mjs all --unlink # 恢复纯 registry 版本
node scripts/dev-link.mjs all --allow-fresh # pnpm install 仍被 minimumReleaseAge 拦截时的兜底(仅限自家刚发的包)
```

- 开发态合法形态:已发布包依赖行 = `^线上最新`,未发布包(线上 404)依赖行 = `file:<仓库>/packages/<包>`(dev-link 自动写入,出版本后重跑自动归一);工作副本挂载一律 = junction;公共依赖包无表层依赖行(残留行由 dev-link 删除),由消费插件 dependencies 声明随装 + dsh fallback 补链兜底
- `dsh.profile.bundles` 由 dev-link 对账(镜像官方 `dsh plugin` reconcilePlugins 语义):清单内插件包且依赖行已声明即入层,公共依赖包或无依赖行即出层;装载层变化不走热重载,重启 dsh 后生效
- link 时在 home 补丁层(~/.dsh/cordis.patch.yml)维护 hmr 覆盖行:仓库 packages 保存即热重载(host 半区约 1 秒,client 半区刷新页面),卸链时移除

dsh-usage-panel 的无 IO 纯逻辑层(`src/parsers.mjs`)由其 npm test 覆盖。包元数据:dsh-usage-panel peerDependencies 为 `@deepseek-ai/dsh-settings`(>=0.1.2-alpha.2)、`@deepseek-ai/schemastery`(>=3.18.0)与 `react`(^18.2.0);@mzzsfy/dsh-rs-workflow 为 `@deepseek-ai/schemastery`(^3.18.1)、`@deepseek-ai/dsh-llm`(>=0.1.2-rc.1)与 `@deepseek-ai/dsh-tools`(>=0.1.5-rc.2);@mzzsfy/dsh-maintain 为 `@deepseek-ai/schemastery`(>=3.18.4,`volatile` 引入线)与 `react`(^18.2.0),settings/configEditor 经服务注入使用不占 peer。peer 不落盘(profile pnpm `autoInstallPeers: false`),开发态由目录逐级兜底解析到 dsh 本体全局安装目录,CI 无 dsh 本体时以钉版包装入仓库根 node_modules 作解析桥。

## 发布

推荐走仓库级发版脚本(内置版本校验、测试、发布后回读验证与打 tag):

```sh
node scripts/publish.mjs dsh-usage-panel              # 发单个包
node scripts/publish.mjs all                          # 按序发全部
node scripts/publish.mjs <包名> --dry-run             # 只打印动作,不执行
node scripts/publish.mjs <包名> --bump patch          # 本地版本已发布时自动升 patch 再发
```

规则:

- 版本管控以 git tag 为事实源:每包独立 tag,形如 `<npm包名斜杠换连字符>-v<版本>`(如 `@mzzsfy-dsh-usage-panel-v0.1.0`);发布成功后脚本自动提交该包版本号变更并把 tag 打在该提交上,推送由维护者执行(`git push --tags`)
- 发版判定(本地版本==线上时)以 tag 后的包目录提交数为准:无提交 → 跳过(该包无需发版);有提交 → 拒绝发布并提示提交数,须显式 `--bump` 才发(防止代码已变而版本号未动被漏发);本地 tag 缺失 → 补打 tag 并跳过
- 本地版本低于线上时拒绝发布(防版本回退);高于线上时直接发布(`--bump` 仅适用于本地等于线上的场景)
- 各包 package.json 的 `npmPublish` 脚本是无校验的单包发布命令,仅在明确清楚后果时使用
- 发布要求本机已 `npm login`(2FA 账号按回车走浏览器认证,或使用 automation token)
- 单包发布只运行目标包的有效 `npm test`;缺少或为空的 `test` script 时拒绝发布。`all` 运行全仓聚合门后，只对有有效 `test` script 的包逐个运行测试;`--skip-test` 会跳过聚合门与目标包测试并警告未经测试发布,仅作显式豁免。

## License

MIT,见 [LICENSE](LICENSE)。
