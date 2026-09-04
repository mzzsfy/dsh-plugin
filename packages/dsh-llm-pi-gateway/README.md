# @mzzsfy/dsh-llm-pi-gateway

DeepSeek Harness pi-ai 透传网关插件:官方 `dsh-llm-pi-ai` 的零感知增强替换——为 newapi 等网关路由提供全协议会话标记(渠道亲和性)、compat 全控、metadata 模板透传与静态 headers,实现会话粘性负载,最大化上游 prompt cache 命中。

## 零感知接管(0.2.0 起)

**装上即生效,用户无感**:插件通过 bundle patch 禁用官方 `dsh-llm-pi-ai` 行,并以**官方包自己的 Config schema** 接管 `llm-pi-ai:` 设置节——

- 现有官方配置**原样保留、原样生效**,路由名不变:`agent-default-model`、quota 面板、Models 页面、历史会话全部无缝继续
- 接管的路由自动获得会话标记(粘性默认开启),其余行为与官方逐项对表(见下节)
- `llm-pi-gateway:` 节仍可用:独立声明路由,或与官方节同名时整体覆盖(增强)
- **卸载即还原**:patch 随 bundle 移除,官方插件恢复,同一份配置继续由官方服务
- 防御:若 patch 失效(宿主升级等)官方插件仍在,本包接管官方节失败时降级为只服务 `llm-pi-gateway:` 节并记日志,不阻塞启动

## 官方兼容

需要 dsh 本体 0.1.2 及以上:激活时动态探测 dsh-llm 的 `resolveImageAttachmentAccess` / `offloadedImageText`(0.1.2 引入),缺失即打日志禁用插件,不注册 adapter 与 settings 节,不影响宿主启动与其他插件。

配置语义、请求装配、错误分类、生态声明口逐项对表官方 `dsh-llm-pi-ai@0.1.2-rc.1`,官方公共导出能复用的一律复用(仅 resolveModelReasoning 因官方未导出而平行实现):

- **profile 字段对齐**:官方 schema 全集可原样复制(`displayName` / `reasoning` / `thinkingBudgets` / `cacheRetention` / `transport` / `timeoutMs` / `websocketConnectTimeoutMs` / `retryPolicy` / `defaultContextWindow` / `defaultMaxTokens` / `defaultInput` / 模型级 `reasoningEfforts`);`reasoningEfforts` → `thinkingLevelMap`(未声明档位钉 null、off 无值缺席)与官方逐行同构。无模型目录,`modelOverrides` 明确拒绝(官方对无目录路由同语义)。
- **reasoning 声明与校验**:`resolveModel` 经 pi-ai `getSupportedThinkingLevels` 声明可选档位与 `defaultEffort`;请求路径 `options.reasoningEffort ?? profile.reasoning` 校验,不支持即 `UNSUPPORTED_REASONING_EFFORT`,`off` = 省略 reasoning 参数;描述路径宽松(不可描述省略,不藏路由)。
- **请求选项对齐**:`maxRetries: 0` 恒传(重试归 runtime retry policy,不与 pi-ai SDK 内部重试叠加),`transport` / `timeoutMs` / `websocketConnectTimeoutMs` / `thinkingBudgets` 透传。
- **凭据链**:`credentials.resolve` 引用优先 → 启动环境兜底 → 官方 `assertUsableApiKey` 校验;缺失 `MISSING_CREDENTIAL`。
- **attribution 头**:每请求携带官方 `user-agent`;用户撞名头大小写不敏感剥除。
- **错误分类对齐**:quota 判定(`QUOTA_EXCEEDED`)、超窗双通道(pi-ai usage 判定器 + dsh-llm 文本判定器 → `CONTEXT_WINDOW_EXCEEDED`)。
- **热更新**:改配置即生效(settings 服务 `installSection` 模式)——写入时校验拒绝坏配置,路由集/重试策略/显示名变化原地 `replace`,解析失败保旧路由;无路由时休眠,不注册 adapter。
- **生态声明口**:`registerConfigurableProviders`(配置面可见可寻址)+ `registerModelDiscovery`(openai 系协议可"拉取模型",anthropic 等明确 `DISCOVERY_UNSUPPORTED` 回退手录)+ `providerRetryPolicy`(路由级 `retryPolicy` 进注册)。
- **pi-ai 同栈**:依赖范围与官方一致(^0.82.1),协议行为与官方路由同一版本保证。

