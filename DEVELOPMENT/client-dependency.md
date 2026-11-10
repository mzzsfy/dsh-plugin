# 公共 client 依赖包规约(common-tools)

跨插件共享的 client 能力(浮出通知、推送总线订阅等)以**普通 npm 依赖包**形态发布
(`@mzzsfy/dsh-common-tools`),不是 dsh 插件:无 `dsh.bundle.patch`、不进 profile
依赖清单与 bundles,不单独成插件卡。它在插件管理页的唯一痕迹是所属插件详情页里
"包含的组件"中的一行(只读部件行,渲染但不可开关),属于"插件依赖"而非插件。

## 装载:每个消费插件自带一行

- 消费插件的 `cordis.patch.yml` 各带一行占位条目:

  ```yaml
  - insert:
      - id: <包短名>-dsh-common-tools   # 如 stock-assistant-dsh-common-tools
        name: '@mzzsfy/dsh-common-tools'
  ```

  条目 id 带本包前缀防树内冲突;`name` 才是模块表的包解析键。本包不 host 别人的
  行,也不依赖别人 host 自己的行——**装任一消费插件即可独立运行**。
- 宿主按包名把多条行合并成**一份** client 模块(`dsh-client-modules` 的
  `entriesByName` + `compose`),bundle 只拼一次、模块只注册一次;多行在宿主侧是
  多个空 `apply()` 条目,无副作用。
- 消费插件:`dependencies` 声明该包并在 `dsh.client.external` 声明
  `'@mzzsfy/dsh-common-tools/client'`,factory 内 require 后经命名空间使用。
- 该包必须能从 profile 根解析:生产 profile 是 pnpm `nodeLinker: hoisted`,传递依赖
  落顶层;isolated 布局未验证,换布局前先跑一次隔离 boot 确认装载行能解析。

## 兼容窗口:同一个 minor,只准 patch

- 当前窗口 **0.4.x**:client 与 host 的帧集合、导出形状、`setupCommonTools` 门面
  语义在 0.4.x 内保持向后兼容,**只允许发 patch**。
- 0.5.0 视为破坏性版本(0.x 语义里 minor 即破坏):必须与十个消费方的依赖范围
  抬升**同批发布**,否则 hoist 出的 0.5.0 会被装载行解析给仍在 `^0.4.0` 的旧插件。
- 版本范围管不住装载行:npm 的 `^0.4.0` 只约束安装,行解析按包名取 profile 顶层
  那份。所以"0.5.0 同批发"是硬规则,不是建议。

## 版本协商(hello 首帧)

- client 连接首帧上报 `{ type: 'hello', protocol: 1, version }`;host 回
  `{ type: 'hello', protocol, protocols: [1], version }`。
- 协议无交集:client 打印一条告警并关闭连接,不再重连(页级总线停用)。
- 旧 host(0.3.x 及以前)把未知帧当非法帧并以 1008 关连接:client 在 hello 宽限窗内
  收到 1008 即判定为老帧模式,本页保持不报版本;其余关闭(超时/抖动/重启)回到未探测,
  下次连接重试协商。连接从未 open 就断开不触发降级。
- host 侧 `PKG_VERSION` 与包版本同锁(仓库测试守),注册表按它决定哪份 host
  半区持有传输。0.3.x 的 host 把注册版本写死为 1.0.0,与 0.4.x 混装时数值上更高、
  可能持有传输;client 会按老帧模式工作,能力不丢,全量升级后恢复协商。

## host 半区(setupCommonTools)

- host 能力不占条目:消费插件在自己 `apply` 里执行 `setupCommonTools(ctx)`,返回
  绑定当前插件空间的 `subscribe / publish` 门面;host 额外提供 `onPresence`。
- 进程级注册表 + semver 版本接管:多个消费插件各自安装的 host 副本按版本比较,
  高版本持有 WS 传输并继承状态,旧副本继续可用;同版幂等。
- 卸载合规:调用者按实例独立记账,路由由进程级总线持有;非最后一个消费方卸载
  只清理该实例订阅,最后一个卸载才收尾——总线存活期 = 至少一个消费方在场。
- client 实例持有页面共享的一条 WebSocket。组件退订只停止接收,插件卸载清理自己
  的所有订阅;最后一个实例退出才关闭连接。host presence 仅统计有接收订阅的连接。
  不得在 factory 顶层持有常驻订阅;通知共享工作须记录活动实例,当前实例退出后由
  存活实例接管,最后实例退出才停止共享工作,跨 factory HMR 清理旧代。

## 红线

- 不得为共享能力另造插件包(会以独立插件卡出现在插件管理页)
- 不得让非插件包以三件态(name/inject)声明插件身份进装载树
- 消费方不得绕过 `setupCommonTools` 门面直触总线内部
- 不得在 0.4.x 内改帧集合、导出形状或调用语义;要改就发 0.5.0 并同批抬十个消费方
- react / react-dom/client 由宿主平台种子表提供,能力实现经模块表 require 使用
