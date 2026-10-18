# @mzzsfy/dsh-llm-pi-gateway

为 DSH LLM 请求提供会话标记增强。gateway 不禁用或接管官方 `llm-pi-ai`，也不注册 adapter、directory 或 discovery；官方插件继续负责 provider、设置和模型发现。

当前装饰器通过 `llm.directory` 中 `settingsNs` 为官方 namespace 的 entry 筛选 route，以 `entry.provider` 查询 adapter registration 并核对 registration `provider.id`；DSH `0.2.0-rc.2` 的 directory Map key 与 entry.provider 契约一致。每次调用都会复制 snapshot；Models 可装饰时才创建 Proxy facade，owner 仅绑定扫描中命中的 registration adapter 实例；只有该实例的 `anthropic-messages` 请求会注入派生 `metadata.user_id`。同原型但未被官方 route 授权的其他实例不会注入；授权在 sweep 时累加，route 移除不立即撤销已授权实例，持续至 gateway dispose。不同原型共享 Models 的实例也彼此隔离。

## 安装

```sh
dsh plugin --profile web add @mzzsfy/dsh-llm-pi-gateway
```

启用官方 `llm-pi-ai` 后，gateway 无需迁移官方 provider 配置。禁用或卸载 gateway 不会禁用官方 provider。会话标记默认开启，可在 `llm-pi-gateway` 插件配置中调整开关和前缀。

## 行为边界

- 标记值由会话 `sessionId` 派生，不在请求中暴露原始 sessionId。
- 只注入 Anthropic `metadata.user_id`；OpenAI 请求保持原样。
- adapter 原型或 Models 方法不可装饰时，gateway 旁路，不阻止原始请求。
- gateway 不替代官方插件的 provider 配置、模型目录或发现功能。
- Compat seed 使用 echo provider fixture 验证双协议 assistant 文本渲染、上游路由与派生 marker，未覆盖用户真实 provider 配置的完整契约。

## 验证

在仓库根目录运行 gateway 单测：

```sh
npm test --prefix packages/dsh-llm-pi-gateway
```

在仓库根目录运行隔离兼容测试：

```sh
node scripts/compat/run.mjs --version 0.2.0-rc.2 --host-dir .compat/0.2.0-rc.2/dsh-host --work-root .compat/gateway-0.7.2-final-validation --only dsh-llm-pi-gateway --seed-gateway
```

当前 `roundtrip` 断言只证明当前 turn 的 fixture 回复文本已渲染、composer 已清空且 UI error/alert 为空，不证明生成流以协议终态完整结束；DOM 目前没有稳定的跨协议终态标记。因此该 compat 门不覆盖“已显示完整文本 delta 后连接异常中断”的情况，echo-upstream 协议单测验证模拟器成功响应会发出协议终止事件；真实宿主消费端的终态契约留待出现稳定可观测信号后扩展。

Compat simulator 显式启用 `--echo-user-message`；该开关仅作用于 default OpenAI Chat Completions 与 Anthropic Messages，非流式及流式响应都会回显请求中的兼容测试 user 文本，供当前轮 UI 文本渲染判定。Responses、think/tool 及公共 CLI 默认不附加该文本。

## dsh 版本兼容

按仓库动态窗口验证(scripts/compat/window.mjs),不预置任何固定版本槽:主测 = 渠道 dist-tag 最新 rc,完全适配口径;基线 = npm latest,不崩溃底线口径;主测与基线同版时收敛单槽。本包声明 `dsh.hostMin = "0.2.0-rc.1"`:低于该代际的宿主 API 面未验证,compat 装载层自动排除。逐轮实测结论见 `docs/兼容性测试/逐包测试进度.md` 与本包 `兼容性测试.md`。
