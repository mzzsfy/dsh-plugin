# dsh-maintain 升级根治 BDD(审核未通过；不得据此实施)

背景:2026 年 0.2.0/0.2.1 混装事故——`npm install -g` 在宿主活体期半程失败
(FILE_LOCKED 类:EBUSY/EPERM/杀毒/索引),磁盘树落成 0.2.0 connection + 0.2.1
web-app 的混装态;启动即崩,外部 shell 循环按 ~14 秒节拍反复拉起,全程无一处
诊断。现行链(`index.js` `performUpgrade` → `upgrade.mjs` `runUpgrade`)只看
npm 退出码与 stale 复读,无树完整性对拍。

两个根因,根治必须同时消除:

1. 安装发生在宿主活体期——进程写自己脚下的文件,锁面(宿主句柄/杀毒/索引)
   与「半程失败即混装」由此而来。
2. npm 退出码被当作完整性证明——无树对拍,混装树静默进入运行态。

**平台适用范围**:编排器链路(WMI spawn / taskkill / npm.cmd)仅 Windows。
POSIX 侧本期刊持现行活体期升级链路(`upgrade.mjs` 双平台保留,用户模板照
旧生效),但 W-1/W-4 对拍红牌为纯 node 判定,双平台生效——POSIX 获得显式
诊断,不获得死后编排。文档中「升级入口根治」的承诺均限定 Windows;POSIX
处置为已知局限(见文末)。

**根治的定义 = 手动入口与升级入口全设防,缺一即换洞。** 升级动作共三条路径,
设防归属如下:

- 面板升级入口(Windows):安装移出活体期(编排器,宿主死后动文件),verify
  不过不交付。
- 手动 `npm install` 入口(宿主活体期,无编排器介入):in-host 对拍 + 红牌,
  保证不静默。
- 面板修复路径:手动入口的**面板变体**——树已损伤时由面板发起的活体重装,
  豁免树自洽前置(树已烂,对拍必不过),失败即时回到红牌(W-5)。

**明确不承诺的边界**(与上游 `dsh upgrade` 能力等价,上游同样防不了手动入口):

- shell 循环未部署 gate 协议:安装窗口竞态存续,降级为启动对拍兜底(L-5)。
- 新装/回滚/手动修复三连全败:受控停机等人工,是一切升级系统的共同终点。
- 宿主死亡窗口内不存在推送式诊断:宿主外诊断的唯一载体是盘上文件(status
  的 step 步迹与终态),无宿主则无面板呈现。

## 核心不变式

- **INV-1** verifyTree 是唯一完整性判据,只做版本对拍,判定单位为**内部包
  引用闭包**:从 root `package.json` 出发,凡 root 或任一内部包声明依赖的
  `@deepseek-ai/dsh-*` 包(声明字段 = `dependencies` ∪ `peerDependencies`),
  其盘上定位 = 引用方包根下 `node_modules/<name>/package.json`(npm 嵌套
  解析语义,与 require 解析一致;事故实测布局为嵌套非平铺,顶层
  `node_modules/@deepseek-ai/` 下仅 `dsh` 本体),必须存在且版本满足引用方
  声明;定位缺失即不满足,无平铺兜底(fail-closed)。root 自身 version 须为
  合法 semver。判据按**期望版本参数**区分两种消费形态:启动/触发对拍形态
  不传期望版本,只查闭包自洽(磁盘领先运行是合法常态,不比对 running,T-8);
  编排器与修复路径(W-5)传期望版本,额外断言 root == 期望版本(target /
  previousVersion,装到非目标版本 = 不 ok,T-10),同一函数参数化区分,
  不设两套实现。清单不硬编码包名,由闭包遍历动态确定,自动随代际演进。
  不做 require 冒烟:boot 本身即冒烟,失败处理一元化——verify 不过就走
  回滚或红牌,不区分「版本混装」与「内容截断」,冒烟分类没有消费者。
- **INV-2** 面板升级入口不交付 verify 不过的树:编排器自身零拉起,落盘
  (新装或回滚)verify 通过才算完成;verify 不过的树是否被循环 spawn 由
  循环协议的受控停机窗口限定,超窗恢复属已声明局限(见已知局限)。
