# @mzzsfy/dsh-common-tools

公共依赖库，提供插件独立消息通道与 toast。普通 npm 包，不是 DSH 插件。host 与 client 都通过当前插件的 `ctx` 建立通道，插件名自动来自 loader 的 `ctx.fiber.entry.options.name`，使用完整 npm 包名。共享模块的 require 不携带调用者身份，必须在 `apply(ctx)` 中初始化。

## 双接口

两端 API 相同，消息就是业务 payload：

```js
const bus = setupCommonTools(ctx)
const stop = bus.subscribe(message => handleMessage(message))
bus.publish({ type: 'refresh' })
```

host：

```js
import { setupCommonTools } from '@mzzsfy/dsh-common-tools/host'
export const inject = ['webServer']
export function apply(ctx) {
  const bus = setupCommonTools(ctx)
  bus.subscribe(message => handleCommand(message))
  bus.publish({ changed: true })
}
```

client：

```js
window.__ModuleLoader__.load({
  id: '@mzzsfy/example', // 与 host 的包名一致
  factory(require) {
    const { setupCommonTools, createSnapshotRefresh, toast } = require('@mzzsfy/dsh-common-tools/client')
    return {
      apply(ctx) {
        const bus = setupCommonTools(ctx)
        const controller = new AbortController()
        const snapshot = createSnapshotRefresh(async () => {
          const res = await fetch('/api/example/snapshot', { signal: controller.signal })
          const data = await res.json()
          if (!controller.signal.aborted) console.log(data)
        })
        bus.subscribe(snapshot.refresh, { onReset: snapshot.refresh })
        ctx.effect(() => () => { snapshot.dispose(); controller.abort() })
        ctx.effect(() => {
          const button = document.createElement('button')
          button.textContent = '刷新'
          button.onclick = () => {
            try { bus.publish({ type: 'refresh' }) }
            catch (error) { toast.show(error.message, { kind: 'error' }) }
          }
          document.body.appendChild(button)
          return () => button.remove()
        })
      },
    }
  },
})
```

示例中的快照路由与 host 命令处理由消费插件实现；示例按钮展示发送与卸载接线，实际插件可换成已注册面板。消费方仍需声明依赖与 external，见下文装载说明。

| 方法 | 行为 |
|---|---|
| `subscribe(listener)` | 接收对端本插件消息，`listener(payload)`，返回幂等退订函数 |
| `publish(payload = null)` | 向对端本插件发送 JSON 消息，上行不自动广播回来 |
| client `subscribe(listener, { onReset })` | 可选恢复回调，接收订阅确认后对账，首连/重连均触发 |
| host `onPresence(listener)` | 接收本插件的浏览器连接数；注册立即回调，变化时回调，返回退订函数 |

插件本身就是通道，没有 topic 和消息版本。不同插件不能通过本门面指定别人的空间；同插件多实例共享空间。业务需要区分消息时直接使用 payload 中的业务字段。回调同步抛错或异步拒绝均告警隔离。

## 生命周期

client 初始化取得插件实例的连接使用权；纯发送插件不需要制造接收订阅。组件提前退订仅停止接收，不影响发送。插件卸载自动清理自己的全部订阅和使用权，最后一个实例卸载才关闭页面共享 WS、取消重连。host 同样按实例清理，最后一个 host 使用方退出删除路由、连接和心跳。

presence 只统计有接收订阅的连接，纯发送实例不计在场。对已就绪空间新增订阅时，onReset 在 subscribe 返回前同步执行。尚未确认的订阅不接收业务消息，遗漏由随后的快照对账恢复。

## 连接与边界

页面全部插件共享 `WS /api/bus/ws`；HTTPS 自动使用 WSS，不占 HTTP/1.1 普通请求连接池。首连/重连完成接收确认后调用 onReset 拉业务快照，不做事件重放。总线逐条交付 payload，不合并业务消息。五个快照消费方在宿主合并失效广播、在客户端单飞刷新，持续变更下同一刷新器的起始间隔至少一秒；首次立即，窗口内变更在末尾补拉。cron 的偏好与看板共用 status 请求。

断开后指数退避加抖动重连，上限 30 秒，握手确认超时 10 秒。服务端每 30 秒 ping，未回复的连接终止。单帧及发送积压上限 1 MiB，按完整 JSON 协议消息 UTF-8 字节计算；非法 JSON payload 或超界发送同步拒绝，慢接收方积压超界断开。publish 交给本地 WS 即返回，不表示业务处理完成；断线不排队、不自动重发。

快照消费方可独立使用 host 导出的 `createChangeNotifier(() => bus.publish())` 与 client 导出的 `createSnapshotRefresh(loadSnapshot)`。两者返回 `{ refresh, dispose }`，与实例生命周期一起释放。前者仅合并失效通知；后者保证单飞及末尾补拉，失败不会自行形成重试循环，调用方仍负责请求超时和迟到响应检查。调度采用正常系统时钟下的一秒窗口，空闲时无定时轮询。

## 内部协议

| 方向 | 帧 |
|---|---|
| client → host | `{ "type": "subscribe", "plugins": ["@mzzsfy/dsh-tunnel"], "revision": 1 }` |
| host → client | `{ "type": "ready", "plugins": ["@mzzsfy/dsh-tunnel"], "revision": 1 }` |
| client → host | `{ "type": "publish", "plugin": "@mzzsfy/dsh-tunnel", "payload": {} }` |
| host → client | `{ "type": "message", "plugin": "@mzzsfy/dsh-tunnel", "payload": {} }` |

订阅帧替换接收空间清单，与发送资格无关。revision 仅协调接收确认，不是业务消息版本。非法帧或二进制上行关闭连接；明确跨源上行写入被拒绝，身份认证及可达性由宿主承担，不设插件认证层。

host 的 WS 实现多实体以进程级注册表共享传输，同版不重复安装，较新版本接管传输并保留监听；已有 WS 门面动态转发。缺少 registerUpgrade 时告警并停用总线，不注册资源。loader 上下文缺少包名时明确拒绝，不猜测身份。0.2.0 移除旧 SSE、topic、forPlugin 和 version 接口，无兼容路径。升级须统一更新消费方与依赖，完整重启宿主并刷新旧页面；0.1 与 0.2 同进程混装会发生注册表冲突，不支持跨该代际热接管。

## 装载与 Toast

client 由 session-manager 全仓唯一占位条目代挂，必须先于消费方物化。消费方声明 dependencies 与 external `@mzzsfy/dsh-common-tools/client`。toast 不要求建立 bus：

```js
const { toast } = require('@mzzsfy/dsh-common-tools/client')
toast.show('已归档', { kind: 'ok' })
```

## 测试

在本包目录执行：

```sh
npm install --omit=peer
node --test "test/*.test.mjs"
```

覆盖范围见[兼容性测试](./兼容性测试.md)。
