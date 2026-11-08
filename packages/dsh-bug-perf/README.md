# dsh-bug-perf

宿主缺陷兜底与性能补丁集合。补丁全部在浏览器半区执行,宿主半区只做配置分发;每个功能独立开关、独立失败,结构不匹配时只记录原因,不影响页面与其它补丁。

定位:官方修复落地前的运行期兜底,不是宿主行为的替代实现。升级 dsh 后应复核宿主版本是否已修复,再决定是否保留。

## 功能

| 功能 | 配置节 | 兜底对象 | 行为 |
|------|--------|----------|------|
| session/follow 重建合并 | `restartCoalesce` | discussion #11272:每次 assistant rebaseline 都全量重建 `session/follow` | 包装 `RemoteStream.prototype.restart`,同一 stream 在窗口内的多次重启只保留一次尾随执行;`restart()` 无参数,最新一次可代表期间全部重建请求 |
| 终端输出看门狗 | `terminalWatchdog` | discussion #11271:并发 `terminal/attach` 流释放后 UI 输出冻结 | 监控 `webTerminals` 视图;本端曾持有写权、输出停滞超过阈值且仍持有 attach 流时调用 `view.connect()` 重连,冷却期内不重复 |
| 会话流保活 | `socketKeepAlive` | 公网/反代链路下,宿主短周期心跳把仍可用的连接判为失联 | 在 `/api/remote.mux` 连接空闲(客户端自己没有上行帧)时发送一条随机 streamId 的 `item` 帧;宿主对任意入帧刷新存活标记,未知 streamId 的 item 被忽略;仅覆盖补丁安装之后新建的连接,发过保活帧的连接被协议级关闭码关闭时累计,累计两次即熔断、健康存活后清零 |
| 任务状态流上限 | `jobStreamLimit` | 侧边栏每个会话行各订阅一条常驻 `job/list` 流(实测 361 条,其中 2711/3466 个是子 agent 会话),job 变化时宿主逐条推全量帧,主线程出现数百毫秒长任务,页面越用越卡 | 默认窗口只给主会话前 `base` 条;子 agent 会话不占窗口,只在被点击时订阅;点击任意会话可加入,总数到 `max` 后淘汰最先加入的一条 |
| 会话停滞自愈 | `stuckSession` | 连接重建期间会话停在 loading,或主线程被长时间占满导致页面假死 | 会话流无有效消息行出现加载提示,或事件循环延迟超过 1 秒时判定停滞;超过阈值调用宿主 `connection.reconnect()` 主动重建连接(中止当前 generation 并立即重试,不刷新页面、不丢草稿);连续多次无效才显示提示条与刷新入口 |

四个缺陷的根因仍在宿主内部(`cancellableStream` 丢弃同 tick 的 `next()` 值、terminal-controller 队列交错、assistant rebaseline 状态机、会话流心跳判死与重建成本叠加),本插件只消除用户可观察到的后果,不改变根因。

## 配置

每个功能一个独立开关;阈值同时可在设置页调整(Config 按 schemastery 声明)。

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

配置在页面加载时读取一次;修改后刷新页面生效。宿主没有配置路由(旧版本/非 web profile)时客户端退回内联默认值。

## 跨版本失效策略

- 缺 `@deepseek-ai/dsh-api-gateway/client` 或 `RemoteStream.restart`:跳过重启合并,记录 `reason`。
- 缺 `webTerminals` 服务:跳过看门狗,记录 `reason`。
- 缺 `WebSocket` 构造器:跳过保活,记录 `reason`。补丁只包装安装之后创建的连接;页面在补丁安装前已建立的会话流连接不受保活保护,`installed: true` 只表示包装已装上,不代表该连接被覆盖。
- 缺 `connection` 服务:停滞时只显示提示条,不主动重建连接。
- 默认窗口按 `watchRows` 调用顺序(列表渲染顺序)放行,不保证正好是可见行;被拒或已被淘汰的行表现为不显示任务状态,不影响会话本身。
- 主/子会话的判定依赖会话列表快照的 `origin`/`parentSessionId`;快照未就绪时一律按主会话处理。
- 宿主把保活帧当协议错误(以 1002/1003/1007/1008/1009/1011 关闭):在发过保活帧的连接上累计两次后补丁自行禁用、恢复原始构造器,并把原因写回 `window.__dshBugPerf.features.socketKeepAlive`;连接健康存活 10 个间隔后累计清零。普通断线(1000/1001/1006)与未发过保活帧的连接不计入。
- 宿主没有 `webServer` 服务:host 半区不注册路由,客户端用默认配置。
- 路由注册失败/路由表冻结:记录日志,不影响宿主。
- 安装点包在 try/catch 内,安装失败只进入 `window.__dshBugPerf.features`;运行期错误走浏览器 console 的 `[dsh-bug-perf]` 日志,不阻断页面渲染。