- **INV-3** 全路径同源设防:面板升级入口由编排器接管(仅 Windows);手动
  入口由启动对拍(W-4)与升级触发前置对拍(W-1)兜底;面板修复路径是手动
  入口的面板变体,同样受红牌兜底(W-5),且同样受错树拒绝约束(W-3)。
  三路径消费同一 verifyTree。
- **INV-4** gate 互斥是协作式的:互斥正确性依赖循环侧 gate-aware;协议未
  部署时系统不产生新故障形态,降级路径由红牌覆盖。gate 带 deadline,过期
  即视为不存在——编排器任何死法都不会永久封死循环。
- **INV-5** 静默不可能(可启动树上):任何树不一致,只要宿主能启动,最终都
  以显式形态呈现——启动对拍红牌、升级触发前置拒绝、status 面板消费、修复
  失败即时红牌,四形态覆盖。宿主无法启动的形态不存在宿主内诊断,唯一载体
  是盘上 status 文件(步迹 + 终态),此为已声明边界,非已消除故障。
- **INV-6** 编排器快照零依赖:触发时把包内 `src/orchestrator.mjs` 复制到
  `$DSH_HOME` 后经 WMI 启动。WMI 调用载体 = PowerShell
  `Invoke-CimMethod -ClassName Win32_Process -MethodName Create`(wmic 已从
  新版 Windows 移除,不可用);失败判定 = `ReturnValue` 非 0 或调用超时。
  机制先例 = boot-keep.mjs 注释(WMI 上下文脱离 pwsh executor 的 job 对象,
  跨命令存活)——是**同机制先例,非同代码**:仓库尚无 Win32_Process.Create
  的调用实现,本包首次落地。快照仅用 node: 内置模块,不 require 全局树内
  任何文件——npm 半程替换模块不可能伤及编排器自身。verify 逻辑与插件内
  实现双实现同源,parity 测试锁定(P-1)。
- **INV-7** 环境钉定,不信任 WMI 进程的 PATH 与环境(nvm 多版本机,WMI
  进程不继承宿主环境变量):node/npm 绝对路径由宿主 `process.execPath`
  推导传入(npm 走 `<nodeDir>\npm.cmd`);三信号路径全部显式传参,不从
  环境推导。升级前置校验:运行树路径(`runningHostCandidate` 产物)与
  nodeDir 全局树路径(`hostPackageCandidates` 产物)各自经 `path.resolve`
  归一后全等比对,不等即拒绝升级(W-3)。
- **INV-8** 三信号分工,受众互不混用:
  - **lock**(现有 `UPGRADE_LOCK_PATH`,受众 = maintain 路由 + 编排器互斥):
    「升级进程在跑」的门闩。内容 `{startedAt, pid, role}`,role ∈
    `host | orchestrator`。触发时宿主写入(role=host);编排器启动即
    **接管**(覆写为自身 pid + role=orchestrator)。互斥谓词 = 持有者
    role=orchestrator **且** 存活(`process.kill(pid, 0)`)且非自身 → 零动作
    退出;host 角色锁不构成互斥(宿主在 spawn 之后才退出,首启编排器必然
    读到活 host 锁,必须允许接管)。删除责任:编排器任何终态(含异常)
    删除,WMI spawn 确认失败时宿主即删(W-2)。
  - **gate**(`$DSH_HOME/dsh-maintain-upgrade.gate`,受众 = shell 循环):
    安装窗口互斥,内容 `{startedAt, deadline, targetVersion, pid}`;
    触发时写,编排器终态删(三种终态都删),循环按 deadline 判过期。
  - **status**(`$DSH_HOME/dsh-maintain-upgrade-status.json`,受众 = 新宿主
    面板 + 循环):编排器状态文件,字段 `{state, step, targetVersion,
    previousVersion, startedAt, finishedAt, reason}`;state 终态机
    `running | ok | rolled-back | failed-rollback`,step 为编排器序列步迹
    (宿主死亡窗口内的唯一诊断载体)。新升级启动覆写;损坏文件按无 status
    处理(lastUpgrade 为空 + 告警日志),fail-closed。
  - treeDamage **不是** status 文件字段:`currentStatus`(API 响应)派生
    字段,值 = **最近一次** verifyTree 对拍结果,由三个消费点统一更新——
    apply 启动对拍(W-4)、升级触发前置(W-1)、修复复检(W-5);任一点通过
    即翻绿,不入盘。

