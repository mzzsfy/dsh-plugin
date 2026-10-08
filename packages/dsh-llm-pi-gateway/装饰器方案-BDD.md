# gateway 装饰器方案 BDD(替代运行时接管)

状态:设计定稿,待实施。前置排查结论见仓库 `docs/progress/debug-fix-llmgateway-model-add.md`。

## 背景与动机

现有 gateway 以"接管"工作:runtime-disable 官方 `llm-pi-ai` 行,自己注册 adapter/directory/discovery,并镜像官方 settings 节。该形态在 dsh 0.2.0-rc.2 上产生结构性回归:

- 官方行被禁 → `dsh-settings` describe 只输出运行中行(dsh-settings/lib/index.js `describe`:`entry.fiber.state !== 2 → 跳过`)→ `llm-pi-ai` 设置节消失;
- 官方设置页 `dsh-client-ui-settings-models` 硬编码仅 `ns === 'llm-pi-ai'` 提供 pi-ai 富编辑面,且"添加模型提供商"按钮依赖该节存在 → **设置页模型新增整体损坏**;
- legacy 宿主(≤0.1.6)经 `installSection` 重注册官方节故无此问题(排查证据见 `docs/progress/debug-fix-llmgateway-model-add.md`);本设计不覆盖该代际。

重新对表 0.2.0-rc.2 宿主源码后确认存在不接管的注入路径:

1. `dsh-agent-loop` 每请求携带 `sessionId: session.id`(dsh-agent-loop/lib/index.js:1274),经 `options` 全程透传至 adapter;
2. `LlmAdapter.prepareCall` 返回 `{ model, stream: (options) => ... }`,该 stream 边界是官方文档化公开接口;
3. pi-ai anthropic-messages 原生消费 `options.metadata.user_id`(pi-ai dist/api/anthropic-messages.js:906),官方 adapter 只是未传 metadata;
4. openai 系(pi-ai completions/responses)原生按条件从 `options.sessionId` 派生 `prompt_cache_key` 与 session affinity 头,无需注入。

结论:gateway 的核心价值(anthropic 会话标记注入)可以在**不占用任何注册位**的前提下,以 adapter 装饰器实现;接管形态整体退役。

## 目标

- 官方 `llm-pi-ai` 行保持启用,设置页模型新增/编辑/发现全部原生可用;
- anthropic 协议路由的请求体携带 `metadata.user_id = deriveMarker(options.sessionId)`;
- marker 前缀与总开关可配置(pi-ai anthropic 仅透传 metadata.user_id,无模板配置面);
- 宿主能力缺失时干净禁用,不阻塞 boot,不产生任何注册冲突。

## 非目标

- 不再镜像/接管官方 settings 节、directory、discovery;
- 不再提供 openai 系路由的 compat 全控、手写路由服务、模型发现代理(openai 系追踪走原生:`cacheRetention: long` + `compat.supportsLongCacheRetention: true`,由用户配置或 model-capability-editor 承载);
- 不为旧宿主(无 `options.sessionId` 透传或无 `options.metadata` 消费)维护双路径。

## 架构

```
官方 llm-pi-ai 行(启用,自服务)
        │ apply 前
        ▼
gateway(ctx.on('loader/patch-context', global waterfall,现有 revival-guard 同款时序))
  1. 包装 ctx.llm.registerAdapter(实例方法 shadow)
  2. 官方注册 adapter 时:包装 adapter 实例的 prepareCall
     → 返回 { model: 原样, stream: 注入后的 stream }
  3. 注入后的 stream(options):
     - 该 provider 路由协议为 anthropic(读官方 entry 配置判定)→
       以不可变构造递交给原 stream:
       originalStream({ ...options, metadata: { ...options.metadata, user_id: deriveMarker(options.sessionId) } })
       (options 沿途被 deepFreeze,禁止原地赋值)
     - 其余协议原样透传
        ▼
官方 adapter 照常服务全部路由(设置页、模型发现、对话全原生)
gateway 自身 Config 节:仅 marker 配置(前缀 / 总开关)
```

