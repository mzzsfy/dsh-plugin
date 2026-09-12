# @mzzsfy/dsh-llm-pi-gateway

把 DSH 会话的 sessionId 注入发往 newapi 等 LLM 网关的每个请求,供网关做请求亲和性(粘性会话路由):同一会话的请求稳定落到同一上游渠道,上游 prompt cache 命中是这种路由方式的结果。形态上是官方 `dsh-llm-pi-ai` 的零感知增强替换(装上即接管、卸载即还原),compat 全控、metadata 模板透传与静态 headers 兜底一并提供。

## sessionId 注入通道

核心能力:每条路由的每个上游请求自动携带会话标识,网关按任一载体做粘性键即可实现请求亲和性:

| 通道 | 载体 | 值 | 生效条件 |
| --- | --- | --- | --- |
| 请求体标记 | anthropic-messages 写 `metadata.user_id`(同 Claude Code);openai-completions / openai-responses 写顶层 `prompt_cache_key`(同 Codex,无 `prompt_cache_retention` 副作用) | sessionId 单向派生的稳定标记 `dsh:<sha256 前 40 位>`,前缀可配 | 默认开启,每路由可关(`sessionMarker.enabled`);不受 `cacheRetention` 影响 |
| 亲和头 | 按协议与 `sessionAffinityFormat`,精确映射见下 | 裸 sessionId 原样 | sessionId 在场且 `cacheRetention` ≠ `none`;anthropic-messages / openai-completions 另需 compat `sendSessionAffinityHeaders: true`,openai-responses 无需 compat |
| metadata 模板 | anthropic `metadata` 任意键透传(openai 系路由声明 metadata 无效果) | 字符串值渲染 `{sessionId}` / `{marker}` 占位符 | 依赖标记通道:非 user_id 键经标记 onPayload 合入请求体,`sessionMarker.enabled=false` 时仅 user_id 键经 pi-ai 原生转发,其余键不上 wire;模板 `user_id` 键标记开启时恒被派生标记覆盖 |
| 静态 headers | 任意网关约定的自定义头 | 固定值 | 声明即生效;与亲和头同名时静态头后写覆盖;请避开 attribution 保留头名 |

亲和头精确映射(头集合随协议与 `sessionAffinityFormat` 不同,网关粘性键须按所选形态勾选):

| 协议 | 头集合 |
| --- | --- |
| anthropic-messages | `x-session-affinity` |
| openai-completions | format `openai`:`session_id` + `x-client-request-id` + `x-session-affinity`;format `openai-nosession`:`x-client-request-id` + `x-session-affinity`;format `openrouter`:`x-session-id` |
| openai-responses | format `openai`:`session_id` + `x-client-request-id`;format `openai-nosession`:`x-client-request-id`;format `openrouter`:`x-session-id` |

format 未声明时由 pi-ai 自动检测:provider 名为 `openrouter`(精确匹配)或 baseUrl 含 `openrouter.ai` 判为 `openrouter`,否则 `openai`——newapi 类路由未声明即按 `openai` 头集合发射。

- 标记经 pi-ai `onPayload`(请求体发出前最后一步)直写,不依赖 baseURL / retention 条件,上游原生发射的同名键以本包值覆盖;路由按显式 api 直注,形状判别仅为 api 缺失时的兜底,未知形状不注入。
- 亲和头由 pi-ai 按路由 compat 与 `cacheRetention` 门控:`cacheRetention: none` 抑制全部亲和头(亲和头不再携带会话 id,请求体通道不受影响);`sessionAffinityFormat` 仅 openai 系 compat 名单内合法,取值 `openai` / `openai-nosession` / `openrouter`,声明其他值不报错但产生残缺头集合。
- sessionId 缺省契约:标记关闭且模板不引用 `{sessionId}` 的路由允许请求缺省 sessionId(官方 wire 契约同构);接管路由标记默认开启,sessionId 因此默认必填。
- 粘性生效前提:网关侧按对应键做亲和路由,粘性键勾选上述载体之一(`metadata.user_id` / `prompt_cache_key` / `x-session-affinity` / `x-client-request-id` / `session_id` / `x-session-id`,按路由协议与 format 取其一);本包只保证标识发出,网关行为不在边界内。

