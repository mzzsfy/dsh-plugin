// 用量统计面板 Host 半区:采集 session/event 落 usage_stats 域,经 webServer
// 暴露 /api/usage-dash/* 供浏览器半区消费。S2 落存储域与 settings 注册,
// S3 接入采集与启动回扫,S13 扩展 pricing 形状并接线定价能力。

import schemastery from '@deepseek-ai/schemastery'

import { UsageCollector } from './collector.js'
import { CURRENCIES, CONDITION_KINDS, UNIT_PER_MILLION } from './pricing.js'
import { registerUsageRoutes } from './routes.js'
import { DEFAULT_MINUTE_RETENTION_DAYS, MINUTE_RETENTION_MAX_DAYS, sharedStore } from './store.js'
// 顶层 inject 仅声明 web profile 必然存在的四个服务;settings 在 apply 内
// 嵌套 inject(通道级静默不激活),构成干净禁用。
export const inject = ['webServer', 'sessionPersistence', 'sessions', 'storageDomain']

export const name = 'dsh-usage-dash'

const SETTINGS_NAMESPACE = 'usage-dash'

// 定价形状与 pricing.js 契约同源:kind 判别 required 恒成立,
// 防 nullable 直通误入首个 union 成员
const WEEKDAY_MIN = 0
const WEEKDAY_MAX = 6

const CONDITION_FIELD_SCHEMAS = {
  dailyWindow: { from: schemastery.string(), to: schemastery.string() },
  weekdays: { days: schemastery.array(schemastery.number().min(WEEKDAY_MIN).max(WEEKDAY_MAX).step(1)) },
  monthDays: { from: schemastery.number().step(1), to: schemastery.number().step(1) },
  dateRange: { from: schemastery.string(), to: schemastery.string() },
}

const CONDITION_SCHEMA = schemastery.union(
  CONDITION_KINDS.map((kind) => schemastery.object({
    kind: schemastery.const(kind).required(),
    ...CONDITION_FIELD_SCHEMAS[kind],
  })),
)

const PRICING_RULE_SCHEMA = schemastery.object({
  model: schemastery.string(),
  unit: schemastery.const(UNIT_PER_MILLION),
  currency: schemastery.union(CURRENCIES.map((currency) => schemastery.const(currency))),
  price: schemastery.object({
    input: schemastery.number().min(0),
    output: schemastery.number().min(0),
    cacheRead: schemastery.number().min(0),
    cacheWrite: schemastery.number().min(0),
  }),
  conditions: schemastery.array(CONDITION_SCHEMA),
})

const SETTINGS_SCHEMA = schemastery.object({
  minuteRetentionDays: schemastery.number().min(0).step(1).default(DEFAULT_MINUTE_RETENTION_DAYS)
    .description(`分钟桶保留天数(上限 ${MINUTE_RETENTION_MAX_DAYS} 天),0 表示禁用分钟桶`),
  pricing: schemastery.object({ rules: schemastery.array(PRICING_RULE_SCHEMA) })
    .description('定价规则(wire 由 /api/usage-dash/pricing 读写)'),
})

export function apply(ctx, config) {
  const store = sharedStore(ctx.storageDomain)
  const collector = new UsageCollector(ctx, store)
  // pricing 能力门面:settings 激活前置 active=false(routes 侧 GET 空值、
  // POST 拒 503),激活后实时读 settings——改价下次查询即时生效
  const pricing = {
    active: false,
    rules: () => [],
    revision: () => 0,
    replace: async () => {
      throw new Error('usage-dash: pricing settings inactive')
    },
  }
  ctx.inject(['settings'], (settingsCtx) => {
    const settings = settingsCtx.settings
    settings.register(SETTINGS_NAMESPACE, SETTINGS_SCHEMA, { base: config })
    // 每日本地日首次写入时按保留值清理分钟/小时桶;启动回扫前的触发在下方回扫入口
    store.retentionDays = () =>
      settings.get(SETTINGS_NAMESPACE)?.minuteRetentionDays ?? DEFAULT_MINUTE_RETENTION_DAYS
    pricing.active = true
    pricing.rules = () => settings.get(SETTINGS_NAMESPACE)?.pricing?.rules ?? []
    // revision 取 describe 中本 ns 描述符,settings 任何写入都会自增
    pricing.revision = () =>
      settings.describe().find((descriptor) => descriptor.ns === SETTINGS_NAMESPACE)?.revision ?? 0
    pricing.replace = async (rules) => {
      // update 深合并下数组整体替换,不动 minuteRetentionDays 用户层
      await settings.update(SETTINGS_NAMESPACE, { pricing: { rules } })
      return settings.get(SETTINGS_NAMESPACE)?.pricing?.rules ?? []
    }
  })
  const bootScan = async () => {
    await store.readyPromise()
    await store.pruneMinutes()
    await store.pruneHours()
    await collector.rescan()
  }
  ctx.effect(() => {
    collector.start()
    void bootScan().catch((err) => {
      ctx.logger?.warn(`usage-dash: 启动回扫未完成 ${err instanceof Error ? err.message : String(err)}`)
    })
    // 卸载中止在飞扫描,防热重载后遗留扫描向已关闭的域写入
    return () => collector.abort()
  }, 'usage-dash: collector')
  // 保留值经 store 单源转发:settings 激活即取设置值,未激活回落构造默认
  registerUsageRoutes(ctx, { store, collector, retentionDays: () => store.retentionDays(), pricing })
}
