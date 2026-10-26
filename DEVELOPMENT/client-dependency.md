# 公共 client 依赖包规约(common-tools)

跨插件共享的 client 能力(浮出通知、推送总线订阅等)以**普通 npm 依赖包**形态发布
(`@mzzsfy/dsh-common-tools`),不是 dsh 插件:无 `dsh.bundle.patch`、不进 profile
依赖行与 bundles、插件管理列表不可见。两个半区各有激活通道:

## client 半区(toast / setupCommonTools)

- 实现以 `__ModuleLoader__.load({ id: '@mzzsfy/dsh-common-tools', factory })` 自注册,
  factory 返回值含空 `apply()` + 能力命名空间(缺 apply 即 invalid plugin 拖垮整树)
- **装载来源 = session-manager 的 cordis.patch.yml 全仓唯一代挂占位条目**(dsh-toast 原模式),其他消费方不得重复插入:
  条目 id 带代挂插件前缀防树内冲突,`name` 才是模块表的包解析键;包自身不带 patch
- 消费插件:`dependencies` 声明该包(传递依赖 hoisted 落 profile 顶层),
  `dsh.client.external` 声明 `'@mzzsfy/dsh-common-tools/client'`,factory 内 require
  后经命名空间使用;toast 通道可选消费(try/catch,模块表缺失即置空),总线订阅为
  硬消费(缺失即 factory 抛错由装载层判定)
- **物化顺序约束**:占位条目随代挂插件 bundle 进 client 拼接序,代挂插件
  (session-manager)必须排在所有消费方之前(bundles @mzzsfy 区段最前),否则硬消费
  require 先于模块物化而拖垮整 client bundle

## host 半区(setupCommonTools)

- host 能力不占条目:消费插件在自己 `apply` 里执行
  `setupCommonTools(ctx)`,返回绑定当前插件空间的 `subscribe / publish` 门面；host 额外提供 `onPresence`
- 进程级注册表 + semver 版本接管:WS 同代际多版本实体共存时新者接管,旧实现自治拆卸并交出
  状态;同版幂等,降级不接管。0.1 SSE 与 1.0 WS 不支持跨代际热接管；升级须统一更新消费方与依赖、完整重启宿主并刷新旧页面
- 卸载合规:调用者按实例独立记账,路由由进程级总线持有;非最后一个消费方卸载只清理该实例订阅,最后一个卸载才收尾——总线存活期 = 至少一个消费方在场
- 两端均在消费插件的 `apply(ctx)` 中调用 `setupCommonTools(ctx)`，以 `ctx.fiber.entry.options.name` 完整 npm 包名绑定空间。`subscribe(listener)` 接收对端 payload，`publish(payload)` 向对端发送；插件就是通道，没有 topic、消息版本或跨插件通配。client 可用 `subscribe(listener, { onReset })` 在接收订阅确认后拉快照。
- client 实例持有页面共享的一条 WebSocket，发送无需接收订阅。组件退订只停止接收，插件卸载清理自己的所有订阅与连接使用权，最后一个实例退出才关闭连接。host presence 仅统计有接收订阅的连接。不得在 factory 顶层持有常驻订阅，不得由共享可变 bus 将不同实例串到一起。组件应捕获所属 ctx 的 bus；通知共享工作须记录活动实例，当前实例退出后由存活实例接管，最后实例退出才停止共享工作，跨 factory HMR 清理旧代。
- 旧 SSE、forPlugin 与 topic/version 接口已移除，不保留兼容层。协议与断线恢复见[包 README](../packages/dsh-common-tools/README.md)

## 红线

- 不得为共享能力另造插件包(会出现在插件管理)
- 不得让非插件包以三件态(name/inject)声明插件身份进装载树
- 消费方不得绕过 `setupCommonTools` 门面直触总线内部
- react / react-dom/client 由宿主平台种子表提供,能力实现经模块表 require 使用