## 常量与窗口

实施期集中在包内常量区定义,禁止散落;宿主 ↔ 快照镜像项进 parity 对拍(P-2)。

| 常量 | 值 | 推导 | 镜像 |
|------|-----|------|------|
| `ORCH_WAIT_EXIT_TIMEOUT_MS` | `30 * 1000` | exit(0) 正常毫秒级,兜底值 | 快照 |
| `ORCH_WAIT_POLL_MS` | `1 * 1000` | 等死轮询粒度(.pid + CreationDate 对拍) | 快照 |
| `ORCH_NPM_TIMEOUT_MS` | 复用 `UPGRADE_TIMEOUT_MS` | 与现行升级单次超时同源 | 快照 |
| `ORCH_RETRY_PAUSE_MS` | `5 * 1000` | 与 FILE_LOCKED 退避首值同源 | 快照 |
| `ORCH_KILL_GRACE_MS` | 复用 `KILL_GRACE_MS` | taskkill 强杀后的树终止宽限(与 upgrade.mjs 同源) | 快照 |
| `ORCH_WMI_CALL_TIMEOUT_MS` | `10 * 1000` | PowerShell 调用上界 | 快照 |
| `ORCH_NPM_RUNS` | `3` | 首装 + 重装 + 回滚 | 快照 |
| `LOCK_STALE_MARGIN_MS` | `60 * 1000` | 预算外裕量,吸收进程调度抖动 | 快照 |
| `ORCH_TOTAL_BUDGET_MS` | 计算式:`ORCH_WAIT_EXIT_TIMEOUT_MS` + `ORCH_KILL_GRACE_MS`(等死步强杀收敛) + `ORCH_NPM_TIMEOUT_MS` × `ORCH_NPM_RUNS` + `ORCH_KILL_GRACE_MS` × `ORCH_NPM_RUNS`(各 npm 步强杀收敛) + `ORCH_RETRY_PAUSE_MS` × (`ORCH_NPM_RUNS` - 1) + `ORCH_WAIT_POLL_MS` + `LOCK_STALE_MARGIN_MS` | 编排器全窗口最坏时长(与序列逐步骤一一对应) | 快照、gate.deadline、lock 阈值 |
| `UPGRADE_LOCK_STALE_MS` | `ORCH_TOTAL_BUDGET_MS` | 替换现行公式(裕量已入预算);**需改为导出**(参与 parity) | 快照 |
| `HOST_EXIT_DELAY_MS` | 复用 `RESTART_DELAY_MS` | 响应回执先于进程离场的既有延迟语义 | 快照 |
| `CONTROLLED_STOP_WINDOW_MS` | `2 * 60 * 60 * 1000` | 起算点 status.finishedAt;远大于任何人工观察延迟,近小于过夜;循环参考片段同值引用 | 循环片段(手工同步) |
| 循环 gate 轮询间隔 | `5 * 1000` | 与 boot-keep `WATCH_POLL_MS` 同量级 | 循环片段(手工同步) |

## 组件与契约

| 组件 | 位置 | 职责 |
|------|------|------|
| verifyTree | `core.mjs` 新增纯函数区 | 完整性判据;`readFileImpl` 注入,零副作用 |
| 编排器快照源 | `src/orchestrator.mjs`(单文件) | 触发时复制 `$DSH_HOME` 执行;P-1 提取对拍的固定读取位置 |
| host 接线 | `index.js` 触发路由改造 + 启动对拍 + 修复路由 + status 消费 | 编排器的宿主侧一半 |
| client 接线 | `client.js` 红牌 + 修复按钮 + lastUpgrade 卡 + 弹窗改造 | 显式诊断与人机动作 |
| 循环协议 | 文末参考片段,循环脚本属用户域 | gate-aware 暂停与受控停机 |