### 关键机制与源码依据

| 机制 | 依据 |
|------|------|
| 时序:注册先后无关 | 装饰缝为官方 adapter 类原型方法 shadow + sweep,不依赖注册先后:gateway apply 落定后对注册表存量 adapter sweep 补包,`llm/adapters-updated` 事件兜底新注册 |
| 注册拦截 | 不拦截 registerAdapter(ctx.llm 为只读服务代理,实测不可 shadow);对 PiAiAdapter 类原型 `streamWithSnapshot` 一次性 shadow,全部存量与未来实例天然覆盖。`handle.replace(next)` 只换路由数组,注入连续 |
| 注入点 | 官方 `streamWithSnapshot` 白名单构造 pi-ai GenerateOptions,dsh 层 metadata 到不了 pi-ai(实测);注入落在 wrapper 内对入参 `snapshot.models` 的 streamSimple 实例级 shadow:anthropic 协议 GenerateOptions 以不可变构造补 `metadata.user_id`,GenerateOptions.sessionId(官方显式传入)为标记派生源 |
| sessionId 在场 | agent-loop 组装请求恒带 `sessionId`(dsh-agent-loop/lib/index.js:1274) |
| anthropic 消费 metadata | pi-ai `options.metadata.user_id → params.metadata`(anthropic-messages.js:906-909,其余 metadata 键被丢弃) |
| openai 无害性 | pi-ai openai 协议仅读取已知键构造请求体,未知 `metadata` 键被忽略 |
| 协议判定 | 官方 entry 配置 `providers.<name>.api`(读 entry options/fiber config;官方行运行中,配置即最新值) |

### marker 派生(沿用现有实现)

`deriveMarker(sessionId, prefix) = '<prefix>:<sha256 前 40 位 hex>'`,实现直接复用 `src/marker.mjs`,零语义变更。

### 配置节(本包唯一保留面)

```yaml
# cordis.patch.yml → llm-pi-gateway 行 config
sessionMarker:
  enabled: true        # 总开关,false 时插件纯旁路(仍包装但透传)
  prefix: dsh          # 派生前缀
```

说明:pi-ai anthropic 传输层仅透传 `metadata.user_id`(anthropic-messages.js:906-909,其余 metadata 键被丢弃),故不提供 metadata 模板配置——配置了也不会有线上效果,违背最简实现原则。template.mjs 的占位符渲染随模板能力一并退役。

schema 静态 `Config` 导出自动生成设置页,`.volatile()` 特性检测包装,双代际宿主自适应(沿用现有 index.js 形态)。

## BDD 规格

### 场景:官方行启用时的装饰链路

- **Given** 官方 llm-pi-ai 行启用且 apply 成功,gateway 行启用
- **When** 宿主 boot,官方 adapter 经 registerAdapter 注册
- **Then** 官方行 fiber state 正常,设置页存在 `llm-pi-ai` 节且"添加模型提供商"可用
- **And** gateway 未注册任何 adapter/directory/discovery,diagnostics 无注册冲突

### 场景:anthropic 路由标记注入

- **Given** 官方节某 provider `api: anthropic-messages`,gateway sessionMarker.enabled = true
- **When** 会话 id 为 S 的请求经该路由发出
- **Then** 请求体 `metadata.user_id === deriveMarker(S, prefix)`
- **And** 注入以不可变构造完成(originalStream({...options, metadata: {...}})),冻结对象不被原地改写

### 场景:openai 路由透传

- **Given** 官方节某 provider `api: openai-completions`
- **When** 请求经该路由发出
- **Then** 请求体不含 gateway 注入的 metadata 键
- **And** 官方原生 prompt_cache_key/session affinity 行为与无 gateway 时完全一致

### 场景:官方热替换路由(handle.replace)

