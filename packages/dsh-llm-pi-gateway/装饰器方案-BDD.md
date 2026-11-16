# Gateway Provider 装饰器 BDD

状态：已实施。三协议实际 adapter 请求验证覆盖 DSH `0.2.1-rc.2` / pi-ai `1.3.0`（0.8.1 历史留档）与 DSH `0.2.2-rc.3` / pi-ai `1.5.2`（本轮，Responses 会话头名为 `session-id`）；有头 GUI 隔离回归在 0.2.1-rc.2 通过并记为 0.8.1 历史记录，更早的 GUI 隔离测试覆盖 DSH `0.2.0-rc.2`。验证均使用 echo fixture，不代表真实上游路由策略或真实 provider 的完整契约。

## 目标

- 官方 `llm-pi-ai` 行保持启用，自行负责 provider 注册、配置节和模型发现。
- gateway 不注册 adapter、directory 或 discovery，不禁用官方插件。
- gateway 通过 `llm.directory` 中 `settingsNs === 'llm-pi-ai'` 的 entry 识别官方 route，以 entry.provider 字段检索 `llm.adapters` 并核对 registration `provider.id`；该字段与 directory Map key 一致是 DSH `0.2.0-rc.2` 的宿主契约。只有原型提供 `streamWithSnapshot` 的官方 adapter 被装饰，目标为 PiAiAdapter。
- 原型 wrapper 为每次调用复制 snapshot；Models 可装饰时才构造 facade，facade 绑定官方 route 授权的 adapter 实例并在每次 `streamSimple` 重新解析其活跃 owner，而非仅绑定原型。同原型的非授权实例及不同原型共享 Models 的 adapter 均不得注入。
- fiber dispose 后请求旁路；同进程重新 apply 后，已有原型和 Models 实例由新 owner 承载。

## 场景

### 官方 provider 保持自服务

- **Given** 官方 `llm-pi-ai` 与 gateway 均启用
- **When** 宿主注册官方 adapter 并接受 provider 请求
- **Then** 官方 provider、设置节和模型发现继续由官方插件提供
- **And** gateway 不注册竞争接口、不更改官方行启用状态

### Anthropic 请求注入派生标记

- **Given** 官方 adapter 已授权、owner 活跃、开关开启，原型提供 `streamWithSnapshot`，请求为 Anthropic 且包含非空字符串 sessionId
- **When** 请求到达 `snapshot.models.streamSimple`
- **Then** 传给原始方法的 options 含派生 `metadata.user_id`
- **And** 原始 options 对象不被修改

### Chat 请求补会话头

- **Given** 官方 adapter 已授权、owner 活跃、开关开启，实际 model.api 为 `openai-completions`，options.sessionId 为非空字符串，且 cacheRetention 不是 `none`
- **When** 请求经过 `streamSimple`
- **Then** 仅补缺失的 `session_id`、`x-client-request-id` 头，值均为原始 sessionId
- **And** 大小写无关地尊重 options.headers 与 model.headers 的显式键，包括 `null` 抑制值，不制造同名大小写变体
- **And** 冻结的 options、headers、model 不被修改，不新增 metadata 或 prompt_cache_key，不改变 cacheRetention
- **And** 同会话多轮值相同，新会话值不同

### Chat 缓存关闭

- **Given** Chat options.cacheRetention 为 `none`
- **When** 请求经过装饰器
- **Then** 不添加自动会话头，options 原对象透传，显式头保留

### Responses 与其他协议透传

- **Given** adapter 已装饰
- **When** Responses 或其他非 Chat、非 Anthropic 协议请求经过 streamSimple
- **Then** gateway 原样透传 options，不重复注入或抑制 pi-ai 的原生会话键
- **And** 已验证的 pi-ai `1.5.2` Responses 默认发送 `session-id`、`x-client-request-id` 与顶层 `prompt_cache_key`，`cacheRetention: 'none'` 时不自动发送这些键
- **And** Chat 侧对应头名为 `session_id`，与 Responses 的 `session-id` 不同名；0.8.1 留档的 pi-ai `1.3.0` 为 `session_id`（跨代际漂移），探针按 `session_id ?? headers['session-id']` 取值分别断言

### 关闭总开关

- **Given** sessionMarker.enabled 为 false
- **When** Chat 或 Anthropic 请求经过已装饰的 streamSimple
- **Then** gateway 原样透传 options
- **And** 重开后恢复自动注入，Responses 原生行为不受此开关控制

### 注册先后变化

