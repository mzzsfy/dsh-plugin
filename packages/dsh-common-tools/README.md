# @mzzsfy/dsh-common-tools

公共依赖库，提供插件独立消息通道与 toast。普通 npm 包，不是 DSH 插件。host 与 client 都通过当前插件的 `ctx` 建立通道，插件名自动来自 loader 的 `ctx.fiber.entry.options.name`，使用完整 npm 包名。共享模块的 require 不携带调用者身份，必须在 `apply(ctx)` 中初始化。

client 侧的 WebSocket 连接基址取宿主官方连接层 `ctx.get('connection').openWebSocket(path)`:桌面版窗口页面源是 `dsh-app://app`,自建 `new URL(path, location.href)` 会继承自定义协议,`new WebSocket` 构造直接抛错;连接层缺席(旧宿主)时才回落到页面 URL。连接构造失败不抛出:总线停用并 console 告警一次,消费方据此走各自兜底。

## 预览

![插件图标](https://raw.githubusercontent.com/mzzsfy/dsh-plugin/main/assets/icons/png/dsh-common-tools.png)

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

client 初始化取得插件实例的连接使用权；纯发送插件不需要制造接收订阅。组件提前退订仅停止接收，不影响发送。插件卸载自动清理自己的全部订阅和使用权，最后一个实例卸载才关闭页面共享 WS、取消重连。host 同样按实例清理，最后一个 host 使用方退出删除路由、连接和心跳。`setupCommonTools` 的 `ctx.effect` 挂载失败时回滚本次调用者 token；若传输由本次创建且无人共享，一并拆除路由与连接，异常继续上抛。

presence 只统计有接收订阅的连接，纯发送实例不计在场。对已就绪空间新增订阅时，onReset 在 subscribe 返回前同步执行。尚未确认的订阅不接收业务消息，遗漏由随后的快照对账恢复。

## 连接与边界

页面全部插件共享 `WS /api/bus/ws`；HTTPS 自动使用 WSS，不占 HTTP/1.1 普通请求连接池。首连/重连完成接收确认后调用 onReset 拉业务快照，不做事件重放。总线逐条交付 payload，不合并业务消息。六个快照消费方在宿主合并失效广播、在客户端单飞刷新，持续变更下同一刷新器的起始间隔至少一秒；首次立即，窗口内变更在末尾补拉。cron 的偏好与看板共用 status 请求。

断开后指数退避加抖动重连，上限 30 秒，握手确认超时 10 秒。服务端每 30 秒 ping，未回复的连接终止。单帧及发送积压上限 1 MiB，按完整 JSON 协议消息 UTF-8 字节计算；非法 JSON payload 或超界发送同步拒绝，慢接收方积压超界断开。publish 交给本地 WS 即返回，不表示业务处理完成；断线不排队、不自动重发。

快照消费方可独立使用 host 导出的 `createChangeNotifier(() => bus.publish())` 与 client 导出的 `createSnapshotRefresh(loadSnapshot)`。两者返回 `{ refresh, dispose }`，与实例生命周期一起释放。前者仅合并失效通知，`publish` 抛错就地告警隔离（定时器回调内不产生 uncaughtException）；后者保证单飞及末尾补拉，失败不会自行形成重试循环，调用方仍负责请求超时和迟到响应检查。调度采用正常系统时钟下的一秒窗口，空闲时无定时轮询。

## 内部协议

| 方向 | 帧 |
|---|---|
| client → host | `{ "type": "hello", "protocol": 1, "version": "<包版本>" }` |
| host → client | `{ "type": "hello", "protocol": 1, "protocols": [1], "version": "<包版本>" }` |
| client → host | `{ "type": "subscribe", "plugins": ["@mzzsfy/dsh-tunnel"], "revision": 1 }` |
| host → client | `{ "type": "ready", "plugins": ["@mzzsfy/dsh-tunnel"], "revision": 1 }` |
| client → host | `{ "type": "publish", "plugin": "@mzzsfy/dsh-tunnel", "payload": {} }` |
| host → client | `{ "type": "message", "plugin": "@mzzsfy/dsh-tunnel", "payload": {} }` |

订阅帧替换接收空间清单，与发送资格无关。revision 仅协调接收确认，不是业务消息版本。非法帧或二进制上行关闭连接；明确跨源上行写入被拒绝，Origin↔Host 同源比较大写不敏感（与全仓 route-gate 一致），身份认证及可达性由宿主承担，不设插件认证层。

host 的 WS 实现多实体以进程级注册表共享传输，同版不重复安装，较新版本接管传输并保留监听；已有 WS 门面动态转发。upgrade 不经宿主 `/api` prefix 闸门（responder 只按 exact pathname 分发），交付 socket 前自行回问一次 `connection.requestRejection`：`undefined` 放行；整数 400-599 按其码（401 用 Unauthorized），其余返回值（null/0/对象/Promise/NaN 等）一律收敛为 403 再写状态行并断 socket，原始返回值不拼进状态行；`connection` 服务缺失时放行，与插件 HTTP 路由同口径。缺少 registerUpgrade 时告警并停用总线，不注册资源；接管时新传输创建失败则回滚注册表为无传输并给本次调用返回 noop 门面（告警，不把消费方 apply 打成失败），后续同版本消费者仍可重建传输，旧门面在重建后恢复转发。loader 上下文缺少包名时明确拒绝，不猜测身份。0.2.0 移除旧 SSE、topic、forPlugin 和 version 接口，无兼容路径。升级须统一更新消费方与依赖，完整重启宿主并刷新旧页面；旧代际 SSE(包 0.1)与 WS 代际(注册版本:0.2-0.3 写死 1.0,0.4.0 起与包版本同锁)同进程混装会发生注册表冲突，不支持跨该代际热接管。

## 兼容窗口与版本协商

当前窗口 **0.5.x**：帧集合、导出形状与 `setupCommonTools` 门面语义在 0.5.x 内保持向后兼容，**只允许发 patch**。0.6.0 视为破坏性版本（0.x 语义里 minor 即破坏），必须与九个消费方的依赖范围抬升**同批发布**——npm 的 `^0.5.0` 只约束安装，装载行按包名取 profile 顶层那份，单独发 0.6.0 会被 hoist 给仍在 `^0.5.0` 的旧插件。窗口与红线见 [DEVELOPMENT/client-dependency.md](../../DEVELOPMENT/client-dependency.md)。

0.4.x → 0.5.0 的实际增量：client 新增导出 `Tooltip` 与 `tipPlacement`（见「悬浮提示」），host 侧 WS upgrade 补一次宿主闸门回问；既有帧集合、门面与 toast 语义未变。

下一个 patch 的实际增量（随发版落地）：toast 形态值域由两种扩到五种（新增 `minimal` / `accent` / `progress`），`kind` 增补 `warn`；均为加法，既有 appearance/kind 语义、帧集合与导出形状不变，消费方无需跟发。

版本协商：client 连接首帧上报 `{ type: 'hello', protocol: 1, version }`，host 回 `{ type: 'hello', protocol, protocols: [1], version }`。协议无交集时 client 打印一条告警并关闭连接、不再重连（页级总线停用）；旧 host（0.3.x 及以前）把未知帧当非法帧直接关连接，client 在 hello 宽限窗内被关即判定为老帧模式，降级为不报版本重连一次，连接从未 open 就断开不触发降级。帧协议版本集中定义在 `src/protocol.mjs`（host 直接 import）；client 是浏览器单文件模块不能 import 该文件，其字面量由 `test/protocol.test.mjs` 与共享常量互锁——单边抬版会让协商无交集、总线静默停用，故改帧集合必须两端同批递增 `PROTOCOL`；host 侧 `PKG_VERSION` 与包版本同锁（仓库测试守）。

## 装载与 Toast

client 模块由**每个消费插件自带的装载行**进入宿主：消费方在自己的 `cordis.patch.yml` 里加一行 `id: <本包前缀>-dsh-common-tools`、`name: '@mzzsfy/dsh-common-tools'`。宿主按包名把多行合并成**一份** client 模块（`entriesByName` + `compose`），bundle 只拼一次、模块只注册一次，多行在宿主侧是多个空 `apply()` 条目；本包不 host 别人的行，也不依赖别人 host 自己的行——装任一消费插件即可独立运行。消费方声明 dependencies（范围 `^0.5.0`）与 external `@mzzsfy/dsh-common-tools/client`，factory 内 require 后经命名空间使用；该包须能从 profile 根解析，生产 profile 为 pnpm `nodeLinker: hoisted`。装载规约见 [DEVELOPMENT/client-dependency.md](../../DEVELOPMENT/client-dependency.md)。toast 不要求建立 bus：

```js
const { toast } = require('@mzzsfy/dsh-common-tools/client')
toast.show('已归档', { kind: 'ok' })
toast.show('任务完成\n耗时 12 秒', { appearance: 'panel', holdMs: 6000 })
```

自 0.3.0 起 `appearance` 可选视觉形态，0.5.2 起扩到五种。全部形态随宿主亮暗主题更新、多行文本保留换行、未知值回落 `toast`，设置只作用于本条通知：

| 形态 | 视觉 |
|---|---|
| `toast`（默认） | 宿主原生 toast 色对，状态色只染左侧强调边 |
| `panel` | 面板底（bg-layer-1）+ 1px 描边 + 状态色强调边 |
| `minimal` | 无阴影无描边的扁平细条：12px/18px、padding 6/10、radius-sm，只留 2px 状态竖线，不显示图标 |
| `accent` | 状态色 14% 掺入面板底的浅底卡片，整圈 1px 状态色描边 + 24px 状态色图标徽章，无左侧竖线 |
| `progress` | 面板外观 + 底部 3px 状态色进度条按 `holdMs` 消退 |
| 图标 | `panel` / `accent` / `progress` 在正文左侧显示 16px 状态图标（info 圆点提示、ok 对勾、warn 感叹号、error 叉），`toast` / `minimal` 不显示；`accent` 的图标外套 24px 徽章 |

`progress` 的进度条与自动消失同源：非 `sticky` 条目把展示期经内联 `--dct-hold-ms` 下发，并额外带 `dsh-toast--countdown` 修饰类驱动消退动画；`sticky` 条目没有展示期，因此不带该修饰类，进度条停在满格。`prefers-reduced-motion` 下动画归零、进度条同样停在满格。状态色只经强调边、`accent` 浅底/描边、图标与进度条表达，不覆盖文案颜色，避免状态底色与文字对比失效。

`kind` 支持 info/ok/warn/error（默认为 info，0.5.2 起增补 `warn`），`sticky: true` 常驻并显示“知道了”，`onClick` 点击直达，`holdMs` 指定自动消失时间（默认 4 秒）。

## 悬浮提示

client 侧通用悬浮提示（0.5.0 起），消费方只给锚点与内容：

```js
const { Tooltip } = require('@mzzsfy/dsh-common-tools/client')

h(Tooltip, { anchor }, content)
```

- `anchor` 两种形态：指针 `{ kind: 'point', x, y }`（悬停时给，组件在 `mousemove` 上跟随）与元素矩形 `{ left, top, width, height }`（快照，页面滚动后自动收起）。
- `panelSelector` 可选：给定时以该面板矩形与视口的交集为夹取边界，提示不飘出弹窗也不越出视口；缺省用视口。
- 定位：上下越界换侧，两侧都放不下取空间大的一侧再夹取进边界；元素锚点画箭头，指针锚点不画。定位度量按会话缓存（面板查询、边界矩形、提示尺寸），指针移动只读缓存不做全文档查询与强制布局；面板/提示尺寸变化与窗口缩放才重测。`ResizeObserver` 每次渲染重连并观察当前提示与面板节点，节点替换或 active 切换后仍有效；缺失时退化为窗口 resize 与内容变化重测。
- 渲染：portal 到 `body`，样式类 `dct-tip*` 随 toast 样式表注入（首次使用前经 layout effect 注入，不依赖是否发过 toast）；宿主模块表缺 react-dom 主入口时降级就地渲染，提示仍可见。
- `tipPlacement` 一并导出（纯函数：`(anchor, tipSize, bounds, options)` → `{ left, top, side, arrowX }`），供消费方在不挂组件时复用同一套定位规则。

## 测试

在本包目录执行：

```sh
npm install --omit=peer
node --test "test/*.test.mjs"
```

覆盖范围见[兼容性测试](./兼容性测试.md)。