- **Given** 包装生效,官方已持有一个注册
- **When** 官方经 `handle.replace(next)` 热替换路由数组(设置节变更触发的路由重建)
- **Then** 注册表中 adapter 仍是已包装实例,注入不中断(replace 语义为换路由,adapter 实例不变)

### 场景:gateway 行晚于官方行 apply(行序漂移)

- **Given** 组合行序漂移,官方行先于 gateway 行完成注册(base 树官方行 + bundle 层 gateway 的真实部署形态)
- **When** gateway apply 落定,检测到 `ctx.llm` 已存在官方注册
- **Then** 对注册表存量 adapter 实例补做 prepareCall 实例级 shadow(sweep 兜底),注入不缺位
- **And** warn 归因日志,不出现静默失效

### 场景:sessionId 缺失(未声明宿主的版本漂移防御)

- **Given** 装饰链路已生效,但某请求 options.sessionId 缺失(宿主版本漂移,属防御路径;0.1.x 已由 dsh.hostMin 前置拒绝装载,常态不可达)
- **When** 该请求经过注入层
- **Then** 按不注入透传,并 warn 一次(按 provider 去重),不抛错

### 场景:官方行重启/配置热更(HMR 重注册)

- **Given** 包装已就位,官方行因配置变更 dispose 后重新 apply
- **When** 官方再次调用 registerAdapter
- **Then** 新 adapter 实例同样被包装(包装位于服务实例方法,跨越官方行生命周期存续)
- **And** 不产生双重注入(包装幂等:同一 adapter 实例仅包装一次,以 WeakSet 判重)

### 场景:gateway 停用/卸载

- **Given** 包装生效中
- **When** gateway 行被禁用或卸载
- **Then** dispose 恢复原 registerAdapter 引用,后续官方重注册不再被包装
- **And** 在途流按原 stream 收尾,不中断

### 场景:官方行被用户显式禁用

- **Given** 用户在配置文件显式禁用官方 llm-pi-ai 行
- **When** boot,官方行不启动、不调用 registerAdapter
- **Then** gateway 包装已就位但无注册可包装,零行为差异,无需探测官方行禁用态
- **And** 官方行重新启用时,loader 重启官方行,其 registerAdapter 调用经 shadow 方法命中包装,自动恢复注入,gateway 无需参与

### 场景:协议判定数据缺失

- **Given** 官方 entry 配置不可读(形态异常/版本漂移)
- **When** stream 包装需要判定 provider 协议
- **Then** 按不注入透传(安全向),并 warn 一次(按 provider 去重)

### 场景:sessionMarker.enabled = false

- **Given** 总开关关闭
- **When** 任意请求经过包装层
- **Then** options 原样透传,行为与未安装 gateway 等价

## 兼容性窗口

| 宿主 | 判定 | 行为 |
|------|------|------|
| 0.2.0-rc.2(主测) | 全能力 | 装饰器注入 + 原生 prompt_cache_key 共存 |
| 更早 0.1.x(基线) | sessionId/metadata 面缺失 | dev-link 装载拒绝(dsh.hostMin 0.2.0-rc.1),不进入运行期 |

CI compat 双槽口径不变;L3 对表项收敛为:装饰链路、anthropic 注入体、设置页完好性三项。

## 风险与对策

| 风险 | 对策 |
|------|------|
| 实例方法 shadow 非文档化扩展点,宿主可能改为不可变服务面 | 特性检测:apply 时验证 `ctx.llm.registerAdapter` 可写且 `ctx.llm` 跨行同源;不可即干净禁用 |
| 官方未来在 registerAdapter 内做实例登记/校验导致包装对象被拒 | 包装保持原原型链(Object.create 原实例),仅覆写 prepareCall;compat 测试锁行为 |
| pi-ai 未来改 metadata 消费形态 | compat 测试按 pi-ai dist 源断言 user_id 路径;失效即注入无害化(多余键) |
| 双重包装(官方 HMR 重建服务实例) | 以 WeakSet 持已包装 adapter;服务实例重建则包装随之重建,天然不叠加 |
| 卸载时在途流 | dispose 不中断已返回的 iterator,仅恢复方法引用(与现 guard-rail 语义一致) |

