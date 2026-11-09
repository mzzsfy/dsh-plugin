# dsh-bug-perf

宿主缺陷兜底与性能补丁集合。补丁大多在浏览器半区执行;会话列表瘦身在宿主半区(包装 `sessionController.list`),宿主半区同时负责配置分发,并接收/落盘浏览器上报的采样。每个功能独立开关、独立失败,结构不匹配时记录原因或静默失效/静默等待,不影响页面与其它补丁。

定位:官方修复落地前的运行期兜底,不是宿主行为的替代实现。升级 dsh 后应复核宿主版本是否已修复,再决定是否保留。

## 功能

| 功能 | 配置节 | 兜底对象 | 行为 |
|------|--------|----------|------|
| session/follow 重建合并 | `restartCoalesce` | discussion #11272:每次 assistant rebaseline 都全量重建 `session/follow` | 包装 `RemoteStream.prototype.restart`,同一 stream 在窗口内的多次重启只保留一次尾随执行;`restart()` 无参数,最新一次可代表期间全部重建请求 |
| 终端输出看门狗 | `terminalWatchdog` | discussion #11271:并发 `terminal/attach` 流释放后 UI 输出冻结 | 监控 `webTerminals` 视图;本端曾持有写权、输出停滞超过阈值且仍持有 attach 流时调用 `view.connect()` 重连,冷却期内不重复 |
| 会话流保活 | `socketKeepAlive` | 公网/反代链路下,宿主短周期心跳把仍可用的连接判为失联 | 在 `/api/remote.mux` 连接空闲(客户端自己没有上行帧)时发送一条随机 streamId 的 `item` 帧;宿主对任意入帧刷新存活标记,未知 streamId 的 item 被忽略;仅覆盖补丁安装之后新建的连接,发过保活帧的连接被协议级关闭码关闭时累计,累计两次即熔断、健康存活后清零 |
| 任务状态流上限 | `jobStreamLimit` | 侧边栏每个会话行各订阅一条常驻 `job/list` 流(实测 361 条 job 流;会话侧 3466 个会话中 2711 个是子 agent 会话),job 变化时宿主逐条推全量帧,主线程出现数百毫秒长任务,页面越用越卡 | 默认窗口只给主会话前 `base` 条;子 agent 会话不占窗口,只在被点击时订阅;点击任意会话可加入,总数到 `max` 后淘汰最先加入的一条 |
| 会话停滞自愈 | `stuckSession` | 连接重建期间会话停在 loading,或主线程被长时间占满导致页面假死 | 会话流无有效消息行出现加载提示,或事件循环延迟超过阻塞阈值时进入停滞计时;超过阈值调用宿主 `connection.reconnect()` 主动重建连接(中止当前 generation 并立即重试,不刷新页面、不丢草稿);连续多次无效才显示提示条与刷新入口 |
| 会话列表瘦身 | `listSlim` | `session/list` 为每个会话下发完整投影快照(上下文请求头、回合大纲等),会话多时单次响应数十 MB、服务端重建要数十秒,每次打开页面都重来一遍 | 宿主半区包装 `sessionController.list`:只下发列表行消费的投影字段(`title` / `sessionListMetadata` / `inbox` / `modelSelection` / `tokenUsage`),结果缓存;会话增删即时失效,TTL 兜底标题漂移;被裁字段经会话详情接口完整返回;非 owner Remote 主体不读写缓存、每次透传原方法;关闭时包装保留、透传原方法;响应形状不符时原样透传 |

这些补丁的根因仍在宿主内部(`cancellableStream` 丢弃同 tick 的 `next()` 值、terminal-controller 队列交错、assistant rebaseline 状态机、会话流心跳判死与重建成本叠加、列表投影无按需裁剪),本插件只消除用户可观察到的后果,不改变根因。

## 配置

每个功能一个独立开关;阈值同时可在设置页调整。设置卡片以官方插件详情页为外壳,注册到 `plugins.bundle.config` 与 `settings.plugin.item` 槽,卡片内容自绘;未保存的修改有提示,保存成功就地回显,不新增独立设置页或导航项。

