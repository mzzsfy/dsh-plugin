// llm-pi-gateway Host 半区:注册 settings 命名空间 llm-pi-gateway,按其路由表
// 经 ctx.llm 注册网关 adapter。配置经 settings onChange 热更新,解析失败保旧。

import z from '@deepseek-ai/schemastery'
import { RetryPolicySchema } from '@deepseek-ai/dsh-llm'
import { resolveRoutes, OFFICIAL_SETTINGS_NS, SETTINGS_NS, THINKING_LEVELS } from './config.mjs'
import { createGatewayAdapter } from './adapter.mjs'
import { createCredentialResolver } from './credentials.mjs'
import { createRouteManager } from './manager.mjs'
import { discoverModels } from './discovery.mjs'
import { takeoverFailureText } from './errors.mjs'
import {
  officialEntryState,
  takeoverDecision,
  awaitOfficialExit,
  installOfficialRevivalGuard,
  armDeferredTakeover,
} from './takeover.mjs'
import { beginGatewayApply, endGatewayApplyActive, endGatewayApplyInactive } from './apply-state.mjs'

export const name = 'llm-pi-gateway'

const NS = SETTINGS_NS
const OFFICIAL_NS = OFFICIAL_SETTINGS_NS

// 宿主必备导出:均为 dsh 0.1.2 引入,激活时逐项探测,缺失即禁用
const HOST_REQUIRED_EXPORTS = ['resolveImageAttachmentAccess', 'offloadedImageText']

export const inject = ['llm', 'settings']

const reasoningEfforts = z.dict(z.union([z.string(), z.const(null)]), z.union(THINKING_LEVELS))

const modelEntry = z.object({
  id: z.string().required(),
  name: z.string(),
  contextWindow: z.number(),
  maxTokens: z.number(),
  input: z.array(z.union(['text', 'image'])),
  reasoningEfforts: z.union([z.const(false), reasoningEfforts]),
  compat: z.dict(z.any()),
})

const providerEntry = z.object({
  api: z.union(['anthropic-messages', 'openai-completions', 'openai-responses']),
  baseURL: z.string(),
  apiKeyEnv: z.string().role('credential-ref'),
  displayName: z.string(),
  reasoning: z.union(THINKING_LEVELS),
  thinkingBudgets: z.dict(z.any()),
  transport: z.union(['sse', 'websocket', 'websocket-cached', 'auto']),
  timeoutMs: z.natural(),
  websocketConnectTimeoutMs: z.natural(),
  cacheRetention: z.union(['none', 'short', 'long']),
  defaultContextWindow: z.number(),
  defaultMaxTokens: z.number(),
  defaultInput: z.array(z.union(['text', 'image'])),
  maxRequestImageBytes: z.number(),
  requestImagePixelBudget: z.number(),
  requestImageMaxBytes: z.number(),
  retryPolicy: RetryPolicySchema,
  sessionMarker: z.object({
    enabled: z.boolean().default(true),
    prefix: z.string(),
  }),
  metadata: z.dict(z.any()),
  compat: z.dict(z.any()),
  headers: z.dict(z.string()),
  models: z.array(modelEntry),
})

export const Config = z.object({
  providers: z.dict(providerEntry).default({}),
})

/** 探测宿主 dsh-llm 缺失的必备导出,齐全返回空表。 */
export function missingHostExports(dshLlm) {
  return HOST_REQUIRED_EXPORTS.filter((name) => dshLlm[name] === undefined)
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} config 本节初始配置
 * @param {() => Promise<object>} [importOfficial] 官方包加载器,测试注入桩;
 *   默认动态 import(官方包缺失时仅降级本节接管,不拖垮本包加载——
 *   静态 import 命名导出缺失即加载崩溃,违反干净禁用规约)
 * @param {{exitPoll?: object, deferredExit?: object}} [pollOptions] 轮询参数,
 *   仅测试注入:exitPoll 透传快速退场窗(awaitOfficialExit),deferredExit
 *   透传延迟补接管轮询(armDeferredTakeover);生产双双缺省
 */