verifyTree 判据细节:

- 内部包清单不硬编码,由闭包遍历动态确定(INV-1)。
- 范围满足判定支持五种语法:**精确版本 | `^x.y.z` | `~x.y.z` |
  `>=x.y.z(-pre)` | `||` 或集**(各候选递归套用同一判定,任一满足即
  满足);prerelease 匹配遵循 semver 语义(`0.2.0 >= 0.2.0-rc.2` 为真),
  规则照抄 semver@7 satisfies(core.mjs 内嵌其比较语义的既有先例),
  实现载体 = core.mjs 新增 range 满足函数(与 parseSemver 同区)。子集外
  spec(`workspace:*` / URL / x-range 等)一律 fail-closed(判不满足),
  reason 必须显式列出未识别的声明原文,供人工判定树是否实际健康——
  fail-closed 的死锁面(升级与修复的 verify 永不过)以此显式化为出口,
  并落已知局限。
- verifyTree 的 root 路径 = `runningHostCandidate` 产物(W-3 已保证与全局
  树归一全等),各消费点不得自选路径来源。
- 依赖范围读取:引用方 `package.json` 的 `dependencies` 与
  `peerDependencies` 两字段联合查找;两处皆无该包声明 → fail-closed
  (判不满足)。

**升级命令构造(Windows 编排器路径与修复路径)**:固定构造式
`npm install -g @deepseek-ai/dsh@<version> --registry=<registryBase>`,
registryBase 取用户配置(镜像部署可达);修复路径追加 `--force`。
`upgradeCommandTemplate` 在这两条路径**失效**(程序化自愈不混入用户模板),
其适用面收窄为 POSIX 活体路径;失效面在面板升级弹窗文案中声明。

**面板弹窗契约改造**:编排器路径下宿主必死,现行 `UpgradeDialog` 的
「未勾选自动重启则安装后继续运行当前版本」承诺失效。处置:请求字段
`autoRestart` 保留(400 守卫与调用面不动),语义固化为「升级完成后由外部
守护循环拉起」(该路径下拉起职责始终在循环,勾选仅影响终态文案分流);
弹窗文案重写,移除「继续运行」承诺,声明模板失效面(见上)。

**previousVersion 不可知处置**:`resolveHostVersion` 返回 null 时触发侧
400 拒绝升级(回滚锚点缺失,不进入编排器窗口);修复路径豁免该守卫,
见 W-5。时间戳约定:gate/status 文件中的 `startedAt` / `finishedAt` /
`deadline` 一律 epoch 毫秒数值,禁止 ISO 串(循环侧做算术比较)。

编排器输入(WMI spawn 显式传参,缺一不可实施):`nodeDir`、运行树路径、
`targetVersion`、`previousVersion`、`registryBase`、`hostPid`、
`hostCreationDate`、`lockPath`、`gatePath`、`statusPath`、各窗口常量。
`hostCreationDate` 由触发序列中宿主经 WMI 查询自身进程采集(Node 无原生
API);等死轮询对目标 PID 查询 CreationDate,不等即视为 PID 复用。

WMI 启动命令行参考形态(宿主侧构造):

```
powershell -NoProfile -Command "Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine='<node.exe> <快照绝对路径> <参数串>'}"
```

引号规则:`CommandLine` 值内**所有**含空格的路径(`node.exe`、快照绝对
路径、参数串内路径——默认 nodeDir `C:\Program Files\nodejs` 与用户目录
均可能含空格)一律以 `\"` 转义双引号包裹,不依赖 CreateProcess 对未加
引号路径的递进解析。失败判定 = `ReturnValue` 非 0 或
`ORCH_WMI_CALL_TIMEOUT_MS` 超时。

编排器序列(单文件,步骤幂等,重入 = 重跑):