```yaml
- id: bug-perf
  name: '@mzzsfy/dsh-bug-perf'
  config:
    restartCoalesce:
      enabled: true
      windowMs: 100
    terminalWatchdog:
      enabled: true
      checkMs: 2000
      stallMs: 8000
      cooldownMs: 60000
    socketKeepAlive:
      enabled: true
      intervalMs: 1500
    jobStreamLimit:
      enabled: true
      base: 32
      max: 48
    stuckSession:
      enabled: true
      checkMs: 2000
      stallMs: 8000
      reconnect: true
      maxReconnectAttempts: 5
      reconnectIntervalMs: 15000
    listSlim:
      enabled: true
    diag:
      enabled: false
      reportEvery: 12
```

| 字段 | 默认 | 说明 |
|------|------|------|
| `restartCoalesce.enabled` | `true` | 关闭后不改写 `RemoteStream.restart` |
| `restartCoalesce.windowMs` | `100` | 合并窗口(毫秒);0 表示关闭合并,每次重启都立即执行;上限 2000 |
| `terminalWatchdog.enabled` | `true` | 关闭后不包装终端视图 |
| `terminalWatchdog.checkMs` | `2000` | 检查周期(毫秒);下限 250,上限 60000 |
| `terminalWatchdog.stallMs` | `8000` | 输出静默多久判定停滞;下限 1000,上限 600000 |
| `terminalWatchdog.cooldownMs` | `60000` | 同一视图两次自愈的最小间隔;下限 1000,上限 3600000 |
| `socketKeepAlive.enabled` | `true` | 关闭后不包装 `WebSocket`,不发送任何保活帧 |
| `socketKeepAlive.intervalMs` | `1500` | 空闲多久发一条保活帧;下限 500,上限 60000 |
| `jobStreamLimit.enabled` | `true` | 关闭后不限制 `job/list` 订阅数 |
| `jobStreamLimit.base` | `32` | 默认窗口:只给主会话放行的条数,子 agent 会话不占;下限 4,上限 256,且不超过 `max` |
| `jobStreamLimit.max` | `48` | 硬上限:点击会话可越过默认窗口加入,到上限后淘汰最先加入的一条;下限 4,上限 512 |
| `stuckSession.enabled` | `true` | 关闭后不检测停滞、不请求重连 |
| `stuckSession.checkMs` | `2000` | 停滞检查周期;下限 250,上限 60000 |
| `stuckSession.stallMs` | `8000` | 停滞多久后开始重建连接;下限 1000,上限 600000 |
| `stuckSession.reconnect` | `true` | 是否调用宿主 `connection.reconnect()` 主动重建 |
| `stuckSession.maxReconnectAttempts` | `5` | 连续重建次数上限,用尽后才显示提示;下限 1,上限 20 |
| `stuckSession.reconnectIntervalMs` | `15000` | 两次重建之间的最小间隔(需大于一次重建耗时);下限 500,上限 600000 |
| `listSlim.enabled` | `true` | 关闭后包装保留,每次列表调用透传原方法(不裁剪、不缓存) |
| `diag.enabled` | `false` | 开启后按采样次数把性能摘要写入宿主临时文件;关闭并刷新后内存采样仍运行,但无 diag 上报请求与落盘 |
| `diag.reportEvery` | `12` | 每多少次采样上报一次(每次采样间隔固定);下限 1,上限 720 |

客户端补丁的配置在页面加载时读取一次,修改保存后刷新页面生效;宿主半区提供 `GET/POST /api/dsh-bug-perf/config`:GET 返回归一化配置,POST 先归一化再写回当前 profile 的行配置(0.1.7 经 `configEditor`),旧宿主回退 settings 命名空间。`listSlim` 在宿主半区执行,开关由 `sessionController.list` 每次调用时读取行配置,0.1.7+ 设置保存即热更,legacy 宿主需重载插件。配置路由不设自有认证,认证由宿主 cookie/startup-auth 承担。