## 零感知接管(0.2.0 起)

**装上即生效,用户无感**:插件通过 bundle patch 禁用官方 `dsh-llm-pi-ai` 行,并以**官方包自己的 Config schema** 接管 `llm-pi-ai:` 设置节——

- 现有官方配置**原样保留、原样生效**,路由名不变:`agent-default-model`、quota 面板、Models 页面、历史会话全部无缝继续
- 接管的路由自动获得 sessionId 注入(请求体标记默认开启;亲和头 anthropic-messages / openai-completions 经 compat 开启,openai-responses 默认开启),其余行为与官方逐项对表(见下节)
- `llm-pi-gateway:` 节仍可用:独立声明路由,或与官方节同名时整体覆盖(增强)
- **卸载即还原**:patch 随 bundle 移除,官方插件恢复,同一份配置继续由官方服务
- 防御:若 patch 失效(宿主升级等)官方插件仍在,本包接管官方节失败时降级为只服务 `llm-pi-gateway:` 节并记日志(命名空间注册冲突与一般失败区分文案),不阻塞启动;官方包本体不可用时同样降级并告警;运行中安装/热重载时官方行退场被在途流拖长属于常态,快速等待窗耗尽只表示接管推迟——官方行退场后本包自动补完成接管,不永久降级

### 禁用与还原

宿主注册面(adapter/directory/discovery/settings 命名空间)全部排他,官方插件与本包无法共存,因此**官方行的禁用由本包 bundle patch 静态声明,不随本包行被禁用而失效**。

**dsh-market 开关 / 单行禁用(普通用户)**:直接在 dsh-market 点禁用,或只写一行 `- id: llm-pi-gateway` + `disabled: true`。bundle patch 会同时插入一个哨兵行(`llm-pi-gateway/guard`,market 的行写入对其 id 拒绝,不会被连带禁用):两行同禁的窗口期(点禁用后到下次重启)内,哨兵动态挂载官方插件恢复服务,所有模型继续可用;重启后本包 patch 随 bundle 移出(market 对本包按 disable-carrier 处理),官方插件原生接管,哨兵自动退场。重新点启用则哨兵先卸载,本包无缝接管回来。market 路径每次开关会对哨兵行记一条「行 id 含特殊字符,不支持写入补丁层」警告,属预期噪音。手写单行禁用(不移出 bundles)时,哨兵的自愈在每次重启后重新生效,死态窗口由哨兵长期兜底。

**补丁层两行禁用(高级用户,不重启即时生效)**:

```yaml
- id: llm-pi-gateway
  disabled: true
- id: llm-pi-ai
  disabled: false
```

- 官方行复活让位守卫:上述两行写入后热重载时,本包在官方插件重新注册前自停让位,官方无缝接管,不出现注册冲突拖垮 patch 应用;反之删掉这两行恢复接管时,本包等官方插件退场落定后再接管——退场受在途流拖长而超出快速等待窗(约 1 秒)时,本包先只服务 `llm-pi-gateway:` 节(告警披露),官方行最终退场后**自动补完成接管**(复活守卫 + 官方 discovery/节 + 路由重算),服务与 sessionId 注入最终一致,无需重启
- 完全卸载本包(`dsh plugin remove`)无需任何 patch 改动,patch 随 bundle 移除,官方行自动恢复
- 两节 provider 同名重叠时的归属:官方在场(让位态)下官方插件先注册,本包自有节若声明了与官方节同名的 provider,整组路由注册被宿主排他检查拒绝,本包节路由(含不重叠的)整体不服务,仅日志披露——让位态请避免两节同名,或接受官方节优先
- 官方行 `disabled` 写为 `!!js` 表达式且求值出错时,本包按未禁用让位(官方节归官方,不制造注册冲突);若官方行实际未启用,会出现双空闲(provider 路由无人服务),需修正表达式或改静态布尔

## 官方兼容

需要 dsh 本体 0.1.2 及以上:激活时动态探测 dsh-llm 的 `resolveImageAttachmentAccess` / `offloadedImageText`(0.1.2 引入),缺失即打日志禁用插件,不注册 adapter 与 settings 节,不影响宿主启动与其他插件。

