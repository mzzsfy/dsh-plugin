// 用量统计面板 Host 半区:采集 session/event 落 usage_stats 域,经 webServer
// 暴露 /api/usage-dash/* 供浏览器半区消费。S2 落存储域与 settings 注册,
// S3 接入采集与启动回扫,S13 扩展 pricing 形状并接线定价能力。

import schemastery from '@deepseek-ai/schemastery'

import { BUDGET_ACTIONS, DEFAULT_WARN_RATIO, normalizeBudgetConfig } from './budget.js'
import { UsageCollector } from './collector.js'
import {
  CYCLE_DEFAULT,
  CYCLE_KINDS,
  CYCLE_MAX_DAYS,
  CYCLE_MAX_START_DAY,
  CYCLE_MIN_DAYS,
  CYCLE_MIN_START_DAY,
  normalizeCycleConfig,
} from './cycle.js'
import { normalizeFeatures, featureOn } from './features.js'
import { installGuard } from './guard.js'
import { normalizePricingRules } from './pricing.js'
import { sharedPricingStore } from './pricing-store.js'
import { DEFAULT_SENTINEL_CONFIG, installSentinel, normalizeSentinelConfig } from './sentinel.js'
import { modelUsageProjectionDefinition } from './session-models.js'
import { recentRequestsProjectionDefinition } from './recent-requests.js'
import { recentSpeedProjectionDefinition } from './recent-speed.js'
import { HOST_TIME_ZONE, registerUsageRoutes } from './routes.js'
import { DEFAULT_MINUTE_RETENTION_DAYS, MINUTE_RETENTION_MAX_DAYS, sharedStore } from './store.js'
import { readSpent } from './summary.js'
// 顶层 inject 仅声明 web profile 必然存在的四个服务;settings 在 apply 内
// 嵌套 inject(通道级静默不激活),构成干净禁用。
export const inject = ['webServer', 'sessionPersistence', 'sessions', 'storageDomain']

export const name = 'dsh-usage-dash'

const SETTINGS_NAMESPACE = 'usage-dash'

const BUDGET_SCOPE_SCHEMA = schemastery.object({
  limit: schemastery.number().min(0).default(0),
  action: schemastery.union(BUDGET_ACTIONS.map((action) => schemastery.const(action))).default(BUDGET_ACTIONS[0]),
})

const BUDGET_SCHEMA = schemastery.object({
  warnRatio: schemastery.number().min(0).step(0.01).default(DEFAULT_WARN_RATIO),
  daily: BUDGET_SCOPE_SCHEMA,
  monthly: BUDGET_SCOPE_SCHEMA,
  degradeModel: schemastery.string().default(''),
  notify: schemastery.boolean().default(true),
})

const SENTINEL_SCHEMA = schemastery.object({
  burnMultiplier: schemastery.number().min(1).default(DEFAULT_SENTINEL_CONFIG.burnMultiplier),
  cacheDropPoints: schemastery.number().min(1).default(DEFAULT_SENTINEL_CONFIG.cacheDropPoints),
  quietBurnMinutes: schemastery.number().min(1).default(DEFAULT_SENTINEL_CONFIG.quietBurnMinutes),
})

// 计费周期:套餐口径由用户填,自然月只是其中一种
const CYCLE_SCHEMA = schemastery.object({
  kind: schemastery.union(CYCLE_KINDS.map((kind) => schemastery.const(kind))).default(CYCLE_DEFAULT.kind)
    .description('calendar=自然月,monthly=每月固定账单日,rolling=滚动天数'),
  startDay: schemastery.number().min(CYCLE_MIN_START_DAY).max(CYCLE_MAX_START_DAY).step(1)
    .default(CYCLE_DEFAULT.startDay).description('账单日(仅 monthly 生效),超出当月天数时落到月末'),
  days: schemastery.number().min(CYCLE_MIN_DAYS).max(CYCLE_MAX_DAYS).step(1)
    .default(CYCLE_DEFAULT.days).description('周期天数(仅 rolling 生效)'),
})

// 底栏 stats-line 偏好:客户端经 configForms 读写本命名空间,宿主为唯一持久化来源;
// 出厂默认值与 client STATS_LINE_DEFAULT_PREFS 逐项同源,settings-inject 测试对拍守护
const STATS_LINE_DEFAULTS = {
  cachePrecision: true,
  tokenDetail: true,
  costDisplay: true,
  recentSpeed: true,
  replaceSpeed: false,
  requestDetails: false,
}