export async function apply(ctx, config, importOfficial = () => import('@deepseek-ai/dsh-llm-pi-ai'), { exitPoll = {}, deferredExit = {} } = {}) {
  // 生命周期旗标:guard 据此识别本行的功能性停摆(早退 = 假活,详见
  // apply-state.mjs);中途崩溃旗标停留 undefined,guard 保守不代挂
  beginGatewayApply()
  // 宿主兼容探测,两项独立:
  // 1) settings 服务面:installSection 为 0.1.2-alpha.2+ 引入(与 peerDependencies
  //    对齐);旧宿主缺失即禁用。此探测直接读运行宿主注入的服务对象,不受插件
  //    解析链影响——import 解析链会命中 dev 工作副本仓库根的宿主包副本,与运行
  //    宿主版本脱钩,不能作为旧宿主判据(rc.2 实测教训)。
  // 2) dsh-llm 导出:HOST_REQUIRED_EXPORTS 为 dsh 0.1.2 引入,动态探测防静态
  //    import 命名导出缺失即加载崩溃;旧本体缺失时同样禁用,boot 保持干净。
  if (typeof ctx.settings?.installSection !== 'function') {
    ctx.logger.warn('llm-pi-gateway: 宿主 settings 服务缺少 installSection(需要 dsh 本体 0.1.2+),插件禁用')
    endGatewayApplyInactive()
    return undefined
  }
  const dshLlm = await import('@deepseek-ai/dsh-llm')
  const missing = missingHostExports(dshLlm)
  if (missing.length > 0) {
    ctx.logger.warn(`llm-pi-gateway: 宿主缺少 ${missing.join(', ')}(需要 dsh 本体 0.1.2+),插件禁用`)
    endGatewayApplyInactive()
    return undefined
  }
  // 官方 Config 同样动态获取:官方包缺失(patch 未生效但包被移除/版本演进)时
  // 打日志并跳过官方节接管,本包节照常服务;Promise.resolve().then 消化注入加载器的同步抛错
  const OfficialConfig = await Promise.resolve().then(importOfficial).catch(() => undefined).then((mod) => mod?.Config)
  if (OfficialConfig === undefined) {
    ctx.logger.warn('llm-pi-gateway: 官方 dsh-llm-pi-ai 不可用,降级为只服务 llm-pi-gateway 节')
  }
  // 官方 entry 生命周期决策:接管(官方行停稳/缺席)/等待退场/让位(用户层
  // 启用官方)。宿主注册排他,官方在场时本包不得占用其任何注册;让位态不碰
  // 官方 settings 节与官方 ns discovery,官方插件自行服务。servingOfficial
  // 供复活守卫判定:仅正服务官方节时,官方行复活才需要自停让位。
  let servingOfficial = false
  const officialState = officialEntryState(ctx.loader)
  const decision = takeoverDecision(officialState)
  let takeover
  // 退场超时标记:arm 延迟到全部装配落定后执行,装配中途失败不留僵尸轮询
  let exitTimedOut = false
  if (decision === 'yield') {
    ctx.logger.warn('llm-pi-gateway: 官方 llm-pi-ai 行未被禁用(用户层启用),本包降级为只服务 llm-pi-gateway 节')
    takeover = false
  } else if (decision === 'await-exit') {
    ctx.logger.warn('llm-pi-gateway: 官方 llm-pi-ai 插件退场中,等待其完全卸载后接管')
    takeover = await awaitOfficialExit(officialState.entry, exitPoll)
    if (!takeover) {
      // 退场受在途流拖长属常态(用户边用边装),快速窗耗尽只是接管推迟:
      // 先服务本包节,官方退场后补完成接管,服务与标记注入最终一致
      ctx.logger.warn('llm-pi-gateway: 官方 llm-pi-ai 退场超时(存在在途流),先服务本包节,官方退场后自动完成接管')
      exitTimedOut = true
    }
  } else {
    takeover = true
  }
  if (takeover) installOfficialRevivalGuard(ctx, () => servingOfficial)
  // 两节来源:官方节(官方 schema 消费,零感知接管)+ 本包节(独立/增强)。
  // 合并路由表按原始快照恒等记忆;任一节解析即抛,记忆保持旧值,
  // 调用方捕获后沿用上一份好配置(官方同款)。
  let readOfficial = () => undefined
  let readGateway = () => config
  let lastSnapshot
  let memoized
  // 官方节 catalog 形态路由 skip 上报:按 provider 去重,防 onChange 重放刷屏
  const unserviceableReported = new Set()
  const onUnserviceable = (provider, reason) => {
    if (unserviceableReported.has(provider)) return
    unserviceableReported.add(provider)
    ctx.logger.warn(`llm-pi-gateway: ${reason}`)
  }
  const snapshot = () => [readOfficial(), readGateway()]
  const profiles = () => {
    const current = snapshot()
    if (lastSnapshot !== undefined
      && current[0] === lastSnapshot[0] && current[1] === lastSnapshot[1]) return memoized
    // 去重按配置代失效:真解析(重跑)才重报,记忆命中不重放;修复后再次劣化能再次告警
    unserviceableReported.clear()
    const next = resolveRoutes(current[0]?.providers, current[1]?.providers, onUnserviceable)
    lastSnapshot = current
    memoized = next
    return next
  }
  // 凭据解析器无状态,单例闭包复用(adapter 注册与模型发现共用)
  const resolveCredential = createCredentialResolver(ctx)
  const adapter = createGatewayAdapter(profiles, undefined, resolveCredential, () => ctx.get('attachments'), (reason) => {
    ctx.logger.warn('llm-pi-gateway: replay 降级为 provider 中性历史: ' + reason)
  }, (attachments, ref) => dshLlm.resolveImageAttachmentAccess(attachments, (hostPath) => ctx.get('fs')?.processPathFromHostPath(hostPath), ref), dshLlm.offloadedImageText)
  const manager = createRouteManager({
    routes: profiles,
    adapter,
    registerAdapter: (providers, registered) => ctx.llm.registerAdapter(providers, registered),
    registerDirectory: (entries) => ctx.llm.registerConfigurableProviders(entries),
  })
  // 模型发现:两节命名空间各注册同一回调(官方节被本包接管后,官方 ns 的
  // discovery 注册随官方插件消失,不补注册则官方节配置面拉取模型必 NO_DISCOVERY);
  // 宿主契约第二参为取消 signal,透传给探测 fetch;探测请求合入路由自定义头。
  // 官方 ns 注册可能撞已在场的官方插件(同 ns 重复注册宿主硬抛),冲突即降级跳过,
  // 与 settings 接管的降级路径对称——patch 失效共存场景双方都能活着
  const discoverFor = (request, signal) => {
    const route = profiles().get(request.provider)
    return discoverModels(
      { ...request, ...(signal === undefined ? {} : { signal }), headers: route?.headers },
      () => resolveCredential(request.provider, route?.apiKeyEnv),
    )
  }
  ctx.llm.registerModelDiscovery(NS, discoverFor)
  // 官方 ns 补注册仅在接管态:让位态官方插件在场,会自行注册该 ns,本包
  // 抢注册必令官方 init 撞 DUPLICATE_DISCOVERY 而拖垮整批 patch 应用。
  // 注册成功即置 servingOfficial:持有任一官方注册就需要复活守卫,官方
  // 复活撞本包在场 discovery 与撞 settings 节的后果相同。
  // 同步接管与延迟补接管共用同一装配,延迟路径在退场后的轮询序列上调用
  const registerOfficialDiscovery = () => {
    try {
      ctx.llm.registerModelDiscovery(OFFICIAL_NS, discoverFor)
      servingOfficial = true
    } catch (error) {
      ctx.logger.warn('llm-pi-gateway: 官方 discovery 注册冲突(官方 llm-pi-ai 插件仍在),由官方继续服务模型发现')
      ctx.logger.warn(error)
    }
  }
  if (takeover) registerOfficialDiscovery()
  const onSectionChange = () => {
    try {
      manager.ensureRegistration()
    } catch (error) {
      ctx.logger.error('llm-pi-gateway: 拒绝的更新后保留先前注册的路由')
      ctx.logger.error(error)
    }
    try {
      manager.ensureDirectory()
    } catch (error) {
      ctx.logger.error('llm-pi-gateway: 拒绝的更新后保留先前的可配置目录')
      ctx.logger.error(error)
    }
  }
  // 官方节接管(仅接管态):官方插件被本包 patch 禁用后,其 settings 节由
  // 本包以官方 schema 注册。若注册冲突(patch 失效、官方仍在),降级为只
  // 服务本包节。validate 拒绝组合后不可解析的官方节,防坏配置穿透 profiles
  // 快照记忆。官方包缺失时跳过接管(动态获取已告警)。servingOfficial 已在
  // 官方 discovery 注册处置位,此处不再改写。
  // 同步接管与延迟补接管共用同一装配
  const installOfficialSection = () => {
    if (OfficialConfig === undefined) return
    try {
      ctx.settings.installSection(ctx, OFFICIAL_NS, OfficialConfig, undefined, {
        validate: (section) => resolveRoutes(section.providers, readGateway()?.providers, onUnserviceable),
        setSource: (source) => {
          readOfficial = source
        },
        onChange: () => onSectionChange(),
      })
    } catch (error) {
      ctx.logger.error(takeoverFailureText(error))
      ctx.logger.error(error)
    }
  }
  // 延迟补接管装配:与同步接管同一套动作、同一顺序(守卫→discovery→节→
  // 路由重算),在官方行退场后的轮询序列上执行
  const completeOfficialTakeover = () => {
    installOfficialRevivalGuard(ctx, () => servingOfficial)
    registerOfficialDiscovery()
    installOfficialSection()
    onSectionChange()
  }
  if (takeover) installOfficialSection()
  ctx.settings.installSection(ctx, NS, Config, config, {
    validate: (section) => resolveRoutes(readOfficial()?.providers, section.providers, onUnserviceable),
    setSource: (source) => {
      readGateway = source
    },
    onChange: () => onSectionChange(),
  })
  // 启动 fail loud:组合后不可服务的配置在加载期失败(与官方一致)
  profiles()
  onSectionChange()
  endGatewayApplyActive()
  // 延迟补接管:全部装配落定后才武装;轮询在 apply 返回后的轮询序列上执行,
  // completeOfficialTakeover 闭包至此全部就绪,装配中途失败不会留下僵尸轮询
  if (exitTimedOut) armDeferredTakeover(ctx, officialState.entry, () => completeOfficialTakeover(), deferredExit)
}