```
判定 lock(持有者 role=orchestrator 且存活且非自身 → 零动作退出;否则接管)
→ 写 status(state=running, step 逐步覆写)
→ 等宿主死(PID + CreationDate 对拍轮询;超时 taskkill /T /F,等
  ORCH_KILL_GRACE_MS 收敛后继续)
→ npm install -g @deepseek-ai/dsh@<target> --registry=<registryBase>
  (每次 npm 步带超时 ORCH_NPM_TIMEOUT_MS;超时 → taskkill 杀 npm 树 →
   等 ORCH_KILL_GRACE_MS 收敛 → 继续降级链,禁止残留 npm 与下一步并发)
→ verifyTree(树, 期望版本 = target:闭包自洽 + root==target)
→ 不过 → 间隔 ORCH_RETRY_PAUSE_MS → 同命令 + --force 重装 → 再 verify
→ 仍不过 → 间隔 ORCH_RETRY_PAUSE_MS
          → npm install -g @deepseek-ai/dsh@<previousVersion> --registry=<registryBase>
          → verifyTree(树, 期望版本 = previousVersion)
→ 终态写 status(ok | rolled-back | failed-rollback, finishedAt 落值)
→ 删 gate → 删 lock → 退出
```

verifyTree 双消费形态见 INV-1:编排器断言期望版本,启动/触发对拍只查
闭包自洽。失败处理一元化:任何 verify
不过都走同一条降级链,不做失败分类分支(与 `runUpgradeWithRetry` 的按类
退避是两种策略,仅重试思想同源)。

## 场景

### 判据层(verifyTree,闭包自洽)

- **T-1** 树完整:root 合法 semver,闭包内各包存在且版本满足引用方声明
  → `ok:true`。
- **T-2** root version 非法 semver/缺失 → 不 ok。
- **T-3** 闭包内包目录缺席 → 不 ok(定位仅查引用方包根 node_modules,
  无平铺兜底)。
- **T-4** 闭包内包版本越界(装了 0.2.0,引用方声明 `^0.2.1`,事故形态:
  web-app 0.2.1 声明 connection 0.2.0 不满足)→ 不 ok。
- **T-5** 声明为子集外语法(`workspace:*` / URL)→ fail-closed 不 ok。
- **T-6** 清单缺失/JSON 损坏(截断形态)→ 不 ok。
- **T-7** 闭包内包 version 非法 semver → 不 ok。
- **T-8** 树自洽但 root 领先运行版本(restartPending 形态)→ ok(自洽判定
  不含 running 对拍,磁盘领先是合法常态)。
- **T-9** 深层闭包:内部包声明依赖的再内部包缺失/越界 → 不 ok(DFS 全深)。
- **T-10** 编排器形态期望版本断言:闭包自洽但 root ≠ 期望版本(npm 异常
  装到其他版本)→ 不 ok;启动/触发形态无此断言(T-8 同形态判 ok)。

### 编排器层

- **S-1** happy path:接管 host 角色锁 → 等死成 → 装成 → verify 过 →
  status=ok → 删 gate → 删 lock。
- **S-2** npm 半程失败(EBUSY 注入)→ 间隔退避 → --force 重装 → verify 过
  → status=ok。
- **S-2b** npm 挂死(注入不退出的 npm shim)→ ORCH_NPM_TIMEOUT_MS 超时 →
  taskkill 杀 npm 树 → 等 ORCH_KILL_GRACE_MS → 降级链继续;残留 npm 不与
  下一步并发写全局树。
- **S-3** 重装仍败 → 回滚 previousVersion → verify 过 → status=rolled-back。
- **S-4** 回滚也败 → status=failed-rollback(reason 带三连败细节)→ 删
  gate → 删 lock → 退出;不 spawn 由循环协议(L-3)承接。
- **S-5** 宿主拒死:超时 → taskkill /T /F → ORCH_KILL_GRACE_MS 内退出 →
  序列继续。
- **S-6** PID 复用:目标 PID 存在但 CreationDate ≠ 传入值 → 视为已死。
- **S-7** 编排器双开:lock 持有者 role=orchestrator 且存活且非自身 →
  后到者零动作退出。