## 错误码

错误经 `GatewayError` 以 code/failure 形态暴露给 harness,按产生路径分组:

| 分组 | 码 | 说明 |
| --- | --- | --- |
| 配置期 | `INVALID_CONFIG` | settings 写入或路由解析时配置不符合 schema/约束被拒绝 |
| 请求期 | `UNKNOWN_MODEL` | 请求 model 未命中路由 models 表 |
| 请求期 | `INVALID_REQUEST` | 请求参数非法(如 sessionId 缺失或上游返回 400/413) |
| 请求期 | `UNSUPPORTED_CONTENT` | 内容形态不支持(非 user 图片、模型无 image 能力、结构化 assistant 图片回放等) |
| 请求期 | `UNSUPPORTED_REASONING_EFFORT` | 请求的 reasoning 档位不被目标模型支持 |
| 请求期 | `MISSING_CREDENTIAL` | apiKeyEnv 引用的凭据在引用链与环境内均不存在 |
| 请求期 | `NO_ADAPTER` | adapter 收到非本包路由的 provider 请求(接管失效或路由表错配) |
| 上游响应分类 | `AUTH` | 上游返回 401/403,凭据无效或无权限 |
| 上游响应分类 | `QUOTA_EXCEEDED` | 上游判定配额耗尽 |
| 上游响应分类 | `RATE_LIMIT` | 上游返回 429 或限流错误 |
| 上游响应分类 | `SERVER` | 上游返回 5xx 服务端错误 |
| 上游响应分类 | `TIMEOUT` | 请求超时 |
| 上游响应分类 | `TRANSPORT` | 传输层中断(流提前结束、连接不可用等) |
| 上游响应分类 | `CONTEXT_WINDOW_EXCEEDED` | 双通道(pi-ai usage 判定器 + dsh-llm 文本判定器)判定超出上下文窗口 |
| 上游响应分类 | `EMPTY_RESPONSE` | 上游返回空响应 |
| 上游响应分类 | `PI_AI_ERROR` | 其余 pi-ai 内部错误兜底分类 |
| 历史回放 | `INVALID_REPLAY_STATE` | 持久化 replay 信封格式或版本不可回放 |
| 流边界 | `STREAM_CLOSED` | pi-ai 事件流在 done/error 前即关闭 |
| 流边界 | `ABORTED` | 调用方取消使流式请求按 aborted 终态送达 |
| 模型发现 | `DISCOVERY_FAILED` | 模型列表拉取失败(不可达、超限、非 JSON、无 data 数组等) |
| 模型发现 | `DISCOVERY_UNSUPPORTED` | 协议在本 build 内无模型列表能力,回退手录 |
| 模型发现 | `INVALID_CREDENTIAL` | 发现请求凭据被上游拒绝 |
| 模型发现 | `ABORTED` | 发现请求被调用方中止 |

## 功能

- **图片输入(多模态,官方管线同构)**:请求含图片且模型声明 `input: [text, image]` 时,经 attachments 服务读出为 base64 块(handle 文本 + `image` 块),预算策略 `maxRequestImageBytes` / `requestImagePixelBudget` / `requestImageMaxBytes` 与官方同款(缺省 20MiB / 4Mi 像素 / 1MiB);非 user 角色图片、模型无 image 能力、attachments 服务缺失均按官方语义 `UNSUPPORTED_CONTENT`;纯文本路径零开销。
- **全协议会话标记(默认开启,每路由可关)**:请求体自动携带由 sessionId 单向派生的稳定标记(`dsh:<sha256 前 40 位>`,前缀可配)——anthropic-messages 写 `metadata.user_id`(同 Claude Code),openai-completions / openai-responses 写顶层 `prompt_cache_key`(同 Codex,无 `prompt_cache_retention` 副作用);未知协议形状不注入。经 pi-ai `onPayload`(请求体发出前最后一步)直写,不依赖 baseURL / retention 条件,上游原生发射时以本包标记覆盖。
- **compat 全控**:官方包 withhold 的粘性等字段全部开放(`sendSessionAffinityHeaders`、`sessionAffinityFormat`、`supportsDeveloperRole` 等),字段名按 pi-ai 0.82 各协议 compat 类型校验,值为 null 拒绝;模型级 compat 覆盖路由级。
- **metadata 模板透传**:字符串值支持 `{sessionId}` / `{marker}` 占位符;标记注入与模板独立,模板 `user_id` 键被标记覆盖,其余键照常透传。
- **静态 headers**:任意网关约定的兜底通道(请避开 attribution 保留头名)。
- **多模型路由**:一条路由声明多个模型,按请求 model 字段分发,未命中返回 `UNKNOWN_MODEL`。

