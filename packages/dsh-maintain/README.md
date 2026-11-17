# @mzzsfy/dsh-maintain

DeepSeek Harness 设置页插件:版本监测、更新内容、升级前检查、安全模式与受管 A/B 升级、安全重启。

## 预览

![设置页](https://raw.githubusercontent.com/mzzsfy/dsh-plugin/main/assets/screenshots/dsh-maintain/settings.png)
![安装确认](https://raw.githubusercontent.com/mzzsfy/dsh-plugin/main/assets/screenshots/dsh-maintain/install.png)
![重启确认](https://raw.githubusercontent.com/mzzsfy/dsh-plugin/main/assets/screenshots/dsh-maintain/restart.png)

## 功能

- 版本监测:host 启动即检查一次,按轮询间隔重复检查(内存快照,不持久化);当前版本与追踪通道最新版对比,落后即提示。运行版本(宿主启动时缓存)与已装版本(受管链接 `dsh_link` 当前指向安装槽的清单版本)分开统计与展示,落后判定以运行版本为准,已装版本领先运行版本时提示"重启后生效"。定时轮询为软依赖:宿主 timer 服务不可用时仅停用自动轮询,面板显示降级提示,手动刷新仍可使用。通道最新版不是合法精确 semver 时安装入口禁用(宿主入口必以 400 拒绝)。
- 版本更新内容:面板"更新内容"按钮按追踪通道最新版本拉取 GitHub Releases 发布说明(deepseek-ai/deepseek-harness,标签 `dsh-v<版本>`,npm 清单无 readme 字段故以官方 releases 为事实源;通道最新版就绪前按钮禁用)。数据源为 releases 页面而非 api.github.com(未认证 API 限流 60 次/小时/IP 且按 IP 共享,页面限流实际宽松),从 markdown-body 正文容器深度配对提取,渲染后 HTML 映射回行文本(标题→# 前缀、列表→- 前缀、块级闭合→换行、实体解码;标签剥离先于实体解码,产物只经 React 文本节点输出无 XSS 面),页面响应体上限 512KB 流式截断;页面 URL 自建,无需远端 URL 白名单。弹窗展示版本、发布时间与正文,附"在 GitHub 查看"源站链接,无发布说明时明确提示;host 进程内缓存(仅成功结果,上限 20 个版本,超限淘汰最早缓存的版本,GitHub Releases 视为不可变故不设过期),同一版本重复查看不重复请求。GitHub 不可达或该版本未发布 Release 时窗内提示错误并可重试,附 releases 页兜底链接;路由 `GET /api/maintain/release-notes` 取追踪通道最新版。
- 追踪通道:在 npm dist-tags 间切换(latest / next / alpha 等,选项由检查结果动态生成),切换后按新通道判定。
- 一键受管安装(A/B 双目录编排):安装前候选验证 fail-closed——依赖树完整性检查(npm ls)+ 候选 CLI 真实执行冒烟(`node <候选bin> --version`,隔离候选环境,自然退出,不启动宿主服务),验证通过才切换链接;任一失败保留原版本服务。确认弹窗带"安装后自动重启宿主"勾选(单次意图,默认开):勾选时切换成功即调度宿主退出,由托管方式拉起新版本;取消勾选则宿主继续运行当前版本并立即恢复正常服务(维护暂停随之解除,新回合照常受理),需手动点"重启宿主"加载新版本;切换已发生而宿主仍是旧版本,运行路径一致性会拒绝再次发起升级直至重启。验证超时或切换后状态不确定时保留升级锁并强制退出宿主,拒绝后续升级直至人工核验。
- 升级前检查:确认弹窗打开即调用 `POST /api/maintain/preflight`,按安装布局、目录写权限、磁盘空间、残留 `upgrade.lock`、`state.json` 阶段、npm CLI、目标 Node engines 与插件兼容性逐项判定;升级受理路由会服务端复跑环境检查,不信任客户端弹窗。环境类硬失败阻断;插件硬不兼容时普通升级 409 拒绝并列出不兼容插件。插件扫描能力缺失只降级为 warn,不阻断旧宿主;目标版本清单按版本与镜像源缓存 10 分钟,体积取 npm `dist.unpackedSize` 加固定安装余量。
- 同时升级插件:确认弹窗可勾选「同时升级所有插件」。宿主先完成安装/切换并启动目标版本,新宿主就绪后再按新宿主的兼容性逐个更新 profile 内 `update: registry` 的组合包;只接受严格高于已装版本的版本,只升不降,稳定版优先,弃用/不兼容/无更高版本/Git 插件跳过,maintain 自身不参与。插件升级在新宿主启动后执行,因此不会用旧宿主的兼容结论误装插件;单个插件失败不阻断宿主升级,结果写入 `state.json` 并在升级卡展示更新/失败/跳过摘要;有插件失败时成功回执不自动隐藏,便于复查。该开关要求自动重启,因为插件升级需要新宿主加载。
- 安全模式:勾选后升级前临时禁用「已启用、用户安装、非只读、非 maintain 自身且对目标 DSH 版本未验证/不兼容」的插件,记录 `<prefix>/.dsh-maintain/safe-mode.json`;安装失败且未切换时自动恢复启用并清除记录,成功后由新宿主接管,可在面板「安全模式」卡逐个恢复。安装结果不确定或切换已发生时保留记录,由新宿主接管后恢复,避免与未完成 npm 写入竞争;安全模式必须自动重启(禁用插件需要新宿主生效)。安全模式不会禁用宿主只读管理插件与三个默认保护项(maintain 自身、auto-trust-all、dsh-web-startup-auth);tunnel 不再默认保护。也不会禁用设置中「安全模式白名单」勾选的精确包名;这些插件不兼容时安全模式不可用,普通升级也 409,避免远程直接失联。边界:安全模式是升级前降险,不解决宿主完全无法启动的坏插件救援,后者仍需外部启动器/人工禁插件。
- 升级进度:状态接口与面板展示阶段时间线(准备/安装/验证/切换/等待重启;插件同步升级在新宿主启动后单独显示)、阶段耗时、总耗时与升级输出尾部(16KB,ANSI 清理;含插件同步升级逐项日志);浮条同步显示当前阶段与已用时长,不伪造百分比。进程内本次升级与 `state.json` 历史记录分开标记,刷新页面不会把上次结果误显示成本次升级;落地健康复核只更新持久状态,不伪造进程内升级结果。
- 升级落地回执:新宿主 `appReady` 后核对 `state.json` 目标版本/路径与运行版本,读取 `pluginInventory` 与 `pluginManager.listBundles` 汇总插件装载健康;成功写 `healthy`、失败插件或安装错误写 `degraded` 并列出失败项,面板展示上次升级结果;成功结果只在首次进入面板展示,客户端经 `POST /api/maintain/upgrade/receipt-ack` 把 `receiptSeen` 写回 `state.json`,后续进入不再重复展示,失败/待重启结果仍保留;依赖未声明 bundle 与平台不支持(`not-bundle`/`unsupported-platform`)按插件管理器的预期状态排除,不计入失败。旧 state 停在 `awaiting-restart` 但运行版本已匹配时按落地处理,不再永久挂起;已落地/已降级状态在新宿主启动时复核一次,纠正旧版本误判。
- 活跃工作门控(fail-closed):升级受理与提交切换前检测运行中的 agent 会话与后台 job(jobs 按官方 `list(caller)` 字符串语义逐 agent 查询)。检测面不可用即拒绝升级(不冒充弱一致窗口放行);存在活跃工作拒绝且不可越过;重启仍按原语义带 force 可越。概要随 status 提供给面板。terminals 服务面 0.2.0 对插件 ctx 不可探属宿主常态,不因面缺失降级:agents 计数覆盖 running 期间的终端活动;agent 转 idle 后仍存活的终端不可计数,升级会中断它们,属已知盲区。
- 审计日志:升级/重启/安全模式的触发、落定、恢复与拒绝各输出一行结构化日志(`audit endpoint=… outcome=…`),动态串单行化,便于事后排查。
- 面板设置编辑:轮询间隔、镜像地址、安全模式白名单均可在面板直接编辑保存,与 settings.yaml 等效(轮询间隔保存即重排,镜像地址保存即重查,白名单保存后下次预检生效);设置区位于面板最底部。白名单通过 `GET /api/maintain/plugins` 拉取当前已安装的 profile 插件并勾选,安装内置与未安装项不展示;官方/只读/默认保护插件只展示不可勾选,当前不存在的已保存项保留为可取消的孤儿项;host 侧拒绝非 http(s) 地址与带查询串/锚点的镜像地址(拼接 dist-tags 路径时 query 会吞掉路径),白名单按精确包名去空去重、上限 100 项。
- 操作反馈:检查更新、通道切换、面板保存与升级触发的失败经全站浮出通知(@mzzsfy/dsh-common-tools,由本包 `cordis.patch.yml` 自带的装载行引入)提示;页面加载失败与重启超时等状态提示仍在面板内展示。
- 安全重启:两段式确认后延迟数秒直接终止宿主进程(不经宿主 `appExit` 优雅停机,理由见「重启须知」);重启指令在响应发出后延迟执行,退出调度与响应冲刷解耦,客户端断连不影响宿主退出,浏览器先收到回执进入重启等待态;确认后面板立即提示重启进行中,轮询探测宿主恢复,且主文档连续多次探测可加载(宿主页面服务 fallback 已就绪并稳定)后再稍候片刻才刷新页面,避免启动窗口内刷新拿到 404,总时长最多 1 分钟,超时提示转人工检查。进程以专用非零退出码 75 离场(见「重启须知」的托管默认策略),托管方式据此拉起。动作路由带宿主闸门、跨源守卫(Origin 与 Host 不符即 403)与精确 `application/json` content-type 校验,与外层鉴权插件(如 dsh-web-startup-auth)互补;未部署鉴权插件时同源请求仍匿名可达。

## 安装

```sh
dsh plugin --profile web add @mzzsfy/dsh-maintain
```

标准插件安装:包进入 profile node_modules(pnpm hoisted 布局),bundle patch 随下次 dsh 重启自动生效,无需手动编辑 cordis.patch.yml;宿主 peer(`@deepseek-ai/*`)不落盘,经目录逐级兜底解析到 dsh 本体全局安装目录。

开发安装(仓库工作副本直挂,不经 npm 发布):

```sh
node scripts/dev-link.mjs dsh-maintain   # 仓库根执行:归一 profile 依赖行 + 挂 junction
```

工作副本以 junction 挂进 profile,host 半区改动保存约 5 秒防抖窗口热重载,client 半区改动刷新页面即生效,无需发版;规约与全仓归一见 `node scripts/dev-link.mjs all`。勿用 `link:` 或裸相对路径手工挂载——realpath 后 peer 从仓库目录解析会失败(早期"必须手工拷贝部署"结论的成因,对 dev-link junction 不成立,junction 内 peer 沿 profile 解析)。

## 设置(配置节,热加载)

```yaml
maintain:
  channel: latest                                # 追踪通道,选项以检查返回的 dist-tags 为准
  pollIntervalSec: 21600                         # 轮询间隔秒,仅正数启用周期检查,0/负数禁用,上限 30 天
  registryBase: https://registry.npmjs.org       # 官方源不可达时可改为镜像地址
  safeModeWhitelist: []                           # 安全模式不自动禁用的精确包名
```

配置落在 profile 条目 `maintain` 的 config 节(即上例 settings.yaml 的 `maintain:` 块,经 dsh 配置迁移后为 profile patch 内该条目的 config 键):宿主以插件静态 `Config` 导出生成节表单,字段均为 volatile,面板保存经 configEditor 写回、仅 volatile 变化时 loader 原地热更(不重启插件)。轮询间隔与镜像地址亦可在设置面板"版本与运维"页底部直接编辑保存,安全模式白名单在面板中按当前已安装 profile 插件勾选保存(等效配置节,热生效)。

## 重启须知

- 重启依赖托管常驻(pm2 / systemd / supervisord / Kubernetes / 容器等)自动拉起;手动终端启动的进程不会自动恢复。重启判定为三信号:失联恢复、宿主进程启动时刻(bootAt,容器内 pid 恒 1 场景的可靠信号)或 pid 变化。
- 退出码:重启与升级落定的退出用的是专用非零码 **75**(sysexits `EX_TEMPFAIL`,语义为"临时离场、应当重试拉起")。之所以不用 0——进程管理器按退出码判断是不是异常退出:systemd 默认 `Restart=on-failure` 只拉起非零/信号退出,supervisord 默认 `autorestart=unexpected` + `exitcodes=0` 只拉起不在正常码表内的退出,二者都会把 0 当正常退出而**不**拉起,重启就变成永久停机。因此:
  - pm2:`autorestart` 默认 `true`,任何退出都会拉起,无需额外配置;
  - systemd:默认 `Restart=on-failure` 即可,无需改;若显式设成 `Restart=no`/`on-abnormal`,需自行改回;不要把 75 加进 `SuccessExitStatus=`;
  - supervisord:默认 `autorestart=unexpected` 即可,无需改;若显式写了 `exitcodes=0,2` 之类的白名单,不要包含 75;
  - Kubernetes/容器:`restartPolicy: Always`/`on-failure` 均可拉起;`Never` 不会。
  未托管(手动终端启动)时 75 只体现为 shell 的非零退出码,重启后需你重新运行宿主。
- 确认重启后本页以严格顺序轮询探测宿主恢复(任意时刻至多一拍在途),主文档连续多次探测可加载(页面服务就绪并稳定)后稍候片刻才整页刷新;面板后台探测请求失败或拿到 404 均属宿主退出与启动窗口的中间态,面板保持等待提示。重启请求本身收到明确 HTTP 回绝(如升级互斥 409)时立即提示失败,不进入等待轮询。若你手动刷新后浏览器显示 404,说明宿主仍在启动窗口内,稍候数秒再次刷新即可。轮询总时长最多 1 分钟,超时通常是宿主未被进程管理器拉起(手动终端启动)、退出失败或启动过慢,请检查进程管理器后手动刷新排查。
- 退出语义:响应当即返回,延迟窗口(数秒)到点直接终止进程,不走宿主 `appExit` 的优雅停机。优雅停机逐个 agent 取消在跑回合并落 `turn/end aborted(disposed)`,自动继续类插件把 `aborted` 视为人为停止,重启后不会续跑;直接终止则回合停在 `turn/start`,下次启动由会话日志收尾补 `interrupted`,自动继续类插件(如 dsh-keep-working)才会从断点续跑。代价是插件 disposer 不执行:工具子进程与终端不随重启清理,重启前请确认没有需要收尾的长任务。
- 维护闸门只拦还没开始干活的新回合:在跑回合的后续步与目标轮次一律放行。宿主把被拒的 pre-step 记成 `turn/end blocked`,该步没有模型输出,但与模型末行 `TASK_BLOCKED` 写法不同;恢复方只能按 `blockedReason` 与回合尾部标记区分。目标轮次的拒绝更会被 goal driver 记成 `blocked(prompt-rejected)`,整条目标从此停摆。放行后这些回合在进程退出时停在 `turn/start`,按上一条语义续跑。载荷缺 `step` 的宿主按新回合处理,维持暂停契约。被拒回合已 claim 的消息不会回到队列,也不会进入事件流——这是宿主 inbox 语义,恢复方只看到 `blocked`,无法还原原始输入。
- 存在活跃工作(agent 会话/后台 job/终端)时重启被 409 拒绝,确认按钮显示活跃计数,再次点击即以 force 越过;force 重启不等待任务收尾,在跑回合按上述语义留待下次启动续跑。会话已持久化,未装自动继续插件时可手动 resume。
- 升级进行中重启请求返回409(双向互斥);升级成功触发的自动重启同样会中断在跑任务,依赖托管的活跃工作请自行评估升级时机。

## 开发

```
cd packages/dsh-maintain && npm test
```

路由测试静态导入宿主 peer；缺依赖会报 ERR_MODULE_NOT_FOUND 并失败。新 clone 先按根 DEVELOPMENT/dev-loop.md 初始化解析桥，再执行包内 `npm test`。平台专属测试仅按适用平台跳过。

## dsh 版本兼容

按仓库动态窗口验证(scripts/compat/window.mjs),不预置任何固定版本槽:主测 = 渠道 dist-tag 最新 rc,完全适配口径;基线 = npm latest,不崩溃底线口径;主测与基线同版时收敛单槽。兼容面以窗口实测为准,不逐版本承诺。逐轮实测结论见 `docs/兼容性测试/逐包测试进度.md`(本地维护,不入库)与本包 `兼容性测试.md`。
