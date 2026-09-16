// config 形态 schema:「rs-workflow」三节(slots/budgets/templates),自有文件存储(config.json)
// 契约源 docs/rsww-v5/data-design.md 存储布局节;board config-save 校验口径同源
import z from '@deepseek-ai/schemastery'

// 工作位键集与 lib/template.mjs 的 SLOT_KEYS 互为镜像(非派生),test/settings.test.mjs 对拍钉住
export const SLOT_KEYS = ['planner', 'executor', 'reviewer', 'executor-loop', 'reviewer-approve', 'executor-escalate']
export const BUDGET_KEYS = ['maxStepFail', 'approveRounds', 'escalateLimit']
export const DEFAULT_BUDGETS = { maxStepFail: 2, approveRounds: 2, escalateLimit: 2 }

// 模块常量,不开放配置(无 workflow 节)
export const DEFAULT_CONCURRENCY = 4
export const KEEP_RUNS = 200

const BUDGET_MIN = 1
const BUDGET_MAX = 10
const SLOT_FORM = '取值形态:string[](候选依次轮换;兼容历史 string 单模型存储),缺省空数组'
const BUDGET_FORM = `取值形态:整数,clamp [${BUDGET_MIN},${BUDGET_MAX}]`

// 文案三要素:绑定对象/缺省降级链/取值形态(末段经 FORM 常量拼接);文案不参与校验,校验口径以键集与 clamp 常量为准
const SLOT_DESCRIPTIONS = {
  planner: '规划域位:大纲/计划/分诊类步骤显式绑定;留空 = 会话默认模型',
  executor: '执行域默认位:常规步骤未声明 slot 时的缺省绑定;候选失败依次轮换',
  reviewer: '审批域通用位:审批域绑定(approve 原语步固定 reviewer-approve,不降级至此)',
  'executor-loop': '循环与重做缺省位:for_each 实例与审批重做批次未声明 slot 时的缺省绑定',
  'reviewer-approve': '审批裁决位:type:"approve" 步骤固定绑定,模板 slot 字段不可覆盖',
  'executor-escalate': '升级缺省位:onExhausted 指向的 escalate-only 步骤未声明 slot 时的缺省绑定',
}
const BUDGET_DESCRIPTIONS = {
  maxStepFail: '步骤连续调用失败上限;步骤 maxFail 字段缺省取此值;达上限步骤 failed、下游 skipped',
  approveRounds: 'approve 步骤默认重审轮次(步骤未声明 rounds 时);耗尽走 onExhausted',
  escalateLimit: 'run 级升级账上限;升级累计达此值整流程 blocked',
}

function buildSlots() {
  const slot = (description) => z.union([z.string(), z.array(z.string())]).default([]).description(`${description};${SLOT_FORM}`)
  return z.object(Object.fromEntries(SLOT_KEYS.map((key) => [key, slot(SLOT_DESCRIPTIONS[key])])))
}

// clamp 在归一层执行,schema 只声明合法域(v3 结论:min/max 为校验非钳制)
function buildBudgets() {
  const budget = (key) => z.number().default(DEFAULT_BUDGETS[key]).min(BUDGET_MIN).max(BUDGET_MAX).description(`${BUDGET_DESCRIPTIONS[key]};${BUDGET_FORM}`)
  return z.object(Object.fromEntries(BUDGET_KEYS.map((key) => [key, budget(key)])))
}

function buildTemplates() {
  const item = z.object({
    id: z.string().required().description('流程 id(^[a-z][a-z0-9-]*$)'),
    label: z.string().default('').description('显示名'),
    description: z.string().default('').description('适用场景'),
    enabled: z.boolean().default(true).description('禁用后不可创建、重跑不可选'),
    json: z.string().default('').description('流程定义 JSON 全文(规范见设置页模板规范)'),
  })
  return z.array(item).default([]).description('流程模板集:自有文件存储 templates.json 全量')
}

// 存储形态 schema(config.json 载入面归一;载入走 normalizeConfig,此 schema 供工具化校验)
export const CONFIG_SCHEMA = z.object({ slots: buildSlots(), budgets: buildBudgets(), templates: buildTemplates() })

const isEntry = (value) => value !== null && typeof value === 'object'
const clampBudget = (value) => Math.min(BUDGET_MAX, Math.max(BUDGET_MIN, value))

// 归一恒为数组形态:历史 string 单模型存储升为单元素数组(读侧兼容,写侧不再产出 string)
function normalizeSlot(value) {
  if (Array.isArray(value)) return value.filter((item) => typeof item === 'string')
  if (typeof value === 'string' && value !== '') return [value]
  return []
}

function normalizeSlots(value) {
  const source = isEntry(value) ? value : {}
  return Object.fromEntries(SLOT_KEYS.map((key) => [key, normalizeSlot(source[key])]))
}

function normalizeBudgets(value) {
  const source = isEntry(value) ? value : {}
  return Object.fromEntries(BUDGET_KEYS.map((key) => [key, Number.isInteger(source[key]) ? clampBudget(source[key]) : DEFAULT_BUDGETS[key]]))
}

function normalizeTemplateEntry(entry) {
  if (!isEntry(entry) || typeof entry.id !== 'string') return null
  return {
    id: entry.id,
    label: typeof entry.label === 'string' ? entry.label : '',
    description: typeof entry.description === 'string' ? entry.description : '',
    enabled: typeof entry.enabled === 'boolean' ? entry.enabled : true,
    json: typeof entry.json === 'string' ? entry.json : '',
  }
}

function normalizeTemplates(value) {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    const item = normalizeTemplateEntry(entry)
    return item ? [item] : []
  })
}

// 旧值自清理归一:未声明键剔除、缺省键补默认;返回新对象不改入参
export function normalizeConfig(value) {
  const source = isEntry(value) ? value : {}
  return { slots: normalizeSlots(source.slots), budgets: normalizeBudgets(source.budgets), templates: normalizeTemplates(source.templates) }
}
