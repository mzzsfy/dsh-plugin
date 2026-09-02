# @mzzsfy/dsh-llm-pi-gateway

DeepSeek Harness pi-ai 透传网关插件:为 newapi 等网关声明自有 LLM 路由,提供全协议会话标记、compat 全控、metadata 模板透传与静态 headers,实现会话粘性负载,最大化上游 prompt cache 命中。

与 `dsh-llm-pi-ai` 并存:官方包管标准路由,本包管网关路由,路由名不同即可同时服务;同名路由会加载失败(与官方 adapter 同语义)。

## 功能

- **全协议会话标记(默认开启,每路由可关)**:请求体自动携带由 sessionId 单向派生的稳定标记(`dsh:<sha256 前 40 位>`,前缀可配)——anthropic-messages 写 `metadata.user_id`(同 Claude Code),openai-completions / openai-responses 写顶层 `prompt_cache_key`(同 Codex,无 `prompt_cache_retention` 副作用);未知协议形状不注入。经 pi-ai `onPayload`(请求体发出前最后一步)直写,不依赖 baseURL / retention 条件,上游原生发射时以本包标记覆盖。
- **compat 全控**:官方包 withhold 的粘性等字段全部开放(`sendSessionAffinityHeaders`、`sessionAffinityFormat`、`supportsDeveloperRole` 等),字段名按 pi-ai 各协议 compat 类型校验,值为 null 拒绝;模型级 compat 覆盖路由级。
- **metadata 模板透传**:字符串值支持 `{sessionId}` / `{marker}` 占位符;标记注入与模板独立,模板 `user_id` 键被标记覆盖,其余键照常透传。
- **静态 headers**:任意网关约定的兜底通道(请避开 attribution 保留头名)。
- **多模型路由**:一条路由声明多个模型,按请求 model 字段分发,未命中返回 `UNKNOWN_MODEL`;凭据缺失返回 `MISSING_CREDENTIAL`,不回退其他密钥。
- 配置修改**重启后生效**;纯 host 端,无 GUI(模型清单全手写,`ctx.llm.listModels` 自动进官方模型选择器)。

## 配置(settings.yaml 命名空间 `llm-pi-gateway`)

```yaml
llm-pi-gateway:
  providers:
    new-api:                        # 路由名 = LLM provider 名
      api: anthropic-messages       # 或 openai-completions / openai-responses
      baseURL: https://newapi.example.com
      apiKeyEnv: NEW_API_API_KEY    # 凭据引用的环境变量名
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
      contextWindow: 200000         # 可选,模型未声明时的兜底上下文窗口
      models:
        - id: auto
          contextWindow: 200000
        - id: claude-sonnet
          name: Claude Sonnet
          input: [text, image]
          maxTokens: 16384        # 可选,缺省 8192;reasoning 可选,缺省 true
          compat:
            sendSessionAffinityHeaders: true
        - id: gpt-4o
          compat:
            sendSessionAffinityHeaders: true
            sessionAffinityFormat: openai   # openai 三头 / openrouter 单头 x-session-id
```

## 粘性生效前提

网关侧需按对应键路由:newapi 粘性键勾选 `metadata.user_id` / `x-session-affinity` / `x-session-id` / `prompt_cache_key` 之一。本包只保证标识发出,网关行为不在边界内。

## 安装

```sh
dsh plugin --profile web add @mzzsfy/dsh-llm-pi-gateway
```

重启 dsh 生效;配置修改重启后生效(见上)。

## 已知取舍

- 事件流适配与 pi-ai 数据结构耦合,pi-ai 协议 payload 形状大改时标记器判别需跟随;未知形状不注入保证不误伤。
- v1 不支持图片输入(任何 image 块返回 `UNSUPPORTED_CONTENT`),无模型目录发现,无流空闲超时看门狗。
- 上下文超限识别按错误文本近似,非官方判定器精确语义。
- 本包未复用 dsh-llm 类(避免依赖副本类身份问题):adapter 为满足 LlmAdapter 协议的纯对象,错误以 own `code` / `failure` 数据属性被 harness 错误边界识别。

## 开发

```sh
npm test        # node --test test/*.test.mjs,纯逻辑层无外部依赖
```

## 开发安装(不经 npm 发布直接装仓库副本)

```sh
dsh plugin --profile web add file:./packages/dsh-llm-pi-gateway
```

`file:` 安装指向仓库工作副本,改代码后重跑该命令即同步,无需发版。