- **S-8** 编排器窗口内被扫(死亡,gate/status 未达终态):gate 到期自愈恢复
  spawn;status 停在最后 step(state=running 残留),由 W-6 残留语义呈现;
  树若半装,启动对拍红牌接住(W-4)。

### host 接线层

- **W-1** 触发前置对拍:verifyTree(磁盘树, 闭包自洽) 不过 → 409 拒绝
  升级,红牌引导修复;禁止从混装树出发二次升级(事故现场形态)。磁盘领先
  运行(restartPending)自洽 → 放行,不置红牌(T-8)。
- **W-2** 触发序列(Windows):W-1 通过 → 采集自身 CreationDate → 三信号
  写入(lock/gate/status=running)→ 快照复制 `$DSH_HOME` → PowerShell
  `Invoke-CimMethod` spawn(显式传参清单见编排器输入;ReturnValue 非 0 或
  `ORCH_WMI_CALL_TIMEOUT_MS` 超时 = 失败)→ spawn 成功 →
  `scheduleHostExit(delayMs = HOST_EXIT_DELAY_MS)`;spawn 失败 → 删除三
  信号 → 按升级失败落定(面板报错),不 exit。**升级触发序列内宿主不再跑
  npm**(修复路径除外,W-5)。
- **W-3** 错树拒绝:`runningHostCandidate` 产物与 `hostPackageCandidates`
  产物各自 `path.resolve` 归一后全等 → 放行;不等 → 拒绝升级,不 spawn
  (INV-7)。修复路由同检(修复写全局树,多副本部署下同样危险)。
- **W-4** 启动对拍:apply 时 verifyTree(磁盘树, 闭包自洽) 不过 → 结果入
  内存缓存 → `currentStatus.treeDamage=true` → 面板红牌,升级入口置灰,
  修复入口亮起;覆盖手动 npm install 绕面板路径。root 与 runningVersion
  同源同文件,启动时恒相等,该半区无判别力,防护全部来自闭包半区。
  清除遵循 INV-8 统一更新语义(任一消费点复检通过即翻绿)。
- **W-5** 一键修复:复用升级通道(内部 `runUpgradeWithRetry`,固定构造式
  + `--force`,跳过 W-1 前置对拍;经 W-3 错树检查)。target 取通道最新版
  (channelLatest),tags 未就绪(channelLatest 为 null)→ 400 拒绝,文案
  指引「先检查更新」;**豁免 previousVersion 不可知守卫**(红牌场景树损伤
  可致 `resolveHostVersion` 返回 null,该守卫会挡死唯一修复入口;修复路径
  无回滚,不需要回滚锚点)。成功后 verifyTree(期望版本 = target) → 引导
  重启;修复仍在活体期,自身失败即时回到红牌(INV-5 第四形态)。
- **W-6** status 消费:apply 读 status 文件 → `currentStatus.lastUpgrade`。
  三终态照 C-3 呈现;`state=running` 残留按 `startedAt + ORCH_TOTAL_BUDGET_MS`
  判过期——未过期显示进行中,过期显示「升级窗口异常结束,树状态以启动对拍
  为准」(S-8 收敛语义);文件损坏按无 status 处理(fail-closed)。
- **W-7** 修复路由互斥:新端点入 `API_PATHS`,经既有 API_PATHS ↔ client
  `*_URL` 键名映射 parity 机制对拍;与升级/重启共用既有 409 门闩与活跃
  工作门控语义;修复期间升级拒绝,升级期间修复拒绝。
- **W-8** 幽灵锁过期阈值重算:`UPGRADE_LOCK_STALE_MS` = `ORCH_TOTAL_BUDGET_MS`
  (裕量已入预算),改为导出常量参与 parity。

### client 层

- **C-1** 红牌:treeDamage → 红牌文案导向修复动作;不出现「勿重启」措辞
  ——npm 已动脚下文件,活体晚 require 即加载新文件,劝阻重启只是推迟崩溃。
- **C-2** 修复按钮 → 修复路由;修复期间 `upgrade.running` 置位,现有
  upgradeWatch 观察器(`client.js` `upgradeWatch` / `showUpgradeFloat`)
  语义直接覆盖,零新观察器。
