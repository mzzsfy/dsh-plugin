# dsh GUI 左下角"断开连接后秒连"研究报告

日期:2026-09-06
方法:Playwright 控制浏览器注入 WebSocket/事件探针实测 + dsh 本体源码分析(只读)

## 结论

左下角"断开连接"一闪而过随即恢复,**不是 WebSocket 真的断线**,而是浏览器
`offline`/`online` 事件抖动触发的客户端状态机行为。loopback 连接全程健康。

## 因果链(源码 + 实验双证)

```
Chrome 派发 offline 事件(网络栈瞬时翻转,与 dsh 无关)
  → dsh-client-connection ConnectionController.setNetworkAvailable(false)
      立即 emitState("disconnected") 并 abort 当前 generation
      注意:此刻物理 WebSocket 仍然健康
  → 左下角指示器显示「⚠ 连接异常」(橙色)
浏览器派发 online 事件
  → attempt=0,250-500ms 抖动退避
  → console: "[connection] connection lost, retry #1"
  → Gateway 换物理 WS:旧 socket close(4000, "reconnect requested", wasClean=true)
  → 新 socket 14ms 内 open,$events 流 ready
  → emitState("connected") → 指示器「✓ 连接成功」显示 2 秒后消失
```

全程亚秒级,用户感知 = "断开一下,秒连"。

## 实验证据(模拟 offline 1s → online)

时间线(来自探针页 console 与 WebSocket 日志):
- 14:00:03.725 `[PROBE] OFFLINE`
- 14:00:04.709 `[PROBE] ONLINE`
- 14:00:04.963 `[connection] connection lost, retry #1`(online 后 254ms,退避档位 1)
- 14:00:04.963 新 mux WebSocket construct
- 14:00:04.975 旧 socket close code=4000 reason='reconnect requested' wasClean=true
- 14:00:04.977 新 socket open(重连本身仅 14ms)

指示器四态截图(.ws-debug/):
- 8-offline-wide.png:「⚠ 连接异常」
- 9-connecting-wide.png:「⚠ 连接中…」
- 10-recovered-wide.png:「✓ 连接成功」
- 11-normal-wide.png:无指示器

注:指示器只在 wide 布局渲染(源码 `state: wide ? connectionIndicator : void 0`,
dsh-client-ui-settings-general/lib/client.js L248),窄窗口 rail 模式不显示。

## 关键源码位置(dsh 本体)

| 环节 | 位置 |
|---|---|
| offline → disconnected | dsh-client-connection/lib/client.js L88-98 setNetworkAvailable |
| 重连退避调度 | 同上 L99-157(backoff 500ms×2^n,10s 封顶,50%-100% 抖动) |
| 网络事件监听 | 同上 L4694-4711 watchBrowserNetwork(window online/offline) |
| 物理 WS 换连 | dsh-api-gateway/lib/client.js L313-329 reconnect() |
| 指示器渲染 | dsh-client-ui-settings-general/lib/client.js L199/L230-256 |
| 服务端心跳 | dsh-api-gateway/lib/index.js L251-268(2s ping,2 次未回才杀) |

## 为什么判定不是其他原因

- **服务端心跳误杀**:表现应为 close 1006 wasClean=false + 指示器走
  "连接中…"(generation 丢失路径不发 disconnected)。本次观察 50+ 分钟未出现。
- **服务端空闲回收**:不存在,dsh-host-webserver 无任何回收定时器。
- **HMR 重建**:条件性(需文件变更),观察期未发生;且会同时杀 sidebar 两个 WS。
- **NCSI 探测失败**:事件日志显示数周一次,非周期来源。

## 触发源(dsh 之外)

什么让 Chrome 周期性派发 offline/online(本机排查结果):
- 唯一活动网卡:以太网 Intel I219-V,**省电模式已开启**("允许计算机关闭此设备")
- 栈内还有:SecureLink Wstun 零信任适配器/过滤驱动、USB WLAN(Disconnected)
- 系统日志近 2 天无网卡链路事件 → 翻转发生在 NLA/驱动层,不留日志
- 常见源头:网卡省电下电/驱动微复位、VPN/零信任驱动重评估、NLA 重判定;
  这些都只影响"操作系统上报的连接状态",不影响 127.0.0.1 回环本身

## 如果想进一步定位或处理

确认(在 GUI 页 console 粘贴,下次闪断时看打印):
```js
addEventListener('offline', () => console.warn('[NET] OFFLINE', new Date()));
addEventListener('online', () => console.warn('[NET] ONLINE', new Date()));
```
若闪断时打印 OFFLINE/ONLINE → 坐实本结论。

缓解(用户侧):
- 设备管理器 → Intel I219-V → 电源管理 → 取消"允许计算机关闭此设备以节约电源"
- 排查 SecureLink/VPN 驱动的周期性重评估

治本(dsh 侧,可选建议):
- `setNetworkAvailable(false)` 不必立即 disconnected:对 loopback 页面可跳过网络看门狗
  (handle 已有 loopback 字段),或对 offline 事件加 3-5s 确认宽限期;
  连接健康应以 WS 心跳/pong 为准,而不是 navigator.onLine