配置语义、请求装配、错误分类、生态声明口逐项对表官方 `dsh-llm-pi-ai@0.1.2-rc.1`,官方公共导出能复用的一律复用(仅 resolveModelReasoning 因官方未导出而平行实现):

- **profile 字段对齐**:官方 schema 全集可原样复制(`displayName` / `reasoning` / `thinkingBudgets` / `cacheRetention` / `transport` / `timeoutMs` / `websocketConnectTimeoutMs` / `retryPolicy` / `defaultContextWindow` / `defaultMaxTokens` / `defaultInput` / 模型级 `reasoningEfforts`);`reasoningEfforts` → `thinkingLevelMap`(未声明档位钉 null、off 无值缺席)与官方逐行同构。无模型目录,`modelOverrides` 明确拒绝(官方对无目录路由同语义)。
- **官方节 catalog 形态路由**:官方 Config 允许 provider 仅声明 `apiKeyEnv`(无协议/端点/模型目录)。接管期间该形态路由**不被任何 adapter 服务**(官方行已被 patch 禁用,本包未复刻官方目录物化),请求与配置面拉取模型都会失败,仅以日志披露;需要该路由请改写为手写完整路由(`api`/`baseURL`/`models`)或卸载本包。跳过不硬拒是为保住同节其余路由;本包节手写配置出现 catalog 形态则硬拒(fail loud)。
- **reasoning 声明与校验**:`resolveModel` 经 pi-ai `getSupportedThinkingLevels` 声明可选档位与 `defaultEffort`;请求路径 `options.reasoningEffort ?? profile.reasoning` 校验,不支持即 `UNSUPPORTED_REASONING_EFFORT`,`off` = 省略 reasoning 参数;描述路径宽松(不可描述省略,不藏路由)。
- **请求选项对齐**:`maxRetries: 0` 恒传(重试归 runtime retry policy,不与 pi-ai SDK 内部重试叠加),`transport` / `timeoutMs` / `websocketConnectTimeoutMs` / `thinkingBudgets` 透传;不支持请求选项(`stop`)显式 `UNSUPPORTED_OPTION` 拒绝。
- **凭据链**:`credentials` 服务在场即唯一来源(未命中即 `MISSING_CREDENTIAL`,不回落启动环境——防已删除凭据被过期环境变量静默复活);服务缺席才走启动环境;官方 `assertUsableApiKey` 校验。
- **模型发现**:两节命名空间各注册同一 discovery(官方节接管后官方注册随之消失,不补则官方配置面拉取模型必失败);宿主取消 signal 透传探测请求;探测请求合入路由自定义 `headers`(网关分组头等生效),`accept` / `authorization` / attribution 保留头后写覆盖。
- **attribution 头**:每请求携带官方 `user-agent`;用户撞名头大小写不敏感剥除。
- **错误分类对齐**:quota 判定(`QUOTA`,经 dsh-llm `QUOTA_EXCEEDED_CODE`)、超窗双通道(pi-ai usage 判定器 + dsh-llm 文本判定器 → `CONTEXT_WINDOW_EXCEEDED`);调用方取消时流出界兜底归因 `ABORTED`(带根因 cause),不落 `UNKNOWN`。
- **热更新**:改配置即生效(settings 服务 `installSection` 模式)——写入时校验拒绝坏配置,路由集/重试策略/显示名变化原地 `replace`,解析失败保旧路由;无路由时休眠,不注册 adapter。`prepareCall` 解析结果快照冻结,热更换表不产生目录信息与请求路由代际错配。
- **生态声明口**:`registerConfigurableProviders`(配置面可见可寻址)+ `registerModelDiscovery`(openai 系协议可"拉取模型",anthropic 等明确 `DISCOVERY_UNSUPPORTED` 回退手录)+ `providerRetryPolicy`(路由级 `retryPolicy` 进注册);adapter 挂 `LlmAdapter` 原型继承基类默认方法(含 `imageRequestPricing`,声明无 provider 侧图片定价,计量回退中性估算),宿主接口演进新增默认实现时自动跟随。
- **pi-ai 同栈**:依赖下界较官方收紧(官方 dsh-llm-pi-ai 0.1.2-rc.1 为 ^0.84.2;本包 compat 名单含 0.84.4 才引入的字段,下界抬至 ^0.84.4),协议行为与官方路由同一版本保证;compat 字段名单按 pi-ai 0.84.4 各协议类型声明校验。

