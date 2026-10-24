# Gateway Provider 装饰器 BDD

状态：已实施。三协议实际 adapter 请求验证覆盖 DSH `0.2.1-rc.2` / pi-ai `1.3.0`，同版本有头 GUI 四主轮回归通过；历史 GUI 隔离兼容测试覆盖 DSH `0.2.0-rc.2`。验证均使用 echo fixture，不代表真实上游路由策略或真实 provider 的完整契约。

## 目标

- 官方 `llm-pi-ai` 行保持启用，自行负责 provider 注册、配置节和模型发现。
- gateway 不注册 adapter、directory 或 discovery，不禁用官方插件。
- gateway 通过 `llm.directory` 中 `settingsNs === 'llm-pi-ai'` 的 entry 识别官方 route，以 entry.provider 字段检索 `llm.adapters` 并核对 registration `provider.id`；该字段与 directory Map key 一致是 DSH `0.2.0-rc.2` 的宿主契约。只有原型提供 `streamWithSnapshot` 的官方 adapter 被装饰，目标为 PiAiAdapter。
- 原型 wrapper 为每次调用复制 snapshot；Models 可装饰时才构造 facade，owner 绑定到官方 route 授权的 adapter 实例，而非仅绑定原型。同原型的非授权实例及不同原型共享 Models 的 adapter 均不得注入。
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
- **And** 已验证的 pi-ai Responses 默认发送 `session_id`、`x-client-request-id` 与顶层 `prompt_cache_key`，`cacheRetention: 'none'` 时不自动发送这些键

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

### 前缀配置热更新

- **Given** 同一 gateway owner 已为会话派生标记，随后配置 prefix 更新
- **When** 旧 sessionId 与新 sessionId 分别发起 Anthropic 请求
- **Then** 已见过的 sessionId 稳定使用缓存的原标记，新 sessionId 使用当前 prefix

### sessionId 缺失

- **Given** 官方 adapter 已授权、owner 活跃且开关开启，Anthropic 或满足其他注入条件的 Chat options 没有非空字符串 sessionId
- **When** 请求经过已装饰的 streamSimple
- **Then** 不新增会话键，原 options 透传，并按实际 model.id 告警一次


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

- 原型 wrapper 为每次调用复制 snapshot；Models 可装饰时才构造 facade，facade 的 `streamSimple` 闭包携带当前 adapter 实例，底层函数以原 Models 为 this 调用。
- 稳定原型 wrapper 通过 WeakMap 保存实例 owner；同一实例重复 sweep 不重复添加 owner，旧 owner dispose 后旁路，新 apply 时同一注册实例由新 owner 恢复注入。
- sweep 与 `llm/adapters-updated` listener 安装在 apply 中同步完成，中间不插入 await。
- 只有 `llm.directory` 中 `settingsNs` 为官方 namespace 的 route 会被检查；对应 adapter registration 的 provider identity 必须与 route key 相同。
- directory entry.provider 是实际 route key；不以 directory Map key 作为 adapter 查询值。
- `llm.adapters` 不是 Map 时告警并退出 apply；`llm.directory` 不是 Map 时 sweep 返回零，仍监听后续 adapter 更新，初始 sweep 为零时记录无官方 adapter 告警。两种情况均不改变官方插件注册面。

## 验证

从仓库根运行：

```sh
npm test --prefix packages/dsh-llm-pi-gateway
node scripts/compat/affinity-probe-3proto.mjs --host-dir .compat/0.2.1-rc.2/dsh-host
```

第一条覆盖协议注入、不可变构造、显式头优先、开关、owner 实例授权、route 移除后 owner 的持续区间、dispose 旁路与 reapply；不模拟 Cordis apply/fiber 和 listener 装配。第二条需要先安装该版本的隔离宿主，通过真实官方 PiAiAdapter 与 Models，使用手工构造的 provider fixture 向新起的 echo-upstream 实例发送请求，严格断言三协议成功流终态、会话稳定与隔离及 Chat 主要退出条件；它不覆盖 Cordis 装配或 GUI。

GUI 隔离测试与断言边界见 `兼容性测试.md`。Compat runner 的 UI roundtrip 断言覆盖当前 user 对应的 fixture 回复文本已渲染、response group 存在、composer 清空且 UI error/alert 为空；DOM 没有稳定跨协议终态信号，因此此项不证明生成流完整终止。runner 专用 `--echo-user-message` 仅在 default Chat/Anthropic 回复附带该轮 user 文本，Responses、think/tool 与公共 CLI 默认保持固定内容。全部 AI 自测使用隔离数据与新起的模拟器，不操作生产 profile。