- **C-3** lastUpgrade 卡:ok / rolled-back / failed-rollback 三态 + 版本对
  展示;failed-rollback 附人工修复指引(--force 命令 + 重启);文案事实源
  在 host(随响应下发,client 不本地拼,P-3)。
- **C-4** 重启识别不变:`shouldReloadAfterRestart`(pid/bootAt 代际)原样
  保留,编排器拉起链路不改变其输入形态。
- **C-5** 升级弹窗改造:移除「未勾选则继续运行」承诺;声明模板失效面;
  autoRestart 语义固化为「升级完成后由外部守护循环拉起」(见组件与契约
  面板弹窗契约改造)。

### 循环协议层(参考片段见文末,循环脚本属用户域)

- **L-1** gate 存在且未过期 → 按片段轮询间隔等待,不 spawn。
- **L-2** gate 过期(deadline 后)→ 视为不存在,恢复 spawn。
- **L-3** status=failed-rollback 且 finishedAt 在 `CONTROLLED_STOP_WINDOW_MS`
  内 → 不 spawn,退出等人工。
- **L-4** failed-rollback 超出受控停机窗口 → 恢复 spawn。**诚实边界**:若
  树处于启动即崩形态,循环内不存在宿主内诊断(status 文件的
  failed-rollback + reason 是唯一盘上线索),此形态已列入已知局限。
- **L-5** 协议未部署(现网形态)→ 行为与现状一致,窗口竞态存续;系统不产生
  新故障形态,由 W-4/C-1 兜底显式化。这是根治方案的诚实边界。

### parity 层

- **P-1** verifyTree 双实现同源:插件 `core.mjs` 与 `src/orchestrator.mjs`
  内联副本 parity 锁定;提取器需泛化——既有 `test/logic-extract.mjs` 硬编码
  只读 client.js,须扩展读取源或为双文件加标记,非开箱即用。
- **P-2** 窗口常量 host ↔ 快照镜像对拍(常量表「镜像」列);循环侧属用户域
  不可测试,以文档引用同一推导式替代(手工同步)。
- **P-3** API 路径与红牌/状态文案键 host ↔ client 同源对拍(API_PATHS ↔
  client `*_URL` 键名映射机制延伸;文案事实源在 host,client 零本地拼接)。

## 与既有机制的关系(不删清单)

| 既有件 | 处置 |
|--------|------|
| `runUpgrade` / `runUpgradeWithRetry` | 保留:修复路径(W-5)与 POSIX 活体路径;编排器零依赖不复用其代码,失败不分类、固定单次重装,仅重试思想同源 |
| `upgradeCommandTemplate` | 适用面收窄为 POSIX 活体路径;Windows 编排器/修复路径用固定构造式,失效面在弹窗声明(C-5) |
| `judgeUpgradeFreshness` stale 判定 | 保留,消费面收窄为修复路径(编排器路径下 `performUpgrade` 不再运行) |
| upgradeWatch / `shouldReloadAfterRestart` | 不动(C-4) |
| 幽灵锁 / 409 门闩 / 活跃工作门控 | 全部保留,适用面延伸到修复路由(W-7);lock 增 role 字段与接管制(INV-8) |
| `collectActiveWork` 活跃工作门控 | 保留,升级触发前照旧拦截 |

## 测试与验收

- 单测:verifyTree 假树注入(T-1~T-10,嵌套布局夹具);编排器步骤决策函数化
  + runner 注入(S-1~S-8,含 S-2b,的编排逻辑部分);W/C 层沿用既有
  host/client 测试形态。
- 编排器全链路验收:临时目录假 nodeDir + 假 npm shim + 假 dsh 树全注入,
  不触碰真机全局树(仓库 AI 自测规约:宿主机零接触)。
- 真机升级验收:按 `DEVELOPMENT/dsh-api-alignment.md` 升级回归清单执行
  (smoke-load + 各包测试 + dev-link win 测试)。
- 循环协议验收:L-1~L-4 以文末参考片段在隔离目录集成演练,不绑定用户生产
  循环。