## 错误码

错误经 `GatewayError` 以 code/failure 形态暴露给 harness,按产生路径分组:

| 分组 | 码 | 说明 |
| --- | --- | --- |
| 配置期 | `INVALID_CONFIG` | settings 写入或路由解析时配置不符合 schema/约束被拒绝 |
| 请求期 | `UNKNOWN_MODEL` | 请求 model 未命中路由 models 表 |
| 请求期 | `INVALID_REQUEST` | 请求参数非法(会话标记/模板依赖的 sessionId 缺失、上游返回 400/413) |
| 请求期 | `UNSUPPORTED_CONTENT` | 内容形态不支持(非 user 图片、模型无 image 能力、结构化 assistant 图片回放等) |
| 请求期 | `UNSUPPORTED_REASONING_EFFORT` | 请求的 reasoning 档位不被目标模型支持 |
| 请求期 | `UNSUPPORTED_OPTION` | 请求选项不受支持(如 `stop`,终止请走 AbortSignal) |
| 请求期 | `MISSING_CREDENTIAL` | `credentials` 服务在场时服务内不存在;服务缺席时启动环境内不存在(两通道互斥,不叠加回退) |
| 请求期 | `NO_ADAPTER` | adapter 收到非本包路由的 provider 请求(接管失效或路由表错配) |
| 上游响应分类 | `AUTH` | 上游返回 401/403,凭据无效或无权限 |
| 上游响应分类 | `QUOTA` | 上游判定配额耗尽(经 dsh-llm `QUOTA_EXCEEDED_CODE` 常量,值为 `QUOTA`) |
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

## 其他功能

- **图片输入(多模态,官方管线同构)**:请求含图片且模型声明 `input: [text, image]` 时,经 attachments 服务读出为 base64 块(handle 文本 + `image` 块),预算策略 `maxRequestImageBytes` / `requestImagePixelBudget` / `requestImageMaxBytes` 与官方同款(缺省 20MiB / 4Mi 像素 / 1MiB);非 user 角色图片、模型无 image 能力、attachments 服务缺失均按官方语义 `UNSUPPORTED_CONTENT`;纯文本路径零开销。
- **compat 全控**:官方包(0.1.2-rc.1)withhold 的字段全部开放(`supportsDeveloperRole` 等;`sendSessionAffinityHeaders` / `sessionAffinityFormat` 即上表亲和头通道),字段名按 pi-ai 0.84.4 各协议 compat 类型校验,值为 null 拒绝;模型级 compat 覆盖路由级。
- **多模型路由**:一条路由声明多个模型,按请求 model 字段分发,未命中返回 `UNKNOWN_MODEL`。

## 配置(settings.yaml 命名空间 `llm-pi-gateway`)