## 配置(settings.yaml 命名空间 `llm-pi-gateway`)

```yaml
llm-pi-gateway:
  providers:
    new-api:                        # 路由名 = LLM provider 名
      displayName: New API          # 可选,配置面/选择器显示名
      api: anthropic-messages       # 或 openai-completions / openai-responses
      baseURL: https://newapi.example.com
      apiKeyEnv: NEW_API_API_KEY    # 凭据引用(credentials 服务或环境变量)
      reasoning: high               # 可选,路由级默认档位(模型需支持)
      sessionMarker:                # 会话标记,默认开启
        enabled: true
        prefix: dsh                 # 派生标记前缀
      metadata:                     # anthropic metadata 模板(可选)
        user_id: '{"gateway":"newapi","session":"{sessionId}"}'
      compat:                       # 路由级 compat 覆盖,无 withhold
        sendSessionAffinityHeaders: true
        sessionAffinityFormat: openai   # 仅 openai 系协议生效
      headers:                      # 静态自定义头(粘性兜底通道)
        x-gateway-group: pool-a
      cacheRetention: short         # 可选:none / short / long
      defaultContextWindow: 262144  # 可选,模型未声明时的兜底
      retryPolicy:                  # 可选,注册捕获,进 runtime 重试
        mode: normal
        maxRetries: 2
      models:
        - id: auto
          contextWindow: 200000
        - id: claude-sonnet
          name: Claude Sonnet
          input: [text, image]
          maxTokens: 16384
          # 档位字典:key = 档位,value = wire 拼写;未声明档位 = 不支持;
          # off 无值 = 支持且不发参数;false = 非推理模型
          reasoningEfforts:
            off:
            low: low
            max: ultra
          compat:
            sendSessionAffinityHeaders: true
        - id: gpt-4o
          compat:
            sendSessionAffinityHeaders: true
            sessionAffinityFormat: openai   # openai 三头 / openrouter 单头 x-session-id
```

配置修改**即时生效**(无需重启);解析失败时保留上一份好配置。纯 host 端,无 GUI。

## 粘性生效前提

网关侧需按对应键路由:newapi 粘性键勾选 `metadata.user_id` / `x-session-affinity` / `x-session-id` / `prompt_cache_key` 之一。本包只保证标识发出,网关行为不在边界内。

## 安装

```sh
dsh plugin --profile web add @mzzsfy/dsh-llm-pi-gateway
```

重启 dsh 生效。**无需任何配置改动**:官方 `llm-pi-ai:` 节原样接管(官方 schema 消费),路由名不变,粘性自动开启。`llm-pi-gateway:` 节仅用于增强覆盖(同名整体优先)或独立路由。

卸载插件 = 官方原样接管回来,同一份配置继续工作。

## 已知取舍

- 事件流适配与 pi-ai 数据结构耦合,pi-ai 协议 payload 形状大改时标记器判别需跟随;未知形状不注入保证不误伤。
- 无流空闲超时看门狗;pi-ai 依赖范围与官方 dsh-llm-pi-ai 保持一致(^0.82.1),官方升级范围时本包需跟随。
- sessionMarker.enabled=false 不拦截 metadata 模板的静态 user_id 键透传(该键来自模板而非标记器,不含会话派生标识)。
- 上游错误以文本分类(pi-ai 把捕获错误展平为 message 字符串),quota/超窗判定用官方同款判定器,其余分支与官方同序同构。
- 本包未复用 dsh-llm 类(插件依赖以副本安装,class 身份不通;错误以 own `code` / `failure` 数据属性被 harness 错误边界识别),官方公共导出仅消费纯函数与 schema 对象。
- `reasoningEfforts` → `thinkingLevelMap` 解析为平行实现(官方未导出该函数),以对表测试锚定语义。

## 开发

```sh
npm test        # node --test test/*.test.mjs,纯逻辑层;devDependencies 提供官方包对表实现
```