## 退役清单(实施时删除)

`src/` 逐文件处置:

| 文件 | 处置 |
|------|------|
| index.js | 重写:装饰器宿主(apply 探测 + patch-context 时序 + registerAdapter 包装 + 极小 Config 节);删除 runtimeDisableOfficial 调用点及对 takeover.mjs 的引用 |
| marker.mjs | 仅保留 deriveMarker 与 DEFAULT_MARKER_PREFIX;isAnthropicPayload / isOpenAIPayload / injectSessionMarker / markerOnPayload 等接管形态注入 helper 随删 |
| template.mjs | 删除(metadata 模板能力随 pi-ai 仅透传 user_id 的传输现实一并退役,见配置节说明) |
| errors.mjs | 仅保留 GatewayError(供配置校验);takeoverFailureText 随删 |
| client.js | 保留(settings-nav-icons 图标声明,与形态无关) |
| guard-rail.mjs | 仅保留 withTimeout / MODULE_LOAD_TIMEOUT_MS(宿主能力探测用);DISPOSE_TIMEOUT_MS / MOUNT_TIMEOUT_MS / isGuardRailTimeout 随删,不留死导出 |
| image-offload.mjs | 删除(图片卸载属接管形态 adapter 的能力,装饰器形态由官方 adapter 原生承载) |
| config.mjs | 缩减:仅留 SETTINGS_NS、deriveMarker 相关常量与协议判定辅助;路由解析(resolveRoutes/resolveRoute/resolveModels/compat 名单校验等)删除 |
| adapter.mjs | 删除 |
| apply-state.mjs | 删除 |
| credentials.mjs | 删除 |
| discovery.mjs | 删除 |
| guard.js | 删除(compat 键剥离属接管形态的官方节消费逻辑) |
| headers.mjs | 删除 |
| manager.mjs | 删除 |
| orphan.mjs | 删除 |
| pi-context.mjs | 删除 |
| pi-stream.mjs | 删除 |
| takeover.mjs | 删除 |

`cordis.patch.yml`:

- 删除 `llm-pi-gateway/guard` 哨兵行(第 52-53 行起,dead-state self-heal 代挂官方插件;与新方案"gateway 不代挂、官方行自服务"直接冲突)
- 注:官方行在本 patch 中本就未静态禁用("NOT disabled here" 注释),无需改动该面

测试文件随对应实现同步缩减;`兼容性测试.md`、`运行时接管-BDD.md`、`对表指南.md` 归档为历史文档(移动至 docs/ 或标注 Superseded——对表指南的镜像包前提随镜像退役失效)。

`package.json`:`dsh.hostMin` 由 `0.1.7-rc.1` 提升至 `0.2.0-rc.1`(该键由仓库 `scripts/dev-link.mjs` 的 meetsHostMin 在 dev-link 装载侧消费,dsh 本体运行时不读——0.1.x 宿主的拒绝发生在装载前,非运行期禁用)。

## 验证计划

1. PoC(隔离环境,boot-keep 0.2.0-rc.2):验证包装时序、注入体、设置页完好;先于包结构改动
2. 单测:marker 复用现有;新增包装层用例(幂等、透传、协议判定、干净禁用、冻结 options 不可变构造)
3. L3 对表:双协议真实对话抓包(anthropic body 带 user_id;openai 与原生一致)
4. 设置页回归:添加模型提供商 → 添加模型 → 保存 → 模型选择器可见(本轮损坏现象的复现用例转 pass)
5. 回归套件:`node scripts/smoke-load.mjs` + 包级 `node --test` + dev-link win 测试