诊断:浏览器控制台执行 `window.__dshBugPerf` 可看配置与各功能安装结果,运行期日志与熔断原因在浏览器 console 的 `[dsh-bug-perf]` 前缀下;宿主侧只在路由注册失败时输出同前缀日志。

`window.__dshBugPerf` 额外提供:

- `diag.samples`:每 5 秒一条 `{t, heapMB, nodes, sockets, liveSockets, activeStreams, messages, sent}`;
- `diag.longTasks` / `diag.blockedMs`:主线程长任务与事件循环阻塞;
- `diag.totals`:累计打开的连接、关闭的连接、收发帧数;
- `actions.reconnect()`:手动触发一次连接重建。

同一份摘要每分钟经 `GET /api/dsh-bug-perf/diag?d=<json>` 写入宿主临时目录的 `dsh-bug-perf-diag.jsonl`(单文件上限 2 MB,超出轮转一次),用于定位“页面开很久后逐渐变卡”。

## 已知限制

- 看门狗只恢复客户端消费链的卡死,不修复宿主侧丢帧;自愈会断开旧 attach 流,冻结期间的输入本来未生效。
- 只读旁观视图(本端从未持有写权)不触发自愈,避免多客户端场景抢控制权。
- 合并窗口内的重复重建被折叠为“首次立即执行 + 窗口内一次尾随执行”,20 次间隔 5ms 的 `restart()` 实测产生约 2-3 次 attach。
- 保活帧只在会话流连接上发送,且不替代宿主心跳;链路真正断开时仍会走宿主重连流程。
- 保活补丁只覆盖安装之后新建的连接,且每个被覆盖的连接常驻一条检查定时器;关闭开关后恢复原始 `WebSocket`,已存在但不被覆盖的连接本来就没有保活。
- 停滞判定要求会话流容器里没有任何有效消息行(按宿主口径排除分组行、过程行、空行与隐藏子树),且加载提示文本与宿主文案完全一致(中文「载入历史…」与英文「Loading history…」);宿主更换文案或结构时提示不再出现,但不会误报,终端等其它区域的输入框不影响判定。
- 主动重建复用宿主 `connection` 服务:它中止当前 generation 并立即重试,订阅由宿主重新下发,不刷新页面、不丢输入;用尽重建次数后才显示提示条,刷新按钮只是最后手段。若宿主没有 `connection` 服务,退化为只显示提示。
- 依赖官方内部结构(`RemoteStream`、`webTerminals.view/views/connect`、会话流协议帧格式与 `/api/remote.mux` 路径、`[data-chat-flow]` 容器与加载提示文本),宿主升级后需按 `兼容性测试.md` 的 L3 重新验证。

## dsh 版本兼容

- `hostMin`: `0.2.1-rc.2`(依赖的 client 内部形态在该版本起可用)。
- 已验证版本:`0.2.1-rc.2`(旧两功能完整功能面)、`0.2.2-rc.1`(旧两功能完整功能面;新增两功能见下)。
- 新增 `socketKeepAlive` / `stuckSession` 目前只在 `0.2.2-rc.1` 隔离工位验证;`dshReleases` 的既有条目不含这两个功能,升级宿主后须按 `兼容性测试.md` 重新核对。
- 兼容性细节与逐版本证据见 [兼容性测试.md](兼容性测试.md)。

## 安装

```sh
dsh plugin add @mzzsfy/dsh-bug-perf
```

或在 profile 的 `cordis.patch.yml` 插入 `- id: bug-perf` 行并安装包。
