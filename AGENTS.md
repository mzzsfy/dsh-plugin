# dsh-plugin 开发规约

本文件约束所有在本仓库工作的 AI 会话与人类。核心目标:profile 与仓库只有一种合法状态,任何会话不得发明自己的做法。

规约正文按主题拆分于 `DEVELOPMENT/`,以下文件与本文件同等强制效力。例外:文末「子 agent 数据甄别」「已归档会话甄别」「AI 自测规约」「AI 发版规约」四节因 dsh 只注入本文件、不注入链接目标而必须内联,禁止移入 `DEVELOPMENT/`。正因如此,**任务涉及对应主题时,动手前必须先读该文件全文,禁止凭记忆或摘要行事**;不确定涉及哪些主题时,先全部读一遍再动手。

| 主题 | 文件 |
|------|------|
| 包结构与版本、发布流程(publish 唯一入口 / 版本 tag) | [DEVELOPMENT/structure-and-release.md](DEVELOPMENT/structure-and-release.md) |
| profile 链接(dev-link 唯一入口 / junction / fallback 补链) | [DEVELOPMENT/profile-link.md](DEVELOPMENT/profile-link.md) |
| 日常开发循环(热重载边界 / 测试命令 / 提交纪律)、双实现同源 | [DEVELOPMENT/dev-loop.md](DEVELOPMENT/dev-loop.md) |
| 插件 client 规约(UI 开关控件 / 导航图标声明 / 样式注入 data-plugin 契约) | [DEVELOPMENT/plugin-client-conventions.md](DEVELOPMENT/plugin-client-conventions.md) |
| 插件 UI 统一设计规范(色彩槽位 / 尺寸标尺 / 组件视觉形态) | [DEVELOPMENT/plugin-ui-design.md](DEVELOPMENT/plugin-ui-design.md) |
| 公共 client 依赖包(依赖形态发布 / 每个消费插件自带装载行 / 宿主按包名合并) | [DEVELOPMENT/client-dependency.md](DEVELOPMENT/client-dependency.md) |
| DSH 本体 API 对齐(服务优先 / 干净禁用 / 升级回归) | [DEVELOPMENT/dsh-api-alignment.md](DEVELOPMENT/dsh-api-alignment.md) |
| 性能基线与判据(测量约定 / 前后对比阈值 / 用例编写) | [DEVELOPMENT/perf-baseline.md](DEVELOPMENT/perf-baseline.md) |

兼容性检查的维度清单、逐包适用矩阵与项目级门槛见 [docs/兼容性测试/兼容性检查总纲.md](docs/兼容性测试/兼容性检查总纲.md)(本地维护,不入库,干净 clone 不可见;文件缺失时以各包 `兼容性测试.md` 与 [DEVELOPMENT/dsh-api-alignment.md](DEVELOPMENT/dsh-api-alignment.md) 为准)。

安全边界约定(全仓库强制):**所有包不做 host 认证,不设 Host/Origin 可达性闸门**。宿主的 Host 信任闸门由 dsh-auto-trust-all 统一放行(项目威胁模型:本地/内网可达即可信,认证由宿主原生 cookie/startup-auth 承担,本仓库不重复、不加强、不旁路)。任何包新增 HTTP 路由时禁止实现 Host 白名单、DNS-rebinding 防线、token 校验等自有认证层;写路由的跨源防护以 Origin 与 Host 的同源比对为上限(dsh-rs-workflow board 同构)。背景与原理见 [DEVELOPMENT/dsh-api-alignment.md](DEVELOPMENT/dsh-api-alignment.md) 安全边界节。

## 子 agent 数据甄别:先分类再消费

