// 定价规则持久化:usage_pricing 域单表单行。规则表属于插件自有数据,不进
// profile 配置槽位——逐条规则的嵌套结构在 YAML 里会把整节配置撑散。
// 读同步取内存快照;写串行在域写链上,revision 每次整表替换自增。
// 打开失败只降级(定价能力缺席),不拖垮采集与面板。

import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'

import { normalizePricingRules } from './pricing.js'

const DOMAIN_NAME = 'usage_pricing'
const TABLE_RULES = 'rules'
const ROW_KEY = 'current'

// 行形状只约束容器:规则条目是上游 wire 形状,由 routes 侧 zod 校验,
// 存储层放宽以免未来字段演进把整域读挂;revision/updatedAt 给默认值,
// 存量行缺这两列时仍可读入
export const pricingDomain = defineDomain({
  name: DOMAIN_NAME,
  version: 1,
  tables: {
    [TABLE_RULES]: domainTable(z.object({
      rules: z.array(z.unknown()),
      revision: z.number().default(0),
      updatedAt: z.number().default(0),
    })),
  },
})

const EMPTY_RECORD = Object.freeze({ rules: Object.freeze([]), revision: 0, updatedAt: 0 })

// 读入即归一:存量规则(迁移前的 profile 配置或旧版本写入)可能在数组里重复
// 同模式无条件规则,与匹配器「同档取表内首条」口径一致
const normalizeRecord = (record) => ({ ...record, rules: normalizePricingRules(record.rules) })

export class PricingStore {
  constructor(facility, options = {}) {
    this.now = options.now ?? Date.now
    this.table = undefined
    this.record = EMPTY_RECORD
    this.openError = undefined
    // 域打开完成才允许写读走持久层;降级态恒 false
    this.opened = false
    // 写链:replace/importLegacy 串行,保证 revision 单调且不丢写
    this.chain = Promise.resolve()
    // ready 永远 resolve(打开失败转降级),逃逸拒绝会拖垮宿主
    this.ready = this.initialize(facility).catch((err) => {
      this.openError = err
    })
  }

  async initialize(facility) {
    const domain = await facility.open(pricingDomain)
    this.table = domain.table(TABLE_RULES)
    const stored = this.table.get(ROW_KEY)
    this.record = stored === undefined ? EMPTY_RECORD : normalizeRecord(stored)
    this.opened = true
  }

  get degradation() {
    return this.openError
  }

  async readyPromise() {
    await this.ready
  }

  // 只读快照:域未就绪时为空表,调用方按 active 判断是否挂费用
  rules() {
    return this.record.rules
  }

  revision() {
    return this.record.revision
  }

  // 是否已有任何写入(迁移据此判断要不要导入存量配置)
  hasRecord() {
    return this.record.revision > 0 || this.record.rules.length > 0
  }

  degradedError() {
    const detail = this.openError instanceof Error ? this.openError.message : String(this.openError)
    return new Error(`pricing store degraded (domain unavailable: ${detail})`)
  }

  // 整表替换:先落盘再更新内存快照,失败保持旧值
  replace(rules) {
    return this.enqueue(async () => {
      const next = normalizeRecord({ rules, revision: this.record.revision + 1, updatedAt: this.now() })
      await this.table.put(ROW_KEY, next)
      this.record = next
      return next.rules
    })
  }

  // 一次性导入存量 profile 规则:域内已有记录时不覆盖(用户可能已在新编辑器改过)
  importLegacy(rules) {
    return this.enqueue(async () => {
      if (this.hasRecord()) return false
      const next = normalizeRecord({ rules, revision: this.record.revision + 1, updatedAt: this.now() })
      await this.table.put(ROW_KEY, next)
      this.record = next
      return true
    })
  }

  enqueue(write) {
    const run = this.chain.then(async () => {
      await this.ready
      // 降级态下写一律失败,读侧由 active 关掉
      if (this.openError !== undefined) throw this.degradedError()
      return write()
    })
    this.chain = run.then(() => {}, () => {})
    return run
  }
}

const SHARED_STORE_KEY = '__dshUsageDashPricingStores'

// 单例按 facility 关联:热重载换 facility 后旧实例不该泄漏给新一代;
// 降级实例一律重建(与 usage 桶 store 同口径)
export function sharedPricingStore(facility, options = {}) {
  const cacheable = (typeof facility === 'object' && facility !== null) || typeof facility === 'function'
  const existing = cacheable ? globalThis[SHARED_STORE_KEY]?.get?.(facility) : undefined
  if (existing && existing.degradation === undefined) return existing
  const store = new PricingStore(facility, options)
  if (cacheable) (globalThis[SHARED_STORE_KEY] ??= new WeakMap()).set(facility, store)
  return store
}

export function __resetSharedPricingStoreForTests() {
  delete globalThis[SHARED_STORE_KEY]
}