```yaml
llm-pi-gateway:
  providers:
    new-api-claude:                 # 路由名 = LLM provider 名
      displayName: New API Claude   # 可选,配置面/选择器显示名
      api: anthropic-messages       # 或 openai-completions / openai-responses
      baseURL: https://newapi.example.com
      apiKeyEnv: NEW_API_API_KEY    # 凭据引用(credentials 服务或环境变量)
      reasoning: high               # 可选,路由级默认档位(模型需支持)
      sessionMarker:                # 会话标记(请求体通道),默认开启
        enabled: true
        prefix: dsh                 # 派生标记前缀
      metadata:                     # anthropic metadata 模板(可选);user_id 键由标记占用,勿在此声明
        gateway: newapi
        session: '{sessionId}'
      compat:                       # 路由级 compat 覆盖,无 withhold;字段按协议名单校验
        sendSessionAffinityHeaders: true   # 亲和头通道(anthropic 即 x-session-affinity)
      headers:                      # 静态自定义头(粘性兜底通道)
        x-gateway-group: pool-a
      cacheRetention: short         # 可选:none / short / long(none 会抑制亲和头)
      defaultContextWindow: 262144  # 可选,模型未声明时的兜底
      retryPolicy:                  # 可选,注册捕获,进 runtime 重试
        mode: normal
        maxRetries: 2
      models:
        - id: claude-sonnet
          name: Claude Sonnet
          input: [text, image]
          maxTokens: 16384
          # 档位字典:key = 档位,value = wire 拼写;未声明档位 = 不支持;
          # off 无值 = 支持且不发参数;false = 非推理模型
          reasoningEfforts:
            off:
            low: low
            high: high
            max: ultra
          compat:
            sendSessionAffinityHeaders: true
    new-api-gpt:                    # openai 系协议示例(sessionAffinityFormat 仅在此类协议合法)
      api: openai-responses         # 或 openai-completions
      baseURL: https://newapi.example.com/v1
      apiKeyEnv: NEW_API_API_KEY
      compat:
        sessionAffinityFormat: openai   # openai / openai-nosession / openrouter,头集合见注入通道表
      models:
        - id: gpt-4o
```

路由与模型的全量可配键以本包 settings schema 为准,示例未穷举。

配置修改**即时生效**(无需重启);解析失败时保留上一份好配置。纯 host 端,无 GUI。

## 安装

```sh
dsh plugin --profile web add @mzzsfy/dsh-llm-pi-gateway
```

重启 dsh 生效。**无需任何配置改动**:官方 `llm-pi-ai:` 节原样接管(官方 schema 消费),路由名不变,sessionId 注入自动开启(请求体标记)。`llm-pi-gateway:` 节仅用于增强覆盖(同名整体优先)或独立路由。

卸载插件 = 官方原样接管回来,同一份配置继续工作。

## 已知取舍

- 事件流适配与 pi-ai 数据结构耦合;路由按显式 api 直注标记,形状判别仅为 api 缺失的兜底路径,未知形状不注入。
- 无流空闲超时看门狗(官方 0.1.2-rc.1 经 `streamIdleTimeoutMs` 300 秒兜底;实现需进程内动态 import dsh-timeout,宿主可达性待实测后补齐,当前纯披露);pi-ai 依赖下界较官方收紧(官方 0.1.2-rc.1 为 ^0.84.2,本包因 compat 名单取材 0.84.4 抬至 ^0.84.4),官方升级范围时本包需跟随。
- sessionMarker.enabled=false 不拦截 metadata 模板的静态 user_id 键透传(该键来自模板而非标记器,不含会话派生标识);模板其余键经标记 onPayload 合入,标记关闭时不上 wire。标记关闭时 openai 系的原生 `prompt_cache_key` 随之不再被覆盖,pi-ai 原生行为仍在:openai-responses 在 retention ≠ none(未配置默认 short)时携带截断裸 sessionId;openai-completions 在 baseUrl 含 api.openai.com、或 retention 为 long 且 compat 允许时同——依赖派生标记隐藏内部会话 id 的场景此时应改用其他载体做粘性键。
- `sessionId` 缺省契约:会话标记关闭且模板不引用 `{sessionId}` 的路由允许缺失(官方 wire 契约同构,缺省即省略该键);接管路由会话标记**默认开启**,sessionId 因此默认必填——sessionId 缺省承诺仅对显式关闭标记且模板不引用 `{sessionId}` 的路由兑现。
- 上游错误以文本分类(pi-ai 把捕获错误展平为 message 字符串),quota/超窗判定用官方同款判定器,其余分支与官方同序同构。
- 本包未复用 dsh-llm 类(插件依赖以副本安装,class 身份不通;错误以 own `code` / `failure` 数据属性被 harness 错误边界识别),官方公共导出仅消费纯函数与 schema 对象。
- `reasoningEfforts` → `thinkingLevelMap` 解析为平行实现(官方未导出该函数),以对表测试锚定语义。

## 开发

```sh
npm test        # node --test test/*.test.mjs,纯逻辑层;devDependencies 提供官方包对表实现
```
