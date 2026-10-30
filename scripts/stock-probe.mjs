// 真实数据源自检(授权后人工执行):node scripts/stock-probe.mjs [XSHG|XSHE] [tushare|eastmoney]
// Tushare读DSH_STOCK_TUSHARE_TOKEN(约3次请求);eastmoney免凭据(目录1次分页探测+报价/联想各1次)。
import { tushare } from '../packages/dsh-stock-assistant/src/providers/tushare.mjs'
import { eastmoney } from '../packages/dsh-stock-assistant/src/providers/eastmoney.mjs'
import { createBudget } from '../packages/dsh-stock-assistant/src/budget.mjs'
import { createExecutor } from '../packages/dsh-stock-assistant/src/executor.mjs'
import { createRegistry } from '../packages/dsh-stock-assistant/src/provider-registry.mjs'
import { makeSecurity } from '../packages/dsh-stock-assistant/src/market-model.mjs'
const choice = process.argv[3] === 'eastmoney' || !process.env.DSH_STOCK_TUSHARE_TOKEN && process.argv[3] !== 'tushare' ? 'eastmoney' : 'tushare'
if (choice === 'tushare' && !process.env.DSH_STOCK_TUSHARE_TOKEN) { console.error('未配置环境变量 DSH_STOCK_TUSHARE_TOKEN；或使用: node scripts/stock-probe.mjs XSHG eastmoney'); process.exit(2) }
const adapter = choice === 'tushare' ? tushare : eastmoney
const registry = createRegistry([adapter])
const executor = createExecutor({ registry, budget: createBudget(), env: process.env })
const market = process.argv[2] === 'XSHE' ? 'XSHE' : 'XSHG'
const code = market === 'XSHG' ? '600519' : '000001'
const today = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10)
const requests = {
  quotes: { market, instrument: 'equity', securities: [makeSecurity(market, code, '探针证券')] },
  catalog: { market, instrument: 'equity' },
  search: { market, instrument: 'equity', q: '茅台', limit: 5 },
}
if (choice === 'tushare') { requests.calendar = { market, instrument: 'equity', startDate: today, endDate: today }; delete requests.search }
const instance = { id: 'probe', adapterId: choice, credentialEnv: choice === 'tushare' ? 'DSH_STOCK_TUSHARE_TOKEN' : null, quotaGroup: 'probe', budget: { requestsPerMinute: 3, dailyRequestLimit: null, billingUnit: 'request', symbolCreditsPerMinute: null, capabilityLimits: {} } }
const results = {}
for (const [capability, request] of Object.entries(requests)) {
  const started = Date.now()
  try {
    const result = await executor.run(instance, capability, request, { probe: true })
    results[capability] = { status: 'ready', ms: Date.now() - started, items: result.items?.length ?? null }
  } catch (e) { results[capability] = { status: e.code === 'PERMISSION' ? 'denied' : e.code, message: e.message, ms: Date.now() - started } }
}
console.log(JSON.stringify({ adapter: choice, market, results, note: '此结果仅代表账号/来源当前可用性,不构成展示授权' }, null, 2))
executor.dispose()