const STATS_LINE_SCHEMA = schemastery.object({
  cachePrecision: schemastery.boolean().default(STATS_LINE_DEFAULTS.cachePrecision),
  tokenDetail: schemastery.boolean().default(STATS_LINE_DEFAULTS.tokenDetail),
  costDisplay: schemastery.boolean().default(STATS_LINE_DEFAULTS.costDisplay),
  recentSpeed: schemastery.boolean().default(STATS_LINE_DEFAULTS.recentSpeed),
  replaceSpeed: schemastery.boolean().default(STATS_LINE_DEFAULTS.replaceSpeed),
  requestDetails: schemastery.boolean().default(STATS_LINE_DEFAULTS.requestDetails),
}).default(STATS_LINE_DEFAULTS)

// 定价规则表不进配置槽位:逐条规则的嵌套结构会把 profile 配置节撑成长表,
// 持久化改由 pricing-store 的 usage_pricing 域承担,配置节只留零碎设置
const SETTINGS_SCHEMA = schemastery.object({
  minuteRetentionDays: schemastery.number().min(0).step(1).default(DEFAULT_MINUTE_RETENTION_DAYS)
    .description(`分钟桶保留天数(上限 ${MINUTE_RETENTION_MAX_DAYS} 天),0 表示禁用分钟桶`),
  statsLine: STATS_LINE_SCHEMA.description('底部信息栏增强开关'),
  budget: BUDGET_SCHEMA.description('成本护栏预算:日 / 周期限额与超限动作'),
  cycle: CYCLE_SCHEMA.description('计费周期:决定「本周期已花」的统计窗口'),
  sentinel: SENTINEL_SCHEMA.description('异常哨兵阈值'),
  features: schemastery.object({
    whatif: schemastery.boolean().default(false).description('省钱沙盘:只读费用模拟'),
    guard: schemastery.boolean().default(false).description('成本护栏:请求前按预算放行 / 降级 / 拦截'),
    sentinel: schemastery.boolean().default(false).description('异常哨兵:按基线检测费用异常'),
    dock: schemastery.boolean().default(false).description('输入区常驻成本读数'),
  }).description('成本控制四模块开关,默认全关'),
})

// 0.1.7 宿主以静态 Config 导出生成设置节表单(maintain 同构);legacy 宿主经
// settings.register 注册命名空间。根级 volatile 包装:整节 live 表单,节写经
// loader 原地热更;旧宿主 schemastery 无 volatile 方法,特性检测原样返回
export const Config = volatileWrap(SETTINGS_SCHEMA)

function volatileWrap(schema) {
  return typeof schema.volatile === 'function' ? schema.volatile() : schema
}

// volatile ref 动态解包(get 协议):0.1.7 下 apply 入参 config 为整节单 ref;
// legacy 宿主 config 为普通对象原样透传
function unwrapVolatile(value) {
  return typeof value?.get === 'function' ? value.get() : value
}

// 存量 profile 配置节里的定价规则一次性迁入 usage_pricing 域,随后从补丁删键。
// 先写域再删键:域写失败保留 profile 原文下次重试;删键失败时域已有记录,
// 下轮跳过导入只重试删键,不会用旧配置覆盖用户后来在新编辑器里改的价格
async function migrateProfilePricing({ ctx, editor, entry, pricingStore }) {
  const rules = normalizePricingRules(entry?.options?.config?.pricing?.rules)
  if (rules.length > 0) await pricingStore.importLegacy(rules)
  if (!editor || typeof editor.edit !== 'function') {
    ctx.logger?.warn('usage-dash: configEditor 缺席,profile 旧定价节未清理')
    return false
  }
  await editor.edit(entry, (current) => {
    const next = { ...current }
    delete next.pricing
    return next
  })
  return true
}