迁移说明:旧版 `dsh-session-manager` 的 `listSlimEnabled` 不再读取;开关现在是本插件配置表单中的 `listSlim.enabled`,默认 `true`(之前关闭过该功能的用户升级后会重新开启)。`dsh-session-manager` 0.10.0 及更早版本仍带丢失调用方上下文的列表包装,必须与本次发布同批升级到 0.11.0;只升级本插件不能消除旧包装的鉴权绕过。

## 跨版本失效策略

- 缺 `@deepseek-ai/dsh-api-gateway/client` 或 `RemoteStream.restart`:跳过重启合并,记录 `reason`。
- 缺 `webTerminals` 服务:跳过看门狗,记录 `reason`。
- 缺 `WebSocket` 构造器:跳过保活,记录 `reason`。补丁只包装安装之后创建的连接;页面在补丁安装前已建立的会话流连接不受保活保护,`installed: true` 只表示包装已装上,不代表该连接被覆盖。
- 缺 `connection` 服务:有注入能力时等待其就绪,等待期间不安装停滞自愈;无注入能力且 `connection` 缺席时退化为只显示提示条,不主动重建连接。
- 缺 `sessionController` 服务:静默等待服务就绪,期间不接管列表;服务在场但没有 `list` 方法:记录原因并跳过。
- 列表接口返回形状不符(`items` 不是数组):本次原样透传,不缓存。
- 单条投影 `values` 形状不符:该条原样返回,其余条目照常裁剪并缓存。
- 默认窗口按 `watchRows` 调用顺序(列表渲染顺序)放行,不保证正好是可见行;被拒或已被淘汰的行表现为不显示任务状态,不影响会话本身。
- 主/子会话的判定依赖会话列表快照的 `origin`/`parentSessionId`;快照未就绪时一律按主会话处理。
- 宿主把保活帧当协议错误(以 1002/1003/1007/1008/1009/1011 关闭):在发过保活帧的连接上累计两次后补丁自行禁用、恢复原始构造器,并把原因写回 `window.__dshBugPerf.features.socketKeepAlive`;连接健康存活 10 个间隔后累计清零。普通断线(1000/1001/1006)与未发过保活帧的连接不计入。
- 宿主没有 `webServer` 服务:不注册配置/采样路由,也不提供设置保存;列表瘦身仍按 `sessionController` 独立装载,客户端补丁按内联默认配置运行。
- `diag` 上报遇到 fetch 缺失、抛错或宿主路由失败:静默丢弃本次上报;内存采样继续运行,不影响页面。
- 路由注册失败/路由表冻结:记录日志,不影响宿主。
- 安装点包在 try/catch 内:客户端安装失败只进入 `window.__dshBugPerf.features`;宿主半区装载失败走宿主 `[dsh-bug-perf]` warn。运行期错误走浏览器 console 的 `[dsh-bug-perf]` 日志,不阻断页面渲染。

## 排查问题

按“补丁是否装上 -> 采样曲线 -> console 与宿主日志 -> 根因判定”的顺序走。不要先改配置,否则无法区分“补丁没生效”和“补丁生效但宿主仍有问题”。

### 1. 顺序化排查

