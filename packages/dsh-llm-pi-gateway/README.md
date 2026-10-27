# @mzzsfy/dsh-llm-pi-gateway

为 DSH LLM 请求补齐会话亲和键。gateway 不禁用或接管官方 `llm-pi-ai`，也不注册 adapter、directory 或 discovery；官方插件继续负责 provider、设置和模型发现。

## 安装

```sh
dsh plugin --profile web add @mzzsfy/dsh-llm-pi-gateway
```

启用官方 `llm-pi-ai` 后，无需迁移 provider 配置。`llm-pi-gateway` 的 `sessionMarker.enabled` 默认开启，控制本插件的自动注入；`sessionMarker.prefix` 仅作用于 Anthropic 派生标记。禁用或卸载 gateway 后，官方 provider 继续服务。

## 三协议行为

| 协议 | gateway 行为 | 上游提取位置 |
| --- | --- | --- |
| Chat Completions (`openai-completions`) | 补 `session_id`、`x-client-request-id` 请求头，值为原始 DSH `sessionId` | request_header `session_id` 或 `x-client-request-id` |
| Responses (`openai-responses`) | 原 options 透传，保留 pi-ai 原生行为 | 当前验证的 pi-ai 默认发送上述两个头及请求体顶层 `prompt_cache_key` |
| Anthropic Messages (`anthropic-messages`) | 注入派生 `metadata.user_id`，格式为 `<prefix>:<40 位小写十六进制>`，默认前缀 `dsh` | —(本包按 sessionId 本地派生后注入,不从上游提取；上游亲和以 Anthropic 服务端 metadata 策略为准) |

Chat 补齐规则：仅在开关开启、owner 活跃、`sessionId` 为非空字符串且 `cacheRetention !== 'none'` 时生效。`options.headers` 和模型描述的 `model.headers` 中，大小写无关的显式同名键均优先，包括用于抑制头的 `null`；只补缺失键，不改写输入。请求中会发送原始 sessionId，规则沿用 Responses 的会话键语义。同会话多轮保持相同值，不同会话使用不同值。

Responses 表中的原生键已在 DSH `0.2.1-rc.2`、pi-ai `1.3.0` 的通用自定义 endpoint 上验证；原生行为由宿主所带 pi-ai 决定。该版本 `cacheRetention: 'none'` 会抑制这些自动键，关闭 gateway 开关不会关闭 Responses 原生行为。

Anthropic 标记由 sessionId 派生，不包含原始 sessionId；同 owner 内同会话缓存标记，修改 prefix 后已见会话保留原值，新会话使用新前缀。它使用 Anthropic 的 metadata 字段，不构造 Claude Code 的账号身份格式。Chat 不新增 `metadata`、`prompt_cache_key`、`prompt_cache_retention`、`x-session-id` 或 `x-session-affinity`。

上游亲和提取规则必须匹配实际字段。例如 `prompt_cache_key` 在请求体顶层，`metadata.prompt_cache_key` 无法提取它。字段到达上游只证明可供提取；实际路由亲和仍取决于上游规则、候选渠道和缓存状态。

## 装饰边界

通过 `llm.directory` 中 `settingsNs === 'llm-pi-ai'` 的 entry 识别官方 route，以 `entry.provider` 查询 adapter registration 并核对 registration `provider.id`。原型 wrapper 为每次调用复制 snapshot；Models 可装饰时创建 Proxy facade，owner 仅绑定被授权的 adapter 实例。同原型的未授权实例和不同原型共享 Models 的实例均保持隔离。

授权在 sweep 时累加，route 移除不立即撤销已授权实例，持续至所属 gateway dispose。adapter 原型缺少目标方法或不接受 shadow 时旁路；Models 不是对象或 streamSimple 不是函数时保留原 Models，不创建 facade。对已授权、活跃且开启注入的 Chat/Anthropic 请求，满足其余注入条件但缺有效 sessionId 时，按实际模型告警一次并透传；Responses 和未知协议始终由 gateway 原样透传。

## 验证

从仓库根运行单测：

```sh
npm test --prefix packages/dsh-llm-pi-gateway
```

在已安装的隔离宿主上验证三协议实际 HTTP 请求：

```sh
node scripts/compat/affinity-probe-3proto.mjs --host-dir <本机隔离宿主闭包目录,如 .compat/<版本>/dsh-host>
```

该探针需要对应目录已安装 DSH 及其 pi-ai 依赖，通过真实官方 `PiAiAdapter`、Models 和 gateway 装饰器调用新起的 echo-upstream 随机端口实例，断言流以成功终态结束、同会话稳定、新会话隔离、开关、卸载、`none` 及显式头优先。请求 JSONL 与结果保留在输出的临时目录，模拟器在结束时退出。它使用手工构造的 provider fixture，不验证 Cordis 装配、GUI 或真实上游路由策略。

GUI 的隔离测试方法与覆盖边界见 [兼容性测试.md](./兼容性测试.md)。Compat runner 的 UI roundtrip 只证明当前 turn 的 fixture 回复已渲染、composer 清空且 UI error/alert 为空，不证明协议流完整终止；实际 adapter 探针另行检查成功终态。

## dsh 版本兼容

按仓库动态窗口验证(scripts/compat/window.mjs),不预置任何固定版本槽:主测 = 渠道 dist-tag 最新 rc,完全适配口径;基线 = npm latest,不崩溃底线口径;主测与基线同版时收敛单槽。本包声明 `dsh.hostMin = "0.2.0-rc.1"`,低于该代际的宿主 API 面未验证,compat 装载层自动排除。逐轮实测结论见 `docs/兼容性测试/逐包测试进度.md`(本地维护,不入库)与本包 [兼容性测试.md](./兼容性测试.md)。