- **Given** 官方 namespace 在 directory 中声明一条或多条 route，同时 adapters 中存在这些 route 的 registration
- **When** gateway 同步 sweep 或收到 `llm/adapters-updated`
- **Then** 为命中的官方 route adapter 实例累加 owner；非官方实例即使复用同一原型也不获授权，多 route 共用实例不重复添加同一 owner
- **And** 移除 route 不会立即撤销已授权实例 owner，owner 持续至所属 gateway dispose

### 不同原型共享 Models

- **Given** 两个不同 adapter 原型共享同一个底层 Models 实例，且各自有不同 owner
- **When** 两个 adapter 以任意顺序或交错发起 Anthropic 请求
- **Then** 每次请求只应用发起调用的、按 adapter 实例授权的 owner
- **And** 底层 `streamSimple` 以原 Models 对象作为 `this` 调用

### adapter 原型方法不可装饰

- **Given** 注册 adapter 原型没有函数形式的 `streamWithSnapshot`，或原型不接受该方法 shadow
- **When** gateway 执行 sweep
- **Then** 该 adapter 不被装饰，原有宿主请求不被 gateway 阻断

### Models facade 不可用

- **Given** snapshot 的 models 不是对象，或 `streamSimple` 不是函数
- **When** 已装饰的 adapter 调用 `streamWithSnapshot`
- **Then** 不创建注入 facade，保留原 models 引用；snapshot 仍按调用复制，其余字段保持不变

### 无活跃 owner 直通

- **Given** 原型已装饰，但发起调用的 adapter 实例未被授权，或其 owner 已失活
- **When** 该实例调用 `streamWithSnapshot`
- **Then** 直接以原 options 与原 snapshot 引用调用原始方法
- **And** 不复制 snapshot、不构造 Models facade

### 已保存的 Models facade

- **Given** 某次已装饰调用返回的 Models facade 被调用方留存
- **When** owner dispose 或 gateway 重装后再次调用该 facade 的 `streamSimple`
- **Then** 每次调用都按 facade 绑定的 adapter 实例重新解析活跃 owner，无活跃 owner 时原样透传 options
- **And** reapply 后同一旧 facade 由新 owner 恢复注入，不复用创建时捕获的注入函数

### 畸形 registration

- **Given** `llm.adapters` 中官方 route 的条目不完整（缺 adapter、null 条目、adapter 为 null 或非对象）
- **When** gateway 执行 sweep 或 `ownerCount` 查询
- **Then** 跳过畸形条目，不抛错、不阻断其余官方 adapter 的授权
- **And** `patchAdapterPrototype` 对 null/非对象 adapter 直接返回 false

### 原型方法被外部替换

- **Given** 原型已被装饰，装饰缓存记录的 wrapper 仍是安装时的函数
- **When** 宿主或其他装饰器替换了原型的 `streamWithSnapshot`，gateway 再次 sweep 或 patch
- **Then** 按当前方法重新包装，注入继续生效，外部包装仍在外层链上
- **And** 同一 adapter 的 owner 不因重新包装重复登记
- **And** 当前方法不是函数时返回 false 且不抛错，宿主请求不受影响

### 前缀配置热更新

- **Given** 同一 gateway owner 已为会话派生标记，随后配置 prefix 更新
- **When** 此前已见过的 sessionId 与全新 sessionId 分别发起 Anthropic 请求
- **Then** 二者均使用当前 prefix 派生标记（缓存键含 prefix，已有会话不沿用旧键的标记）
- **And** 同一 prefix 下同会话多轮标记稳定，Chat 会话头不受 prefix 影响

### sessionId 缺失

- **Given** 官方 adapter 已授权、owner 活跃且开关开启，Anthropic 或满足其他注入条件的 Chat options 没有非空字符串 sessionId
- **When** 请求经过已装饰的 streamSimple
- **Then** 不新增会话键，原 options 透传，并按实际 model.id 告警一次

### 缓存上限

- **Given** 同一 gateway owner 已为超过 `MARKER_CACHE_LIMIT` 个 (prefix, 会话) 键派生标记
- **When** 最久未用的键再次发起 Anthropic 请求
- **Then** 进程内 marker 条目数不超上限（`markerCacheSize` 断言），超限按最近使用淘汰
- **And** 被淘汰键按当前 prefix 重算，结果与淘汰前同 prefix 下一致
- **And** 缺 sessionId 的告警去重同样有界（`WARNED_CACHE_LIMIT`）：热点模型在缓存内不重复告警，被淘汰的模型再出现才重新告警


### dispose 后旁路

- **Given** gateway owner active 且原型和 Models 已装饰
- **When** gateway fiber dispose
- **Then** 后续请求不注入 Anthropic 标记或 Chat 头，已装饰 Models 同样旁路，官方 adapter 继续服务

### 同进程重新启用

