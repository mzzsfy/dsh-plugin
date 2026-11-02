// 50 连跑统计:真实时钟下 kline-app 两 remote 用例的间歇性测量
import { createApplication } from '../src/application.mjs'
import { tencent } from '../src/providers/tencent.mjs'
import { sina } from '../src/providers/sina.mjs'
import { eastmoney } from '../src/providers/eastmoney.mjs'
import { memoryStorage } from './helpers.mjs'

const suggestBody = () => ({ ok: true, json: async () => ({ QuotationCodeTable: { Data: [{ Code: '00700', Name: '腾讯控股', MktNum: '116', JYS: null, QuoteID: '116.00700', Classify: 'HKStock', PinYin: 'txkg' }] } }) })

let ok2 = 0, fail2 = 0, ok1 = 0, fail1 = 0
const t0 = Date.now()
for (let i = 0; i < 25; i++) {
  // 用例2形态
  {
    let suggestCalls = 0
    const app = await createApplication({ storageDomain: memoryStorage(), providers: [tencent, sina, eastmoney], fetch: async url => { if (String(url).includes('suggest')) suggestCalls += 1; return suggestBody() }, publish: () => {} })
    try { const r = await app.search('00700', 'remote'); if (suggestCalls >= 3 && r.items.some(x => x.exchange === 'XHKG')) ok2++; else { fail2++; console.log('round', i, 'CASE2 weak suggestCalls=', suggestCalls) } } catch (e) { fail2++; console.log('round', i, 'CASE2 THROW', e.code, 'suggestCalls=', suggestCalls) }
    await app.close()
  }
  // 用例1形态
  {
    const app = await createApplication({ storageDomain: memoryStorage(), providers: [tencent, sina, eastmoney], fetch: async () => suggestBody(), publish: () => {} })
    try { const r = await app.search('腾讯', 'remote'); const hk = r.items.find(x => x.exchange === 'XHKG'); if (hk && hk.currency === 'HKD' && hk.priceScale === 2) ok1++; else if (!hk) { fail1++; console.log('round', i, 'CASE1 no XHKG') } else { fail1++; console.log('round', i, 'CASE1 bad meta', hk.currency, hk.priceScale) } } catch (e) { fail1++; console.log('round', i, 'CASE1 THROW', e.code) }
    await app.close()
  }
}
console.log(`elapsed=${Date.now() - t0}ms CASE1 ok=${ok1} fail=${fail1} | CASE2 ok=${ok2} fail=${fail2}`)
process.exit(0)