**凡是消费会话、回合、任务、用量、通知数据的插件,必须先把子 agent 数据与主会话数据区分开,再决定产品语义;不分类直接消费即缺陷。**子 agent 会话与主会话共用同一批数据面(host 的 `SessionHeader` / `sessionQuery`、client 的 `sessions.list`、`job/list`、会话事件流),不分类的后果在本仓库已多次出现:归档把子会话当用户会话(dsh-session-manager)、通知对子 agent 回合误报(dsh-turn-notify)、历史输入聚合混入子会话任务提示(dsh-context-manager 旧版缓存污染)、任务准入窗口口径反复(dsh-bug-perf)。

- **判定口径**:host 侧首选 `SessionHeader.origin === 'subagent'`;无 `origin` 的旧记录只认 `parentSession` 存在且 `delegationDepth >= 1`。`parentSession`(client 侧 `parentId`)单独出现不判子会话——普通 fork 同样带该字段,宿主类型注释明写 presence alone does not classify。client `sessions.list` 行只有 `origin`,没有 `delegationDepth`。
- **遍历面**:官方会话列表(`sessionVisible`)按 `origin` 排除子会话;客户端 `sessions.list` 的 `byId` 另含已保留的子会话行,这些行不在 `ids` 内。按 `ids` 统计会漏、按 `byId` 混算会重——需要子会话就遍历 `byId`,用 `origin` 判定、`parentId` 归根(多级、孤儿、环、空白子会话各有定义);不需要就遍历 `ids`。
- **语义显式化**:排除(归档、主会话列表、历史聚合)、归属(运行状态、通知、后台任务挂到根会话)、单列(用量与统计口径)都是合法选择,**不选就是 bug**;每个消费点在 `兼容性测试.md` 留子会话夹具用例(根 + 多级子 + 孤儿/环)。
- **通用会话面不收子会话**:宿主只对 subagent 投递面开放子会话身份,打开、接入、恢复、取消等通用会话路由遇到 `origin=subagent` 或父 agent 持有的会话直接抛 `session/agent-busy`;队列改写对可继续子会话放行。子会话数据经 `sessions.list` 快照与 subagent 面读取,归属类写入一律落根会话 id。

## 已归档会话甄别:归档不是删除

**归档只改变会话在主视图的可见性,不改变存在性。**已归档会话仍在持久层、仍被 `sessionQuery.listSessions` / `job/list` / 会话事件流产出,产物仍占磁盘;不显式选择语义时,统计把不可见会话混进活跃口径、任务流窗口被隐藏行占额度、会话管理动作把归档集合当成生命周期真相。

- **权威来源**:host 侧 `workspaceRegistry.archivedSessionIds`,client 侧 `workspaces.list` 快照同名字段;只有快照 `phase === 'ready'` 时集合才是权威,未就绪时按"未知"处理,禁止当空集(方向性 fail-open:窗口/订阅误放行优于误拒绝,范例 dsh-bug-perf)。
- **语义显式化**:用量统计与历史聚合可以包含归档会话(其消耗与输入真实发生过);主列表、通知、任务流窗口默认排除;删除、重挂载、恢复等会话管理动作只对已归档会话开放,执行前必须复核资格(TOCTOU:宿主集合可能在 await 间隙变化)。
- **集合内容不可信**:归档集合可能残留已删除会话与子 agent 会话 id(本机实测 810 条中 49 条是子会话)。消费前按 `origin` / `parentSession` + `delegationDepth` 校验,禁止拿集合里的 id 直接做归属写入(attach、订阅、打开)。
- **归档只经宿主服务**:`archiveSession` / `unarchiveSession`,禁止直写持久化状态;归档前置条件(运行中会话不归档)由调用方自查,宿主不保证。

## AI 自测规约:隔离宿主 + echo-upstream

插件测试(装载、UI、LLM 链路、定时与数据目录类行为)一律在隔离宿主进行。真实宿主机不算测试环境:不读不写生产 `~/.dsh`、不碰 3080 实例、不用真实 profile 与真实 API。测试不是只读操作——cron-board 会真的调度、usage-panel 会写数据、context-manager 会改历史缓存,污染不可逆。