export function apply(ctx, config) {
  const store = sharedStore(ctx.storageDomain)
  const collector = new UsageCollector(ctx, store)
  // 定价能力门面:规则表落 usage_pricing 域,读同步取域内快照,写串行自增
  // revision;域打开失败即降级(routes 侧 GET 空值、POST 拒 503)
  const pricingStore = sharedPricingStore(ctx.storageDomain)
  const pricing = {
    // 派生自域状态:ready 之前与降级态均为 false,不依赖微任务注册顺序
    get active() {
      return pricingStore.opened
    },
    ready: () => pricingStore.readyPromise(),
    rules: () => pricingStore.rules(),
    revision: () => pricingStore.revision(),
    replace: async (rules) => pricingStore.replace(normalizePricingRules(rules)),
  }
  void pricingStore.readyPromise().then(() => {
    if (pricingStore.degradation === undefined) return
    const detail = pricingStore.degradation instanceof Error
      ? pricingStore.degradation.message
      : String(pricingStore.degradation)
    ctx.logger?.warn(`usage-dash: 定价规则存储不可用 ${detail}`)
  })
  // 存量 profile 配置节里的定价规则一次性迁移:只依赖条目原文与 profile 编辑能力,
  // 与 settings 注入解耦(settings 缺席时价格不能凭空失效)
  if (Object.hasOwn(ctx.fiber?.entry?.options?.config ?? {}, 'pricing')) {
    void migrateProfilePricing({
      ctx,
      editor: ctx.get('configEditor'),
      entry: ctx.fiber?.entry,
      pricingStore,
    }).catch((error) => {
      ctx.logger?.warn(`usage-dash: 定价规则迁移失败 ${error instanceof Error ? error.message : String(error)}`)
    })
  }
  // 预算能力门面:与 pricing 同形态,settings 激活前 active=false(路由拒写、只读空值)
  const budget = {
    active: false,
    config: () => normalizeBudgetConfig({}),
    replace: async () => {
      throw new Error('usage-dash: budget settings inactive')
    },
  }
  // 四模块开关门面:settings 激活前全关(保守),激活后实时读
  const features = {
    active: false,
    current: () => normalizeFeatures({}),
    replace: async () => {
      throw new Error('usage-dash: features settings inactive')
    },
  }
  // 哨兵阈值门面:开关不在此,由 features.sentinel 在消费侧投影
  const sentinelSettings = {
    config: () => normalizeSentinelConfig({}),
  }
  // 计费周期门面:settings 激活前按自然月(与零配置行为一致)
  const cycle = {
    active: false,
    config: () => ({ ...CYCLE_DEFAULT }),
    replace: async () => {
      throw new Error('usage-dash: cycle settings inactive')
    },
  }
  // 底栏模型归属与最近输出速度都依赖投影;服务缺席(旧宿主)时嵌套 inject 静默不激活,
  // 客户端回退到「无 routes 占位符」与「窗口节点估算」,不阻断插件其余能力。
  ctx.inject(['sessionProjections'], (projectionCtx) => {
    const projections = projectionCtx.sessionProjections
    if (!projections) return
    for (const [label, definition] of [
      ['用量模型投影', modelUsageProjectionDefinition],
      ['最近速度投影', recentSpeedProjectionDefinition],
      ['最近请求投影', recentRequestsProjectionDefinition],
    ]) {
      try {
        void projections.register(definition).catch((error) => {
          ctx.logger?.warn(`usage-dash: ${label}注册失败 ${error instanceof Error ? error.message : String(error)}`)
        })
      } catch (error) {
        ctx.logger?.warn(`usage-dash: ${label}注册失败 ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  })
  ctx.inject(['settings'], (settingsCtx) => {
    const settings = settingsCtx.settings
    // legacy(≤0.1.6)方法面:register/get/update/describe 命名空间语义
    if (typeof settings.get === 'function' && typeof settings.register === 'function') {
      settings.register(SETTINGS_NAMESPACE, SETTINGS_SCHEMA, { base: config })
      // 每日本地日首次写入时按保留值清理分钟/小时桶;启动回扫前的触发在下方回扫入口
      store.retentionDays = () =>
        settings.get(SETTINGS_NAMESPACE)?.minuteRetentionDays ?? DEFAULT_MINUTE_RETENTION_DAYS
      budget.active = true
      budget.config = () => ({
        ...normalizeBudgetConfig(settings.get(SETTINGS_NAMESPACE)?.budget),
        enabled: featureOn(features.current(), 'guard'),
      })
      budget.replace = async (next) => {
        await settings.update(SETTINGS_NAMESPACE, { budget: normalizeBudgetConfig(next) })
        return budget.config()
      }
      features.active = true
      features.current = () => normalizeFeatures(settings.get(SETTINGS_NAMESPACE)?.features)
      features.replace = async (next) => {
        await settings.update(SETTINGS_NAMESPACE, { features: normalizeFeatures(next) })
        return normalizeFeatures(settings.get(SETTINGS_NAMESPACE)?.features)
      }
      sentinelSettings.config = () => normalizeSentinelConfig(settings.get(SETTINGS_NAMESPACE)?.sentinel)
      cycle.active = true
      cycle.config = () => normalizeCycleConfig(settings.get(SETTINGS_NAMESPACE)?.cycle)
      cycle.replace = async (next) => {
        await settings.update(SETTINGS_NAMESPACE, { cycle: normalizeCycleConfig(next) })
        return normalizeCycleConfig(settings.get(SETTINGS_NAMESPACE)?.cycle)
      }
      return
    }
    // 0.1.7+ 形态:静态 Config 导出生成节表单。关闭原生自动页(maintain 同构),
    // 读经 apply 入参 config 整节解包,写经 configEditor.edit(fiber.entry 与命名空间
    // 解耦);定价规则不在本形态内,读写走 usage_pricing 域
    if (typeof settings.configure === 'function') {
      settingsCtx.effect(() => settings.configure({ auto: false }, ctx.fiber))
    }
    store.retentionDays = () => unwrapVolatile(config)?.minuteRetentionDays ?? DEFAULT_MINUTE_RETENTION_DAYS
    budget.active = true
    budget.config = () => ({
      ...normalizeBudgetConfig(unwrapVolatile(config)?.budget),
      enabled: featureOn(features.current(), 'guard'),
    })
    budget.replace = async (next) => {
      const editor = ctx.get('configEditor')
      const entry = ctx.fiber?.entry
      if (!editor || typeof editor.edit !== 'function' || !entry) {
        throw new Error('usage-dash: configEditor inactive')
      }
      await editor.edit(entry, (current) => ({ ...current, budget: normalizeBudgetConfig(next) }))
      return budget.config()
    }
    features.active = true
    features.current = () => normalizeFeatures(unwrapVolatile(config)?.features)
    features.replace = async (next) => {
      const editor = ctx.get('configEditor')
      const entry = ctx.fiber?.entry
      if (!editor || typeof editor.edit !== 'function' || !entry) {
        throw new Error('usage-dash: configEditor inactive')
      }
      const normalized = normalizeFeatures(next)
      await editor.edit(entry, (current) => ({ ...current, features: normalized }))
      return normalizeFeatures(unwrapVolatile(config)?.features)
    }
    sentinelSettings.config = () => normalizeSentinelConfig(unwrapVolatile(config)?.sentinel)
    cycle.active = true
    cycle.config = () => normalizeCycleConfig(unwrapVolatile(config)?.cycle)
    cycle.replace = async (next) => {
      const editor = ctx.get('configEditor')
      const entry = ctx.fiber?.entry
      if (!editor || typeof editor.edit !== 'function' || !entry) {
        throw new Error('usage-dash: configEditor inactive')
      }
      await editor.edit(entry, (current) => ({ ...current, cycle: normalizeCycleConfig(next) }))
      return normalizeCycleConfig(unwrapVolatile(config)?.cycle)
    }
  })
  const bootScan = async () => {
    await store.readyPromise()
    await store.pruneMinutes()
    await store.pruneHours()
    await collector.rescan()
    // 旧版本只有用量桶没有会话索引:回扫后补建,面板「会话数量」立即可用
    await collector.ensureSessionIndex()
  }
  ctx.effect(() => {
    collector.start()
    void bootScan().catch((err) => {
      ctx.logger?.warn(`usage-dash: 启动回扫未完成 ${err instanceof Error ? err.message : String(err)}`)
    })
    // 卸载中止在飞扫描,防热重载后遗留扫描向已关闭的域写入
    return () => collector.abort()
  }, 'usage-dash: collector')
  // 成本控制四模块共用查询上下文:store + 定价能力 + 宿主时钟与水桶时区
  const costDeps = {
    store,
    pricing,
    now: Date.now,
    timeZone: HOST_TIME_ZONE,
    retentionDays: () => store.retentionDays(),
    // 「本周期」窗口由用户套餐口径决定,摘要与周期预算共用
    cycleConfig: () => cycle.config(),
    // 哨兵开关与阈值合并投影:关闭时检测入口直接短路,不产事件
    config: () => ({ ...sentinelSettings.config(), enabled: featureOn(features.current(), 'sentinel') }),
  }
  const sentinel = installSentinel(ctx, costDeps)
  // Guard 的 disposer 同时挂着状态读取面:routes 侧 /budget 要合并熔断态
  const guard = { current: undefined }
  ctx.effect(() => {
    guard.current = installGuard(ctx, {
      ...costDeps,
      // 预算能力门面在 settings 激活时整体换实现:这里必须每次读属性,不能捕获旧函数引用
      config: () => budget.config(),
      spent: () => readSpent(costDeps),
    })
    return guard.current
  }, 'usage-dash: guard')
  // 保留值经 store 单源转发:settings 激活即取设置值,未激活回落构造默认
  registerUsageRoutes(ctx, {
    store,
    collector,
    retentionDays: () => store.retentionDays(),
    pricing,
    budget,
    cycle,
    sentinel,
    features,
    guard: () => guard.current?.status?.() ?? null,
  })
}