- **Given** 旧 gateway owner 已 dispose，稳定原型与 Models wrapper 仍存在
- **When** gateway 重新 apply 并 sweep 相同 adapter
- **Then** wrapper 使用新 owner 的活性和注入函数
- **And** 已装饰的 Models 实例以新配置恢复注入

## 实现约束

- 原型 wrapper 每次调用按 `this` 兑换活跃 owner：有 owner 时复制 snapshot 并构造绑定来源 adapter 与 patch 的 Models facade，facade 的 `streamSimple` 每次调用重新解析活跃 owner、无活跃 owner 时原样透传 options，底层函数以原 Models 为 this 调用；无 owner 时直通原 options 与原 snapshot。
- 稳定原型 wrapper 通过 WeakMap 保存 owner 与自身身份；同一实例重复 sweep 不重复添加 owner，省略 isActive 的重复 patch 也按同一引用去重（缺省活性判定为模块级常量；显式传入不同函数仍分别登记，保留多代 owner 并存语义）；旧 owner dispose 后旁路，新 apply 时同一注册实例由新 owner 恢复注入；缓存命中时核对原型方法仍是记录的 wrapper，被外部替换则按当前方法重新包装。
- sweep 对 `llm.adapters` 条目做形状守卫：条目为 null/非对象、`provider.id` 不符、adapter 为 null/非对象时跳过；`patchAdapterPrototype` 与 `ownerCount` 同样拒绝 null/非对象 adapter，畸形注册表不阻断 apply。
- sweep 与 `llm/adapters-updated` listener 安装在 apply 中同步完成，中间不插入 await。
- 只有 `llm.directory` 中 `settingsNs` 为官方 namespace 的 route 会被检查；对应 adapter registration 的 provider identity 必须与 route key 相同。
- directory entry.provider 是实际 route key；不以 directory Map key 作为 adapter 查询值。
- `llm.adapters` 不是 Map 时告警并退出 apply；`llm.directory` 不是 Map 时 sweep 返回零，仍监听后续 adapter 更新，初始 sweep 为零时记录无官方 adapter 告警。两种情况均不改变官方插件注册面。
- 会话标记与缺 sessionId 告警去重走 `src/lru.mjs` 的有界 LRU：Map 插入序即使用序，命中重排为最近使用，写入超上限淘汰最久未用键；标记缓存键为 `prefix + 会话`，prefix 热更后同会话按新前缀重算，同一键内标记稳定；容量以模块导出常量（`MARKER_CACHE_LIMIT` / `WARNED_CACHE_LIMIT`）表达，实现与用例共用同一来源。

## 验证

从仓库根运行：

```sh
npm test --prefix packages/dsh-llm-pi-gateway
node scripts/compat/affinity-probe-3proto.mjs --host-dir .compat/0.2.2-rc.3/dsh-host
```

第一条覆盖协议注入、不可变构造、显式头优先、开关、owner 实例授权、route 移除后 owner 的持续区间、无活跃 owner 直通、已保存 Models facade 的 dispose/reapply 生命周期、原型方法被外部替换后的重包、owner 计数幂等（同引用与省略 isActive）、畸形 registration 跳过、prefix 热更后同会话重算、dispose 旁路与 reapply、缓存上限与条目数封顶；`test/index.test.mjs` 另以 cordis 形态假 ctx（`on` 返回注销器、`fiber.effect` 立即执行并留存其注销器）覆盖 apply 装配：形态门槛告警禁用、存量授权、volatile ref 逐层解箱与 `loader/volatile-update` 热更（含 prefix 热更对已有会话生效）、`llm/adapters-updated` 补扫、缺省配置回落、dispose 注销监听与 reapply。两者都不覆盖真实 Cordis 域的跨 fiber 事件投递与真实宿主装载时序。第二条需要先安装该版本的隔离宿主，通过真实官方 PiAiAdapter 与 Models，使用手工构造的 provider fixture 向新起的 echo-upstream 实例发送请求，严格断言三协议成功流终态、会话稳定与隔离及 Chat 主要退出条件；它不覆盖 Cordis 装配或 GUI。

GUI 隔离测试与断言边界见 `兼容性测试.md`。Compat runner 的 UI roundtrip 断言覆盖当前 user 对应的 fixture 回复文本已渲染、response group 存在、composer 清空且 UI error/alert 为空；DOM 没有稳定跨协议终态信号，因此此项不证明生成流完整终止。runner 专用 `--echo-user-message` 仅在 default Chat/Anthropic 回复附带该轮 user 文本，Responses、think/tool 与公共 CLI 默认保持固定内容。全部 AI 自测使用隔离数据与新起的模拟器，不操作生产 profile。