- **隔离宿主怎么起**:`node scripts/compat/run.mjs --version <版本> --only <包名> --port <随机端口> --refuse-port-owner --keep`;版本取 `node scripts/compat/window.mjs` 的主测槽(或 `DSH_COMPAT_VERSIONS` 显式指定),多步调试可用 `node scripts/compat/boot-keep.mjs --daemon --version <版本> --only <包名> --port <随机端口> --refuse-port-owner` 常驻。脚本在 `.compat/<版本>/` 建独立宿主、隔离 home/profile 与各包数据目录,从 `live.json` 取 token/端口,收尾 `node scripts/compat/keep-stop.mjs`;同版本并行加 `--work-root <独立目录>`。手工/轻量场景只准用 `.compat/` 下安装的宿主 bin,并同时带 `DSH_HOME` 与 `DSH_CRON_BOARD_DATA_DIR`、`DSH_USAGE_PANEL_DATA_DIR`、`DSH_HISTORY_CACHE_DIR`、`DSH_RS_WORKFLOW_DATA_DIR`、`DSH_RS_WORKFLOW_PRESET_ROOT`——缺 `DSH_HOME` 落生产 `~/.dsh`,缺数据目录会把测试任务交给生产调度器。
- **端口段内随机**:隔离宿主端口从 `9296-9310` 段随机取空闲号(避开 ci 逐槽 9291/9292 与 tunnel-fullchain 9295,生产 3080、人工 9191 段不碰),先探测可绑定再启动,占用换号重试;禁止固定默认端口,禁止为抢端口杀别的会话实例(`--refuse-port-owner`)。测试内自起 HTTP 服务用 `--port 0` / `listen(0)`;echo-upstream 用 `--port 0`,实际端口读 stdout/日志,不预写。
- **每次自测新起实例,用完即杀**(终止 = 结束本会话拉起的实例进程):独立脚本无热重载,旧进程即旧代码——2026-09-24 cd0224b 之前的实例不支持流式(`stream:true` 恒回单块 JSON),复用长驻实例(默认端口 18123)是"测到旧行为"的唯一已知根因。随机端口按会话隔离,队列与请求历史互不串扰;隔离宿主与模拟器都不留常驻。
- **LLM 上游一律指向 echo-upstream**:`node scripts/echo-upstream/cli.mjs --port 0` 新起独立实例(随机端口,stdout 打印实际端口),provider baseURL 指向该实例;三协议、SSE 流式、thinking、工具调用、错误注入与 HTTP 控制面见 [scripts/echo-upstream/README.md](scripts/echo-upstream/README.md)。禁止消耗真实 API 配额,禁止以"环境不可测"跳过可测断言(分层与夹具规则见 [scripts/echo-upstream/兼容性测试.md](scripts/echo-upstream/兼容性测试.md))。
- **真实面零接触**:生产 profile、`~/.dsh`、3080 实例不读不写不重启;测试性 patch/bundles 改动只落 `.compat/<版本>/home/profiles/web`;留档不入版本库(默认临时目录;compat 工位按链接方法落 `llm-echo.jsonl`,gitignore 豁免)。

各 `兼容性测试.md` 与模拟器 README 中固定端口 18123、真实 API、仓库内留档路径的写法属人工历史流程记录,AI 会话一律以本节为准。

## AI 发版规约:直接执行

AI 会话发版一律直接运行 `node scripts/publish.mjs <包名|all> [--bump patch|minor|major]`,**禁止任何登录态预检**(不跑 `npm whoami`、不探测 token 有效性、不比对 registry 凭据、不先试 `npm view`)。发布失败按命令输出处置,认证中断直接重跑同一条命令;本地 registry 指向镜像、发布目标为 npmjs 之类的差异不构成预检或改 registry 的理由。发布范围、版本位与 tag 规则见 [DEVELOPMENT/structure-and-release.md](DEVELOPMENT/structure-and-release.md)。
