# dsh-bug-perf

宿主缺陷兜底与性能补丁集合。补丁全部在浏览器半区执行,宿主半区只做配置分发;每个功能独立开关、独立失败,结构不匹配时只记录原因,不影响页面与其它补丁。

定位:官方修复落地前的运行期兜底,不是宿主行为的替代实现。升级 dsh 后应复核宿主版本是否已修复,再决定是否保留。

## 功能

| 功能 | 配置节 | 兜底对象 | 行为 |
|------|--------|----------|------|
| session/follow 重建合并 | `restartCoalesce` | discussion #11272:每次 assistant rebaseline 都全量重建 `session/follow` | 包装 `RemoteStream.prototype.restart`,同一 stream 在窗口内的多次重启只保留一次尾随执行;`restart()` 无参数,最新一次可代表期间全部重建请求 |
| 终端输出看门狗 | `terminalWatchdog` | discussion #11271:并发 `terminal/attach` 流释放后 UI 输出冻结 | 监控 `webTerminals` 视图;本端曾持有写权、输出停滞超过阈值且仍持有 attach 流时调用 `view.connect()` 重连,冷却期内不重复 |

两个缺陷的根因仍在宿主内部(`cancellableStream` 丢弃同 tick 的 `next()` 值、terminal-controller 队列交错、assistant rebaseline 状态机),本插件只消除用户可观察到的后果,不改变根因。

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
```

| 字段 | 默认 | 说明 |
|------|------|------|
| `restartCoalesce.enabled` | `true` | 关闭后不改写 `RemoteStream.restart` |
| `restartCoalesce.windowMs` | `100` | 合并窗口(毫秒);0 表示只合并同一 tick 内的重启;上限 2000 |
| `terminalWatchdog.enabled` | `true` | 关闭后不包装终端视图 |
| `terminalWatchdog.checkMs` | `2000` | 检查周期(毫秒);下限 250,上限 60000 |
| `terminalWatchdog.stallMs` | `8000` | 输出静默多久判定停滞;下限 1000,上限 600000 |
| `terminalWatchdog.cooldownMs` | `60000` | 同一视图两次自愈的最小间隔;下限 1000,上限 3600000 |

配置在页面加载时读取一次;修改后刷新页面生效。宿主没有配置路由(旧版本/非 web profile)时客户端退回内联默认值。

## 跨版本失效策略

- 缺 `@deepseek-ai/dsh-api-gateway/client` 或 `RemoteStream.restart`:跳过重启合并,记录 `reason`。
- 缺 `webTerminals` 服务:跳过看门狗,记录 `reason`。
- 宿主没有 `webServer` 服务:host 半区不注册路由,客户端用默认配置。
- 路由注册失败/路由表冻结:记录日志,不影响宿主。
- 所有补丁安装点包在 try/catch 内;任何一项失败只进入 `window.__dshBugPerf.features` 报告,不阻断页面渲染。

诊断:浏览器控制台执行 `window.__dshBugPerf` 可看配置与各功能安装结果;宿主日志出现 `[dsh-bug-perf]` 前缀。

## 已知限制

- 看门狗只恢复客户端消费链的卡死,不修复宿主侧丢帧;自愈会断开旧 attach 流,冻结期间的输入本来未生效。
- 只读旁观视图(本端从未持有写权)不触发自愈,避免多客户端场景抢控制权。
- 合并窗口内的重建被折叠为一次,UI 对新 revision 的追赶最多延迟一个窗口。
- 依赖官方内部结构(`RemoteStream`、`webTerminals.view/views/connect`),宿主升级后需按 `兼容性测试.md` 的 L3 重新验证。

## 安装

```sh
dsh plugin add @mzzsfy/dsh-bug-perf
```

或在 profile 的 `cordis.patch.yml` 插入 `- id: bug-perf` 行并安装包。