## 循环参考片段(bash;常量与 host 侧手工同步,无自动对拍通道)

```bash
# dsh web 守护循环(gate-aware);GATE/STATUS 路径按 $DSH_HOME 实际部署调整。
# 注意:JS 字符串字面量会剥掉未定义转义序列的反斜杠(与引号种类无关),
# Windows 路径插值进 JS 串必坏——路径一律经 env 传给 node,禁止字符串插值。
GATE="$DSH_HOME/dsh-maintain-upgrade.gate"
STATUS="$DSH_HOME/dsh-maintain-upgrade-status.json"
STOP_WINDOW=$((2 * 60 * 60))          # CONTROLLED_STOP_WINDOW_MS,秒
POLL=5                                 # 与 boot-keep WATCH_POLL_MS 同量级

while true; do
  # L-1/L-2:gate 未过期 → 等待;过期或缺失 → 放行
  if [ -f "$GATE" ]; then
    deadline=$(DSH_GATE="$GATE" node -p "JSON.parse(require('fs').readFileSync(process.env.DSH_GATE,'utf8')).deadline||0" 2>/dev/null || echo 0)
    if [ "$(date +%s000)" -lt "$deadline" ]; then sleep "$POLL"; continue; fi
  fi
  # L-3/L-4:failed-rollback 且在受控停机窗口内 → 受控停机,等人工
  if [ -f "$STATUS" ]; then
    snap=$(DSH_STATUS="$STATUS" node -p "const s=JSON.parse(require('fs').readFileSync(process.env.DSH_STATUS,'utf8'));(s.state||'none')+' '+(s.finishedAt||0)" 2>/dev/null || echo "none 0")
    state=${snap% *}; fin=${snap#* }
    if [ "$state" = "failed-rollback" ] && [ "$((fin + STOP_WINDOW * 1000))" -gt "$(date +%s000)" ]; then
      echo "[keep] 升级回滚失败,受控停机等人工;详情: $STATUS"; exit 0
    fi
  fi
  dsh web
done
```

## 已知局限

> **本轮未解决阻断**：gate 到期错误授权启动；lock 接管非原子；WMI
> 结果未知被当成确定失败；kill 失败后可能继续安装；多宿主/多 HOME 互斥
> 作用域错误；Node 依赖定位与 nvm 路径归一错误；清单版本不能证明文件
> 完整性且 boot 失败没有回滚边；活体修复保留病因；损坏信号默认放行；
> 检查 gate 与 spawn 存在竞态。以上不是可接受的根治边界，必须重设计。
> 逐条证据和修正要求见[审核报告](./升级根治-审核.md)。

- **range 语法 fail-closed 的死锁面**:闭包内出现五种子集外的声明语法时,
  verify 永不过——编排器路径三连败 failed-rollback 受控停机(S-4/L-3),
  修复路径失败即时回红牌、重试永不过(W-5);reason 显式列出未识别声明
  原文供人工判定,手动 `npm install --force` 不受影响。消除它需扩充
  range 子集,随真实发行树语法演进维护。
- **启动即崩形态无宿主内诊断**:failed-rollback 超出受控停机窗口后循环恢复
  spawn,若树处于启动即崩形态(回滚失败残留),循环内无任何宿主内诊断,
  唯一盘上线索是 status 文件的终态与 reason(L-4)。消除它需要循环侧读
  status 并展示,属用户域,本期不做。
- **POSIX 无死后编排**:POSIX 升级入口维持活体期 npm + 对拍红牌,混装概率
  不降,仅后果显式化。
- **协议未部署 = L-5 降级态**:gate 协作是部署依赖,不阻塞本方案其余部分。
- **内容级截断(版本齐但文件烂)不在判据内**:registry 端全量哈希清单不可
  得,成本收益不成立;由回滚一元路径与 boot 冒烟接住(INV-1)。
- **三连全败 = 受控停机 + 人工**:能力边界与上游 `dsh upgrade` 一致;上游
  issue 草稿引用本文档的 verifyTree 判据与三信号语义,供宿主侧
  `dsh upgrade` 直接采纳。