1. 打开 DevTools Console,执行 `window.__dshBugPerf`。对象不存在:client 半区没有加载、被宿主禁用或页面不是 dsh 页面;先查插件列表与页面 console 的装载错误。
2. 对象存在,先看 `features`。每节都有 `installed` 与(失败时的)`reason`;`features.applyError` 非空表示 apply 整体抛错,后面的功能都不可信。
3. 看 `diag.samples` 的趋势,而不是单个点。重点看 `heapMB`、`nodes`、`liveSockets`、`activeStreams`、`opened/closed` 是否单调上升。
4. 看 console 的 `[dsh-bug-perf]` 日志和宿主日志。`listSlim` 只在宿主半区,客户端 `features` 里没有它,必须看宿主日志。
5. 最后判定:先排除配置关闭导致的 `installed: false`;其余补丁全部 `installed: true`、曲线也符合预期但症状仍在,说明根因在宿主或本插件未覆盖的路径;非关闭原因的 `installed: false` 或 `reason` 指向结构缺失,才是插件失效。判定前同时看文末 [已知限制](#已知限制)。

### 2. 自检入口 `window.__dshBugPerf`

| 字段 | 含义 | 怎么看 |
|------|------|--------|
| `config` | 服务端归一化后、页面实际使用的配置 | 确认 `diag.enabled` 与各节开关;刷新后才重新读取 |
| `features.<功能>.installed` | 该补丁是否装上 | `true` 只表示包装/监听已建立,不保证宿主结构一定命中 |
| `features.<功能>.reason` | 跳过原因 | `disabled`、`already installed`、`waiting for ...`、`... unavailable`、`webTerminals.view missing`、宿主日志里的 `未启用`、模块/结构错误 |
| `features.applyError` | apply 阶段未捕获错误 | 非空时先修装载问题,不要继续看曲线 |
| `features.diag` | 上报是否启动 | `installed: true` 表示定时器已按配置启动;关闭时为 `reason: "disabled"` |
| `diag.enabled` | 当前实际上报状态 | 默认 `false`;配置开启并刷新后为 `true` |
| `diag.samples` | 内存采样序列 | 每项 `{t, heapMB, nodes, sockets, liveSockets, activeStreams, messages, sent}` |
| `diag.longTasks` | 主线程长任务 | 近期 `{t, ms}`;与 `blockedMs` 一起看 |
| `diag.blockedMs` / `diag.blockedAt` | 事件循环阻塞时长/时刻 | `blockedMs` 为最近一次超过阈值的探测延迟;`blockedAt` 供 `stuckSession` 在阻塞窗口内继续停滞计时(不判恢复,阻塞本身也可触发重连) |
| `diag.errors` | 最近捕获的错误消息 | 只有 `message`(截断),没有完整堆栈;重复项比单条更有意义 |
| `diag.totals` | 累计计数 | `opened` / `closed` / `messages` / `sent` |
| `actions.reconnect()` | 手动触发一次连接重建 | `stuckSession` 安装流程完成后存在(与 `stuckSession.enabled` 无关);等待 `connection` 服务期间不存在;`connection` 缺席时调用无效果;关闭该开关只停自动检测,手动 action 仍会真实重连 |

Console 常用写法:

```js
window.__dshBugPerf
JSON.stringify(window.__dshBugPerf.features, null, 2)
copy(JSON.stringify(window.__dshBugPerf, null, 2)) // Chrome DevTools 的 copy
console.table(window.__dshBugPerf.diag.samples.slice(-30))
```

要把曲线带走,复制采样数组到表格工具画图:

```js
copy(JSON.stringify(window.__dshBugPerf.diag.samples))
```

`diag.samples` 最多保留固定数量,长时间页面不会无限增长;需要更早的历史,在复现前先打开上报并保存临时文件。

### 3. 采样通道

内存采样始终运行:每 5 秒记录一次堆、DOM、连接和流计数,每 2 秒探测一次事件循环阻塞,并记录 longtask 与最近错误。`stuckSession` 用 `blockedAt` 把主线程阻塞也视为可疑停滞:阻塞窗口内不判恢复,持续超过阈值会触发重连;因此采样不能随上报开关关闭。

上报默认关闭;默认不产生 `/api/dsh-bug-perf/diag` 上报请求、不写采样文件(配置路由仍会请求一次)。需要留档时,在行配置中显式开启:

```yaml
- id: bug-perf
  name: '@mzzsfy/dsh-bug-perf'
  config:
    diag:
      enabled: true
      reportEvery: 12
```

保存后刷新页面生效;配置热改不会重启已存在的上报定时器,与其它客户端开关一致。

开启后,每 `reportEvery` 次采样发一次 `GET /api/dsh-bug-perf/diag?d=<json>`;每次采样间隔固定,`reportEvery` 以采样次数计,不是秒数。上报落地为宿主临时目录的单行 JSONL;按实现宿主重启不会主动清理该文件,后续上报继续追加(重启持久化与轮转未单独实测):

| 平台 | 默认路径 |
|------|----------|
| Windows | `%TEMP%\dsh-bug-perf-diag.jsonl` |
| Linux/macOS | `$TMPDIR/dsh-bug-perf-diag.jsonl`;未设置 `TMPDIR` 时用系统临时目录 |

文件超过 2 MB 时轮转为 `dsh-bug-perf-diag.jsonl.1`,只保留这一份旧文件;轮转后当前文件从空开始。轮转与宿主重启持久化按实现语义描述,尚未单独实测。读取最近几条:

```powershell
Get-Content "$env:TEMP\dsh-bug-perf-diag.jsonl" -Tail 3
```

```bash
tail -n 3 "${TMPDIR:-/tmp}/dsh-bug-perf-diag.jsonl"
```

单行 JSON 的字段:

| 字段 | 含义 |
|------|------|
| `at` | 上报时的客户端时间戳(毫秒) |
| `path` | 页面路径,用于区分工作区/会话 |
| `totals` | 累计 `opened` / `closed` / `messages` / `sent` |
| `last` | 最近几次采样,字段同 `diag.samples` |
| `blockedMs` | 最近一次事件循环阻塞时长;没有阻塞时为 0 |
| `longTasks` | 最近几条长任务 `{t, ms}` |
| `errors` | 最近几条错误消息 |

数据只写本机临时文件,不上传外部服务;默认不采集到磁盘。开启后文件可能包含页面路径与错误文本,对外分享前先脱敏。

### 4. 判定表

| 症状 | 先看哪个读数 | 结论与排除 |
|------|--------------|------------|
| 页面越用越慢,`heapMB` 持续上升而 `nodes` 平稳 | `diag.samples` 的 `heapMB` 与 `nodes` | JS 堆在增长,优先怀疑监听器、回调或对象未释放;DOM 节点数平稳可排除“DOM 累积导致”的解释 |
| `nodes` 持续上升,`heapMB` 不一定同步 | `nodes`、`messages` | DOM 未回收,常见于消息列表/历史记录累积;若 `messages` 不增而 `nodes` 增,查其它动态节点与未卸载视图 |
| `liveSockets` 或 `activeStreams` 只增不降 | `liveSockets`、`activeStreams`、`totals.opened/closed` | 连接或流泄漏;若 `opened` 增长而 `closed` 不增长,先查连接关闭路径,不要先归因于渲染 |
| `blockedMs` 反复出现,`longTasks` 密集 | `blockedMs`、`longTasks` | 主线程被同步任务占满,属 `jobStreamLimit` 的目标场景;网络慢只会让等待变长,不会制造密集的 longtask |
| `totals.opened` 增长而 `closed` 不增长 | `totals` | 连接没有被正常关闭;结合 `liveSockets` 看是否为持续建立新连接;健康重连应同时增加 `opened` 与 `closed` |
| `errors` 反复出现同一条消息 | `errors` | 固定异常源在重复触发;只有消息没有堆栈,需回到 console 找同文案的抛出点,单次偶发错误不能据此下结论 |
| `heapMB` 缺失 | `samples[].heapMB` | 浏览器没有 `performance.memory`(非 Chromium 常见);改用 `nodes`、连接计数与 longtask,不能把缺失当成 0 |

### 5. 各功能为什么不生效

逐节读 `features`,不要只看总开关:

- `features.<功能>.installed === false` 且 `reason === "disabled"`:该节 `enabled` 为 false;看 `window.__dshBugPerf.config` 是否是刚保存的配置,必要时刷新页面。
- `reason === "already installed"`:包装已存在,通常是 HMR/重复装载;不是功能失效。
- `reason` 含 `waiting for webTerminals`:终端视图尚未创建;打开一次终端再看。
- `reason` 含 `webTerminals.view missing`:终端视图服务存在但缺少 `view` 入口,通常是宿主版本结构变了;`webTerminals unavailable` 则是整个服务都不在场,两者都不要靠改阈值绕过。
- `reason` 含 `gateway client unavailable` 或模块错误:模块表/宿主导入链问题;先修宿主加载,再谈补丁。
- `listSlim` 不在 `window.__dshBugPerf.features`;看宿主输出的 `[dsh-bug-perf] 列表瘦身 已装载`。出现 `sessionController.list 不可用,跳过` 或 `装载失败` 时,按同一条日志的 reason 处理。
- `installed: true` 但目标行为仍不出现:补丁已装上但结构没命中,或宿主已改变协议;按 L3 的场景重跑,不要把“装上”当成“生效”。

### 6. 日志前缀约定

客户端与宿主统一用 `[dsh-bug-perf]`:

| 日志 | 含义 |
|------|------|
| `[dsh-bug-perf] applied {...}` | 客户端配置到达并完成各节安装;后面 JSON 是各节状态 |
| `[dsh-bug-perf] terminal watchdog installed` | 看门狗已挂到终端视图 |
| `[dsh-bug-perf] terminal stalled, reconnecting` | 终端输出停滞,正在重连 |
| `[dsh-bug-perf] session stalled, requesting reconnect #N` | 会话停滞,发起第 N 次重建 |
| `[dsh-bug-perf] session recovered after N reconnect attempt(s)` | 重建后恢复 |
| `[dsh-bug-perf] socket keepalive disabled: ...` | 保活被熔断或主动关闭,原因在冒号后 |
| `[dsh-bug-perf] watchdog tick failed: ...` / `apply failed: ...` | 运行期/装载期异常;先处理它 |
| `[dsh-bug-perf] 列表瘦身 已装载 (keep=... ttl=...ms)` | 宿主列表瘦身装载成功 |
| `[dsh-bug-perf] 列表瘦身 ... 跳过/装载失败 ...` | 宿主结构不匹配或装载异常 |

日志是线索,不是错误等级;`warn` 也可能只是宿主结构不匹配后的正常降级。

### 7. 隐私与安全

- `diag` 路由没有本包自有的认证层;任何能访问宿主端口的客户端都能向临时文件追加一行,这是默认关闭的原因之一。
- 写入量受轮转上限约束,但单个文件仍可被写入到上限;不要在不可信网络暴露宿主端口。
- 上报只走本机临时文件,不向外部服务上传;文件内容含页面路径与错误消息,分享前先检查。
- payload 放在 GET query 中,可能被反代或访问日志记录;不要把敏感内容写进页面路径或错误消息。
- 关闭 `diag.enabled` 并刷新后只停止上报,内存采样继续为 `stuckSession` 服务。

## 已知限制

- 看门狗只恢复客户端消费链的卡死,不修复宿主侧丢帧;自愈会断开旧 attach 流,冻结期间的输入本来未生效。
- 只读旁观视图(本端从未持有写权)不触发自愈,避免多客户端场景抢控制权。
- 合并窗口内的重复重建被折叠为“首次立即执行 + 窗口内一次尾随执行”,20 次间隔 5ms 的 `restart()` 实测产生约 2-3 次 attach。
- 保活帧只在会话流连接上发送,且不替代宿主心跳;链路真正断开时仍会走宿主重连流程。
- 保活补丁只覆盖安装之后新建的连接,且每个被覆盖的连接常驻一条检查定时器;关闭开关后恢复原始 `WebSocket`,已存在但不被覆盖的连接本来就没有保活。
- 停滞判定要求会话流容器里没有任何有效消息行(按宿主口径排除分组行、过程行、空行与隐藏子树),且加载提示文本与宿主文案完全一致(中文「载入历史…」与英文「Loading history…」);宿主更换文案或结构时提示不再出现,但不会误报,终端等其它区域的输入框不影响判定。
- 列表瘦身的白名单是当前列表行消费面的快照:宿主新增列表行字段时需要同步 `KEEP_PROJECTIONS`,不会自动降级为未裁剪;被裁字段仍可经会话详情接口取回,但任何直接读取列表投影的第三方插件会看到裁剪后的值。
- 列表缓存按整份列表共享,只服务 owner 与本地调用;非 owner Remote 主体不读写缓存,也不做投影裁剪(直接透传原方法),列表体积恢复到原生水平。TTL 内标题等元数据变更最多滞后一个 TTL;会话新增/删除会通过宿主事件即时失效,其余变更依赖 TTL。关闭开关后包装保留,每次调用透传原方法。
- 缓存未按 `request` 建键:当前宿主 `session/list` 的 request 无分页参数;宿主引入分页或新增列表顶层字段时,需要改为按 request 建键或缓存完整响应。
- 列表构建在 owner 调用间共享,复用首个请求的调用上下文;所有等待者都取消时中止构建,预热等待有上限。同一服务重复装载会跳过新实例,先装载实例卸载后需刷新页面/重载插件恢复瘦身。
- 列表瘦身包装的是宿主 `sessionController` 服务面;宿主将该方法移入其他服务或改变返回协议时,补丁表现为不再裁剪(形状不符原样透传),不会崩页面,但需要按 `兼容性测试.md` 的 L3 重新核对。
- 主动重建复用宿主 `connection` 服务:它中止当前 generation 并立即重试,订阅由宿主重新下发,不刷新页面、不丢输入;用尽重建次数后才显示提示条,刷新按钮只是最后手段。有注入能力但 `connection` 服务未就绪时等待,等待期不安装停滞自愈;无注入能力且 `connection` 缺席时才退化为只显示提示。
- 依赖官方内部结构(`RemoteStream`、`webTerminals.view/views/connect`、会话流协议帧格式与 `/api/remote.mux` 路径、`[data-chat-flow]` 容器与加载提示文本、`sessionController.list` 与列表投影形状、`ctx.invocation.peer.principal` 主体判定),宿主升级后需按 `兼容性测试.md` 的 L3 重新验证。
- `diag` 默认关闭;开启后每 `reportEvery` 次采样发一次 GET,payload 全部放在 query string;不重试、不补发,页面关闭时未发送的样本会丢失。内存采样始终运行,关闭上报不等于关闭采样。2 MB 轮转与宿主重启后继续追加按实现语义描述,尚未单独实测。

## dsh 版本兼容

- `hostMin`: `0.2.1-rc.2`(依赖的 client 内部形态与宿主 `sessionController.list` 面在该版本起可用)。
- 已验证版本:`0.2.1-rc.2`(旧两功能完整功能面)、`0.2.2-rc.1`(旧两功能完整功能面;新增功能见下)。
- 新增 `socketKeepAlive` / `stuckSession` 目前只在 `0.2.2-rc.1` 隔离工位验证;`jobStreamLimit` 已完成生产页面实测(见 `兼容性测试.md` 状态表);`dshReleases` 的既有条目不含这几个功能,升级宿主后须按 `兼容性测试.md` 重新核对。
- `listSlim` 从 `dsh-session-manager` 迁入,依赖宿主 `sessionController` 服务与 `ctx.invocation` 主体判定;迁移后完成宿主接线、配置归一化与 L1 单元验证,仓库 `node scripts/smoke-load.mjs` 20 包通过,0.2.2-rc.1 隔离 boot 页面/激活通过,隔离宿主进程内同构 invocation 多主体取证通过(#33/#34;真实 Liveshare server 未部署);旧包 0.10.0 共存实测确认 viewer 泄漏。`dshReleases` 未单独登记该功能。`dsh-session-manager` 必须同批发布 0.11.0,否则旧包装仍会绕过鉴权。
- 兼容性细节与逐版本证据见 [兼容性测试.md](兼容性测试.md)。

## 安装

```sh
dsh plugin add @mzzsfy/dsh-bug-perf
```

或在 profile 的 `cordis.patch.yml` 插入 `- id: bug-perf` 行并安装包。
