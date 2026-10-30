# 股票 K 线与多市场开发规格

日期：2026-10-30。目标包：`@mzzsfy/dsh-stock-sidebar` 第二期。状态：设计定稿待实施。前置：第一期规格见[开发-股票侧边栏插件](../开发-股票侧边栏插件.md)（已交付：多源行情骨架/浏览市场/设置路由），本期在其上增量。执行状态与审查记录见 .work/bootstrap-kline-multimarket.md（任务记录，不入版本库）。

## 文档职责与流程边界

本文是本期**唯一权威正文**（一期同构单文件）：范围决策、实测证据、架构、接口合同、数据结构、页面/交互/文本、BDD 验收、实施计划与交付清单全含。参考取证来源见文末附录 A，全部实证无猜测。

用户已确认决策（ask_user_question 回执）：图表库不自绘轮子用主流方案；kline 进 provider 合同+四周期；市场尽量全+数据源 URL 可配置；详情页 K线主视图/币种原币/缓存 TTL 按推荐；M1-M5 为 MVP。

约束：无子agent开发（审查除外）、禁 playwright、生产 profile 不动、免凭据公开源优先、单页面工具生命周期、真实 token 不消耗。

阅读顺序：范围与决策 → 实测证据 → 架构 → 接口合同 → 数据结构 → 页面交互文本 → BDD → 风险 → 实施计划 → 交付清单 → 附录。

## 范围与决策

| # | 决策 | 内容 |
|---|---|---|
| D-1 | 图形渲染 | lightweight-charts@5.2.1 standalone UMD；npm 依赖落 vendor/；宿主 prefix 路由服务；client 动态 script 注入幂等 |
| D-2 | 数据管道 | `kline` 为 provider 合同第五种能力（quotes/catalog/search/calendar/kline），复用路由/预算/failover 框架（failover 见"故障转移（双轨）"节） |
| D-3 | 周期 | trend（当日分时）/1d/1w/1M 四周期 MVP；qfq 前复权单选项 |
| D-4 | 市场 | 八市场枚举（XSHG/XSHE/XHKG/XNAS/XNYS/XJPX/XKRX/XLON）；MVP 五市场可用（沪深/港/美），日/韩/英探针验证后启用；加拿大无源剔除 |
| D-5 | 主备源 | kline 主源东财、备源腾讯；美股腾讯备源需代码映射缓存命中（见"美股代码映射"节） |
| D-6 | 详情重构 | K线主视图全页单列，字段栏 240px 右侧 |
| D-7 | 币种 | 原币展示不换汇（CNY/HKD/USD/JPY/KRW/GBP） |
| D-8 | 缓存 | TTL 按"数据结构-kline 缓存"节为唯一事实源（trend 0 / 1d 1h / 1w·1M 24h）；复用 cache 表壳 |
| D-9 | 端点可配 | 实例 `endpoints` 覆盖块 `{[capability]: urlTemplate}` |
| D-10 | 市场扩容 | 路由/预算参数化零改动（除 schema 扩展节列明的守卫放宽） |
| D-11 | MVP | M1-M5（见开发文档里程碑表）；日/韩/英启用与分钟级周期移交后续 feat |

**非目标**：画线工具/指标公式编辑器/实时推送/汇率换算/加拿大市场/盘前盘后/分钟级 K 线/期权期货/复权模式切换（仅 qfq）。

## 实测证据基线（2026-10-30 全部会话内验证）

### 数据端点

| 端点 | 证据 | 响应形态 |
|---|---|---|
| 东财 kline `push2his/api/qt/stock/kline/get` | klt=101/102/103 均 200；**fields2 决定 CSV 列数**（实测 f51-f57→7 列，f51-f61→11 列，逐字段对应） | 列义 `f51=date,f52=open,f53=close,f54=high,f55=low,f56=volume,f57=amount`（**close 在 high 前，非 OHLC 惯例序**）；`data.preKPrice` 昨收；`data.dktotal` 总条数；fqt=1 前复权 |
| 东财分时 `trends2/get?ndays=1&iscr=0` | 200；首行 09:30 开=高=低=收单一价、末行 15:00 均价递增、preClose=11.54 对照定案 | `trends[]` 列义 `time,open,close,high,low,volume,amount,avg`；`data.preClose` |
| 东财 quotes `ulist.np/get` | secids=116.00700,105.AAPL,106.BABA 200 | f2 价/f3 涨跌幅/f4 涨跌额/f5 量/f6 额/f12 代码/f13 市场/f14 名/f18 昨收/f124 时间戳 |
| 东财 secid 前缀 | 逐前缀实测扫描 | 沪1./深0./港116./NASDAQ 105./NYSE 106./AMEX 107./日176./韩177./英155.；加拿大无前缀(data:null) |
| 东财搜索 `searchapi/api/suggest/get` | 200；全字段实测（AAPL）: Code/Name/PinYin/ID/**JYS:"NASDAQ"**/Classify/MarketType/SecurityTypeName/SecurityType/**MktNum:"105"**/TypeUS/QuoteID/UnifiedCode/InnerCode | `Data[]`: Code/Name/MktNum(=secid前缀)/JYS(交易所名，美股 suffix 推导源)/Classify/QuoteID(=secid)/SecurityTypeName |
| 腾讯 kline `ifzq.gtimg.cn/appstock/app/fqkline/get` | 日/周/月 200；港 hk00700/美 usAAPL.OQ 同构 | `data.{symbol}.{qfqday|day|qfqweek|qfqmonth}[]`=`[date,open,close,high,low,volume]` 字符串数值；键名随复权/周期漂移需兜底 |
| 腾讯美股裸查 | usAAPL 无后缀返回 2011 年乱序列 | **美股必须带 .OQ/.N 后缀**，来源=搜索联想缓存 |

限流经验（第一期实测）：新浪快速分页需 600ms 间隔+短页退避；东财 clist 对本机 IP 段被限（catalog 已绕行）；push2his/searchapi 当前不限。

### 参考目标（附录 A 全来源）

| 对象 | 实证 | 对设计的意义 |
|---|---|---|
| 韭菜盒子 v3.24.0 | K线=东财 h5chart iframe 内嵌（非自绘）；涨跌色可配设置项；市场映射 hk→116/usr_→105 与实测一致 | 自渲染方案集成度超越参考；涨跌色必配 |
| 东财 h5chart 实页截图 | 周期段（盘前/盘后/分时/5日/日K/周K/月K/5分-60分）；头部条 `{名称}[{代码}] {时间} 价格:{价} 涨幅:{%} 成交量:{量}`；分时双轴；量副图红绿柱独立轴 | 页面设计节交互基准；头部条文案格式对齐 |
| lightweight-charts v5.2.1 typings | `createChart`/`chart.addSeries(CandlestickSeries|LineSeries|HistogramSeries|AreaSeries, options, paneIndex)`/`subscribeCrosshairMove`/导出常量映射/CrosshairMode | **v5 与 v4 不兼容**（addCandlestickSeries 已移除）——按 v5 签名实施 |

## 架构

### 顶层模块图（无环）

```
┌─ client.js(改) ──────────────────────────────────────────────┐
│ DetailView → KlineView(新) → ensureLwc(新,script注入)          │
│      │ fetch /kline                    │ <script>             │
│      ▼                                 ▼                     │
│ [GET /api/stock-assistant/kline]   [GET /plugins-vendor/dsh-stock-assistant/lightweight-charts.standalone.production.js]
└──────┬──────────────────────────────────────┬───────────────┘
       ▼                                      ▼
┌─ routes.mjs(改) ─┐                  ┌─ index.js(改) ───────────────┐
│ +GET /kline      │                  │ +webServer.register(prefix)  │
└──────┬───────────┘                  │  白名单服务 vendor/ 目录       │
       ▼                              └──────────────────────────────┘
┌─ application.mjs(改) ────────────────────────────────────────┐
│ +kline(): parse→route→cache链→failover run→cache→响应          │
│ +usSymbols Map(search 写入) +klineReady/vendorAvailable 进 snapshot │
└──┬───────────────┬──────────────┬────────────────────────────┘
   ▼               ▼              ▼
kline-cache.mjs(新) provider-router(零改动) executor(微改:仅+usSymbols 透传一行)
   │                    │                    │ budget.reserve(capability='kline')
   ▼                    ▼                    ▼
storageDomain.cache  (market,'kline')路由   eastmoney.kline(改) / tencent.mjs(扩展既有文件+kline)

多市场改造连带（见"schema 扩展"节）: market-model.mjs(改:MARKET_META 派生+parseSecurityId 新增) +
schemas.mjs capability 枚举+provider-registry 白名单+备源守卫放宽(quotes→quotes/kline)
```

### 分层与数据流

1. **渲染层**（client.js）: 只懂「合同 candles + LightweightCharts API」，不知数据源
2. **传输层**（routes/application）: 只懂「securityId+period+limit → 缓存链或路由拉取」，不知渲染
3. **源适配层**（providers）: 只懂「源接口 ↔ 合同转换」，互不依赖（美股映射经 ctx 注入非直接引用）
4. **治理层**（budget/router 零改动；executor 仅 usSymbols 透传一行）: 队列/限流/预算逻辑不变

### 故障转移（双轨）

- **前置改动**: 既有守卫"只有报价支持备用源"放宽为 `['quotes','kline']`（见"schema 扩展"节第 3 项）
- **即时轨（kline 新增）**: 规则要点——触发码 NETWORK/TIMEOUT/BAD_PAYLOAD；RATE_LIMIT 不触发；每尝试后 recordRound 记账；全败抛最后一错。过程唯一事实源="application 接线"节 runWithFailover 伪代码
- **慢轨（既有零改动）**: collector 轮询 recordRound≥3 连续 NETWORK/TIMEOUT → switchPrimary 自动切 + "当前使用备用源"横幅（既有机制）
- 腾讯不支持的市场不配 fallback 即无切换

## 接口合同

### provider 合同 kline 能力

```js
// request（executor.run(instance, 'kline', request) 传入）
{ providerInstanceId, capability:'kline',          // executor 注入
  securityId: 'XSHG:equity:600519',                // 标准 ID
  market:'XSHG', code:'600519',                    // application 解析后冗余传入
  period: '1d',                                    // 'trend'|'1d'|'1w'|'1M'
  adjust: 'qfq', limit: 250 }                      // 20..1000
// response
{ providerInstanceId, fetchedAt, complete:true, preClose?,   // 分时/日K 有
  candles: [ { time, open, high, low, close, volume, avg? } ] }
// time: trend='09:30' / 其余='2026-10-30'，一律 string（client 转换渲染格式）
// complete: 源截断标志（东财 lmt≤dktotal 时 MVP 恒 true）——消费点=HTTP 响应透传+缓存 payload+BDD"源截断"场景断言（lmt 超 dktotal 变体）
// ctx: { now, signal, credential, fetch, usSymbols }——usSymbols 只读 Map（见"美股代码映射"节）
```

**错误语义**（StockError 既有码，无新增）:

| 场景 | code | HTTP | retryable |
|---|---|---|---|
| 不支持该周期（腾讯无 trend） | UNSUPPORTED_CAPABILITY | 422 | 否 |
| 停牌/退市（data:null 重试后仍空） | NO_DATA | 422 | 否 |
| CSV 列数不足/乱序/重复时间戳 | BAD_PAYLOAD | 502 | 否 |
| 网络失败 | NETWORK | 502 | 是 → 即时 failover |
| 预算耗尽 | RATE_LIMIT | 429 | 否 |

candles 按 time 严格升序，重复→BAD_PAYLOAD。数值一律 number（适配器 parseFloat）。

### HTTP API

```
GET /api/stock-assistant/kline?securityId=XSHG%3Aequity%3A600519&period=1d&limit=250
→ 200 { ok:true, data:{ candles, preClose?, source, fetchedAt, complete }, revision }
→ 400 INVALID_PARAM（klineQuerySchema: period 枚举/limit 20..1000 默认 250）
→ 422 NO_ROUTE（router.select 自抛既有语义）| UNSUPPORTED_CAPABILITY | NO_DATA
→ 429 RATE_LIMIT { retryAfterMs }
→ 502/504 NETWORK/TIMEOUT/BAD_PAYLOAD
```

handler 签名 `(input, signal)`（search 同款）；signal 客户端断开中止上游。GET 幂等——缓存写入是性能优化非控制面变更（revision 不动、operations 不记、不触发 changed()）。

### vendor 资源路由

```
GET /plugins-vendor/dsh-stock-assistant/lightweight-charts.standalone.production.js
→ 200 text/javascript; charset=utf-8, Cache-Control: public, max-age=86400
→ 404 白名单外一律 404
```

`webServer.register({kind:'prefix', path:'/plugins-vendor/dsh-stock-assistant', handler})`；白名单单文件；读 vendor/（相对 import.meta.dirname）；注册异常→warn+vendorAvailable=false（快照透出，client 降级）。

### schema 扩展（五处联动）

1. capability 枚举+`'kline'`（schemas.mjs 既有 z.enum）
2. 抽取导出 `marketSchema = z.enum(['XSHG','XSHE','XHKG','XNAS','XNYS','XJPX','XKRX','XLON'])`，routeSchema/securitySchema 引用同一来源（单一事实）
3. 备源守卫"只有报价支持备用源"放宽为 `['quotes','kline']`
4. 实例 `endpoints: z.record(z.string().url()).optional()`——键=capability，值=URL 模板。**MVP 消费的占位符**: 腾讯 `{symbol}/{period}/{limit}`；东财 kline 无模板替换（URL 由适配器常量构造，endpoints.kline 覆盖=整串替换）。{secid}/{klt}/{fqt}/{lmt} 细粒度占位符移交后续 feat（无消费者不设）
5. `klineQuerySchema`（HTTP 层校验）

默认配置: em-default `capabilityLimits.kline=30`；**路由不自动加 kline**（市场面宽放大限流面）。kline 路由产生途径=M4.4 设置页"一键为已启用市场配置K线"按钮（填充草稿走检查→保存合同，BDD 场景见"多市场"节）。provider-registry 白名单数组同步+`'kline'`。

**MARKET_META 派生改造（market-model.mjs，多市场硬前提）**——现状 literal 硬编码会让港美股过不了 watchlist 校验:

```js
MARKET_META = {
  // 来源标注: XSHG/XSHE=一期既有值（实测对照）；XHKG/XNAS/XNYS=会话实测行情与代码形态（00700/AAPL/BABA）+交易所公开惯例；XJPX/XKRX/XLON=惯例值（M4.6 探针时一并实测回填后转"实测"标注）
  XSHG: { currency:'CNY', timezone:'Asia/Shanghai', priceScale:2, codePattern:/^\d{6}$/, verifiedByDefault:true },
  XSHE: { currency:'CNY', timezone:'Asia/Shanghai', priceScale:2, codePattern:/^\d{6}$/, verifiedByDefault:true },
  XHKG: { currency:'HKD', timezone:'Asia/Hong_Kong', priceScale:2, codePattern:/^\d{4,5}$/, verifiedByDefault:true },
  XNAS: { currency:'USD', timezone:'America/New_York', priceScale:2, codePattern:/^[A-Z]{1,5}$/, verifiedByDefault:true },
  XNYS: { currency:'USD', timezone:'America/New_York', priceScale:2, codePattern:/^[A-Z]{1,5}$/, verifiedByDefault:true },
  XJPX: { currency:'JPY', timezone:'Asia/Tokyo', priceScale:0, codePattern:/^\d{4}$/, verifiedByDefault:false },
  XKRX: { currency:'KRW', timezone:'Asia/Seoul', priceScale:0, codePattern:/^\d{6}$/, verifiedByDefault:false },
  XLON: { currency:'GBP', timezone:'Europe/London', priceScale:2, codePattern:/^[A-Z0-9.]{1,10}$/, verifiedByDefault:false },
}
// verifiedByDefault: 探针门控唯一事实源（M4.4 一键按钮/路由保存检查/未验证标三项消费）——静态常量非运行时状态，探针通过随代码改 true 交付
// securitySchema: currency/timezone/priceScale 改 string/number + superRefine 对照 MARKET_META 校验一致
// makeSecurity(exchange, code, name): 从 MARKET_META 派生（签名不变，调用方零改）；沪深既有值与映射表完全一致，无数据迁移
// 新增 parseSecurityId(id): split(':') 解 exchange/instrument/code + codePattern 校验（现无此函数）
```

### 适配器: 腾讯（providers/tencent.mjs 既有文件扩展）

- descriptor → `capabilities:['quotes','kline']`，markets +XHKG/XNAS/XNYS
- `kline`: symbol 映射 XSHG `sh{code}`/XSHE `sz{code}`/XHKG `hk{code}`/美股 `us{code}.{suffix}`（suffix 由 usSymbols 存 suggest `JYS` 字段映射: NASDAQ→OQ/NYSE→N——JYS 实测见证据表；AMEX 对应腾讯形态未决补证，同 preClose 一并实施首步实测）；无映射→UNSUPPORTED_CAPABILITY"美股腾讯备源需先经搜索建立代码映射"；URL param=`{symbol},{day|week|month},,,{limit},qfq`，Referer gu.qq.com；键名漂移 `Object.values(data[symbol]).find(Array.isArray)` 兜底；行数组 parseFloat 归一化；preClose 从 `data.{symbol}.qt.{symbol}` 提取（**索引未决**——实施首步实测补证回填证据表）；period='trend'→UNSUPPORTED_CAPABILITY
- 既有 symbolOf 内联三元重构为 SYMBOL_PREFIX 查表——quotes/kline 共表防漂移
- endpoints.kline 覆盖: 占位符 {symbol}/{period}/{limit}

### 适配器: 东财（providers/eastmoney.mjs 既有文件扩展）

- descriptor → +`'kline'`，markets 八市场
- secid: `SECID_PREFIX[market]+'.'+code`；美股前缀按 usSymbols.mktNum（miss→默认 105+prefixGuessed→data:null 时 suggest 解析重试一次→NO_DATA）
- trend: trends2（fields2=f51-f58）→ 8 列 CSV→candles+avg；preClose=data.preClose
- 1d/1w/1M: push2his kline（fields2=f51-f57 固定 7 列）→ 列义 f52=open/f53=close/f54=high/f55=low（**close 在 high 前**）；列数<7→BAD_PAYLOAD；preClose=data.preKPrice
- data:null→"美股代码映射"节猜错路径；非美股 data:null 直接 NO_DATA

### application 接线（application.mjs）

```js
usSymbols = new Map()   // "美股代码映射"节；构造期传 createExecutor({... usSymbols})
async kline(input, signal) {
  assertLive()
  const { securityId, period, limit } = klineQuerySchema.parse(input)
  const { exchange, code } = parseSecurityId(securityId)
  const config = state.get()
  const { route, instance } = router.select('kline', exchange, 'equity')  // 未配置自抛 NO_ROUTE 422
  const chain = [instance, ...route.fallbackInstanceIds.map(id => config.providers.find(p => p.id === id)).filter(Boolean)]
  for (const cand of chain) {                    // 缓存按主源+备源链逐个查——failover 写入的备源缓存下次可命中
    const cached = klineCache.get({ providerInstanceId: cand.id, market: exchange, period, code }, config.routingRevision)
    if (cached) return { data: { ...cached.payload, source: cand.id }, revision: config.revision }   // fetchedAt=缓存拉取时间随 payload 透传
  }
  const result = await runWithFailover({ route, instance }, {...}, signal)  // "故障转移（双轨）"节即时轨；返回含实际成功 providerInstanceId
  if (period !== 'trend') klineCache.put({ providerInstanceId: result.providerInstanceId, ... }, result, config.routingRevision)   // trend TTL=0 跳过写入
  return { data: { ...result, source: result.providerInstanceId }, revision: config.revision }
}
// search(): 东财联想候选写 usSymbols（MktNum→mktNum）+候选项按 MARKET_META 附带 currency/priceScale 下发；snapshot(): +klineReady（routes.filter(capability==='kline') 按 market 布尔）+vendorAvailable
```

缓存写入失败（存储异常）静默吞掉不阻塞响应。

### routes+index

routes.mjs: `kline: ['GET', (input, signal) => app.kline(input, signal)]`（query 校验在 application 层，维持既有分层）。index.js: vendor prefix 路由注册 try/catch→vendorAvailable。

### client 详情重构（KlineView，复杂模块）

组件: `KlineView({ runtime, item, entry, view })`，state `kline:{period:'1d', loading, error, candles, preClose}`。数据流十步:

1. effect(securityId, period): abort 上一个→fetch→setData
2. `ensureLwc()`: 模块级 promise 单例；script[data-lwc] 存在等 onload，否则注入 vendor URL；失败 reject('图表组件不可用')；vendorAvailable=false 直接 reject
3. chart: `createChart(el, {...readChartTheme(), crosshair:{mode:CrosshairMode.Normal}, timeScale:{timeVisible: period==='trend'}})`
4. series: `addSeries(CandlestickSeries, {...}, 0)` + MA×4 `addSeries(LineSeries, {...}, 0)` + 量 `addSeries(HistogramSeries, {...}, 1)`（v5 paneIndex 原生副图）
5. MA: `candles.map((c,i)=>i<N-1?null:N均值)` 逐线过滤 null
6. trend: AreaSeries+avg LineSeries+`createPriceLine({price:preClose, lineStyle:Dashed})`
7. tooltip: 绝对定位 div，subscribeCrosshairMove 更新，leave 隐藏
8. 周期切换: setState→重拉→setData 重灌（chart 不销毁）；trend↔K线 series 类型不同需重建该 series（其余保留）
9. 卸载: chart.remove()+abort+observers disconnect；HMR 幂等（ensureLwc 单例）
10. 降级: reject 或 vendorAvailable=false→现有数字详情原样+顶部提示条

## 数据结构

### kline 缓存（复用 cache 表既有 valueSchema 壳）

```js
// key: `kline:{instanceId}:{market}:{period}:{code}`（catalog 同款命名空间隔离）
// value（domainSpec cache valueSchema 硬结构）:
{ kind:'kline', source:instanceId, fetchedAt, payload:{ candles, preClose, complete, routingRevision } }
// TTL（唯一事实源，D-8 决策表与 Step 1.3 引用此处）: trend 0（put 前按 TTL=0 跳过写入，不产生恒 miss 条目）/ '1d' 60*60*1000 / '1w'·'1M' 24*60*60*1000
// get(): 过期/payload.routingRevision 不符/损坏→null+异步删除
// invalidate(keyParts): 强刷用——删除该 securityId+period 条目（↻ 按钮消费点）
```

### 美股代码映射（application 层 usSymbols Map，不持久化）

```js
// key `US:{CODE}` → { mktNum:'105'|'106'|'107', jys:'NASDAQ'|'NYSE'|'AMEX', at }
//   （jys 存 suggest 原始交易所名；腾讯 suffix 由适配器按 JYS_TO_SUFFIX 映射——AMEX 形态未决补证）
// 写入: application.search() 东财联想候选（TTL 24h）
// 读: eastmoney(secid mktNum)/tencent(symbol suffix) 经 executor ctx 只读
// miss: 东财默认 105+猜错重试路径；腾讯直接 UNSUPPORTED_CAPABILITY
```

### 多市场 symbol 映射（各适配器常量，实测值）

```js
// eastmoney: SECID_PREFIX = { XSHG:'1', XSHE:'0', XHKG:'116', XNAS:'105', XNYS:'106', XJPX:'176', XKRX:'177', XLON:'155' }
//   （美股归属由搜索 MktNum 决定——105/106/107 数值来自实测响应写入 usSymbols.mktNum，适配器内不设 107 常量条目；securityId exchange 固定 XNAS/XNYS）
// tencent: SYMBOL_PREFIX = { XSHG:'sh', XSHE:'sz', XHKG:'hk' }（既有 symbolOf 内联三元重构入表，quotes/kline 共表）
// 币种精度: 单一事实源=market-model MARKET_META，唯一下发路径:
//   自选详情=snapshot item.currency/priceScale（makeSecurity 派生）；
//   搜索候选=application.search() 响应候选项附 currency/priceScale（服务端按 MARKET_META 补全）——client 不持任何映射表
```

### snapshot 扩展

```js
data.klineReady = { XSHG:true, ... }   // routes.filter(r=>r.capability==='kline') 按 market
data.vendorAvailable = true
// client: klineReady[market]===false → 周期按钮置灰+tooltip"该市场未配置K线来源"
// client: vendorAvailable===false → 详情直接数字详情
```

## 页面设计

### 详情页布局（detail 全页单列视图）

```
┌────────────────────────────────────────────────────────────┐
│ ← 返回列表   贵州茅台 600519  [沪 A·CNY]   1392.05 +2.81%    │  ← 头部条
├────────────────────────────────────────────┬───────────────┤
│ [分时] [日K] [周K] [月K]      前复权 ▾       │ 今开 1370.00   │  ← 工具条+字段栏(240px)
│ (周期按钮组，klineReady 置灰)  (MVP 唯一选项)  │ 最高 1395.88   │
├────────────────────────────────────────────┤ 最低 1362.11   │
│                                            │ 昨收 1353.97   │
│           K线主区（蜡烛+MA 线）              │ 成交量 3.2万手  │
│           flex 伸缩全宽                       │ 成交额 44.6亿   │
├────────────────────────────────────────────┤ 换手 0.26%     │
│           成交量副图（红/绿柱）               │ 振幅 2.49%     │
│           高度 ~22%                          │───────────────│
│                                             │ 别名 [____] 保存│
└────────────────────────────────────────────┴───────────────┘
```

- 布局改造: 现状页面级双列 grid（列表+320px detail 右栏）→ detail 视图升级**全页单列**（宽屏复用 `.ssb-view-detail` 钩子切单列，列表隐藏；窄屏行为不变）。头部条之下左右分栏: 左 K线区（flex 伸缩）/右字段栏 240px（现 ssb-facts 保留）；<720px 字段区折到图表下方两列网格
- 现价/涨跌并入头部条；图表区最小高度 280px，低于此显示"空间不足"提示并保留数字详情

### 周期按钮组

| 交互 | 行为 |
|---|---|
| 点击周期 | 切换→fetch（缓存命中立即渲染）→同 chart setData（不销毁，视区保留） |
| klineReady=false | 置灰+title"该市场未配置K线来源" |
| 加载中 | 按钮组右侧 spinner（12px，不阻塞上次图表） |
| 请求失败 | 图表区顶部错误条（ssb-banner 样式）"K线获取失败：{message}"+"重试"；图表保留上次数据 |
| 分时 | 无 MA 无蜡烛——AreaSeries 面积图+均价线+昨收虚线 |

### 十字光标与 tooltip

- `crosshair:{mode:CrosshairMode.Normal}`（自由十字，看盘惯例；v5 默认 Magnet 改）
- tooltip（鼠标右上方 8px 越界翻转）: `2026-10-30  开 1370.00  高 1395.88  低 1362.11  收 1392.05  涨幅 +2.81%`（对齐东财 h5chart 取证格式）；trend: `09:30  价 11.53  均价 11.51  量 11523`
- 蜡烛色每根按涨跌显式设置（东财惯例单色蜡烛随涨跌）

### 主题适配（复用既有涨跌色机制，Canvas 显式映射）

事实: client.js 涨跌色=根类 `ssb-green-up` 切换 `.ssb-up/.ssb-down` 选择器指向；CSS 变量 `--ssb-danger`(红)/`--ssb-ok`(绿) 恒定不翻转。

```js
readChartTheme(root, colorMode) {
  const cs = getComputedStyle(root)
  const red = cs.getPropertyValue('--ssb-danger'), green = cs.getPropertyValue('--ssb-ok')
  const [up, down] = colorMode === 'green-up' ? [green, red] : [red, green]   // 唯一分支点
  return { background:'transparent', textColor: cs.getPropertyValue('--ssb-text-sub'),
    gridLine: cs.getPropertyValue('--ssb-border'), crosshair: cs.getPropertyValue('--ssb-text-dim'),
    up, down, volumeUp: up+'73', volumeDown: down+'73',   // 45% 透明度
    MA: ['#f59e0b','#8b5cf6','#06b6d4','#64748b'] }       // MA5/10/20/60 固定色（行业惯例不随主题）
}
// colorMode 切换: preferences 变更全量 invalidate→React 重渲→KlineView effect 依赖重涂+重灌数据
// 宿主亮暗主题（CSS 变量值变 React 不重渲）: ResizeObserver（尺寸）+root MutationObserver(class/style)→重读变量 applyOptions
```

### 加载与骨架

首次进入: 图表容器骨架（浅灰+“加载K线…”12px）→ensureLwc+fetch 并行→首帧。切换证券: KlineView 复用（不重挂）setData 清旧。空数据（停牌/退市）: 居中“暂无K线数据（停牌或已退市）”+昨收参考线。

## 交互设计

### 进入路径

| 路径 | 行为 |
|---|---|
| 自选列表点行名 | 详情，默认 1d，limit 250 |
| 浏览市场行「详情」 | 同上 |
| 搜索候选「查看」 | 同上（未加自选也可看） |

### KlineView 状态机

```
IDLE → LOADING(fetch+ensureLwc 并行)
     → READY ──周期切换──> LOADING(轻量，图表保留)
     → ERROR(错误条+重试) ──重试──> LOADING
     → EMPTY(停牌文案)
无轮询；工具条 ↻ 清缓存该条目→re-fetch（强刷，盘中看最新蜡烛）
键盘: Tab 可达周期按钮；Esc 关 tooltip
```

### 多市场交互

| 位置 | 交互 |
|---|---|
| 搜索框 | 候选放宽含港/美；每条徽标`沪/深/港/美`+币种 |
| 搜索候选行 | 「加自选」/「查看」并列 |
| 自选列表 | 市场徽标列（沪/深/港/美/日/韩/英）+币种小字 |
| 详情头部 | `[沪A·CNY]` 市场币种一体徽标 |

### 文本定稿

| 位置 | 文案 |
|---|---|
| 周期按钮 | 分时 / 日K / 周K / 月K |
| 复权标签 | 前复权（下拉禁用态展示） |
| 加载中 | 加载K线… |
| 无数据 | 暂无K线数据（停牌或已退市） |
| 图表不可用 | 图表组件不可用，已显示数字详情 |
| 未配路由 | 该市场未配置K线来源 |
| 错误条 | K线获取失败：{原文案}＋「重试」 |
| 市场徽标 | 沪A / 深A / 港股 / 美股 / 日股 / 韩股 / 英股 |
| 币种跟随 | ·CNY / ·HKD / ·USD / ·JPY / ·KRW / ·GBP |
| tooltip 涨跌 | +2.81% / -1.20%（带符号） |
| 强刷 | 刷新K线（按钮 title） |

## BDD 权威验收

### K线数据管道

```gherkin
场景: 沪深证券日K获取
  Given 默认配置（em-default 含 kline 能力限额 30/分）且路由已配置
  When GET /kline?securityId=XSHE:equity:000001&period=1d&limit=250
  Then 200 且 candles 250 条升序且 f52=open/f53=close 列义正确且 preClose 存在且 source=em-default

场景: 缓存命中不触源
  Given 同一 securityId+period 1 小时内已成功拉取
  When 再次 GET /kline 同参
  Then 200 且 data.fetchedAt=缓存时间且 executor 调用计数不变且 data.source 不变

场景: 主源断网即时切换备源
  Given 路由 em-default 主源+腾讯备源 failoverMode=network 且夹具主源 fetch 抛 NETWORK
  When GET /kline
  Then 200 且 data.source=备源实例 id 且 router.recordRound 被调用且缓存写入备源 key

场景: 备源缓存命中
  Given 上场景已成功（缓存写入备源 key）
  When 再次 GET /kline（主源仍故障）
  Then 200 且不触发任何 executor 调用且 data.fetchedAt=缓存时间

场景: 源截断标志
  Given 夹具东财响应 lmt=250 但 dktotal=100（数据不足请求量）
  When GET /kline limit=250
  Then 200 且 data.complete=false

场景: 无路由
  Given XKRX 市场未配置 kline 路由
  When GET /kline?securityId=XKRX:equity:005930
  Then 422 NO_ROUTE

场景: 配额受限
  Given capabilityLimits.kline 已耗尽
  When GET /kline
  Then 429 且 retryAfterMs 透传且不触发 failover

场景: 腾讯键名漂移兜底（夹具）
  Given 夹具响应 data.hk00700.qfqday 存在（非 day 键，固定预期值蜡烛数组）
  When 腾讯 kline 调用
  Then candles 正确解析且与夹具预期值逐字段一致

场景: 美股腾讯无映射拒绝
  Given usSymbols 无 AAPL 条目
  When 腾讯 kline usAAPL 调用
  Then UNSUPPORTED_CAPABILITY 且文案含"代码映射"

场景: 分时管道
  When period=trend 对 000001
  Then candles 首元素 time='09:30' 且含 avg 且 preClose=trends2 preClose
```

### 多市场

```gherkin
场景: 港股全流程
  Given 搜索"腾讯"返回 00700（Classify=HKStock）且 XHKG 的 kline 路由已配置（经"kline 路由一键配置"场景产生）
  When 加自选→详情→日K
  Then 行情 HKD 原币徽标"港股·HKD"且 K线渲染且列表徽标"港"

场景: 美股前缀缓存
  Given 搜索 AAPL 已返回（MktNum=105 缓存写入）
  When kline AAPL
  Then secid=105.AAPL 不触发二次 suggest（计数断言）

场景: 美股前缀冷启动猜错重试
  Given usSymbols 无 AAPL（默认前缀 105 猜错）且夹具 secid=105.AAPL 返回 data:null 而 suggest 对"AAPL"返回真实 MktNum=106（NYSE 归属变体）
  When kline AAPL
  Then 首次 105 失败→suggest 解析→以 106.AAPL 重试一次成功且不再报 NO_DATA 且 usSymbols 缓存写入 106

场景: kline 路由一键配置
  Given 双实例默认配置且沪深/港/美探针通过、日韩英未通过
  When 设置页点击"一键为已启用市场配置K线"
  Then 生成 3 条 (market,'kline') 路由草稿（XSHG/XSHE/XHKG 主源 em-default+XHKG 备源 tencent）且日韩英不生成
  When 保存通过检查
  Then snapshot.klineReady 对应市场翻转 true 且 GET /kline 可用

场景: 日韩英探针门控
  Given XJPX 已枚举但探针未通过
  When 设置页保存含 XJPX 的 kline 路由
  Then 检查阶段 denied 且保存被 CHECK_REQUIRED 拦截且 UI 标"未验证"
```

### 渲染与交互

```gherkin
场景: vendor 降级
  Given vendorAvailable=false
  When 进详情页
  Then 数字详情原样渲染且顶部提示"图表组件不可用"且无 script 注入

场景: ensureLwc 幂等
  Given script[data-lwc] 已存在且 loaded
  When 再次 ensureLwc
  Then 不重复注入且返回同一 promise resolve

场景: 周期切换不重建
  Given 日K READY
  When 点周K
  Then chart 实例引用不变（同容器同实例）且 series setData 重灌且 MA 重算

场景: colorMode 切换
  Given preferences.colorMode 改 green-up
  Then KlineView effect 触发 readChartTheme 且 up=绿且蜡烛重灌

场景: 撤销横幅时序（M5 缺陷）
  Given 自选≥1 且删除操作完成
  When 删除后立即快照回刷（<500ms）
  Then 横幅"已移除自选。撤销"仍显示且 8 秒后消失且撤销可恢复

场景: 设置页渲染完整（M5 缺陷）
  Given 默认双实例配置
  When 打开设置页
  Then h3×3（数据源实例/按市场与能力选择来源/目录与日历等）+fieldset×2+检查保存放弃按钮组全部存在
```

## 风险与预案

| 风险 | 概率 | 预案 |
|---|---|---|
| 东财 push2his 未来限流（clist 先例） | 中 | 预算 30/分+TTL 削峰+腾讯备源即时轨 |
| 美股前缀冷启动猜错 | 低 | suggest 解析重试路径 |
| v5 API 误用（v4 记忆干扰） | 低 | 附录 A typings 为准+client-edge 断言实例方法 |
| vendor 路由冲突 | 低 | 独立命名空间+降级开关 |
| 日/韩/英数据质量 | 中 | 探针门控+"未验证"标（启用前不展示） |
| usSymbols 不持久化: 进程重启后腾讯美股 K线不可用直至重新搜索（东财主源不受影响——默认 105+suggest 重试兜底） | 低 | 声明取舍不持久化（映射可由任意一次搜索重建，持久化收益不抵复杂度）；腾讯美股备源降级为搜索后可用，风险表留档 |
| 腾讯 preClose 索引未决 | ~~低~~ **已实测清零（2026-10-30）**: `qt.{symbol}[4]`=昨收（sz000001 值 11.54 与东财 f18 一致），已实现+夹具断言 |

## 里程碑总览

| 里程碑 | 范围 | 出口条件 |
|---|---|---|
| M1 后端管道 | kline 能力全链（schema→market-model→缓存→双适配器→接线→HTTP） | npm test 全绿+真实拉取沪深/港/美各一证券对齐 |
| M2 前端图表 | vendor 装载+KlineView+详情重构 | 全绿+browser-fixture 断言+dev-browser 截图验收 |
| M3 分时 | trend 管道+渲染 | 全绿+截图验收 |
| M4 多市场 | 八市场+搜索放宽+端到端 | 全绿+三市场端到端截图+日韩英探针证据回填 |
| M5 缺陷修复 | 撤销横幅+设置页渲染两根因 | 复现测试转绿+全绿 |

依赖: M2/M3 依赖 M1；M4 与 M1-M3 可并行；M5 独立可穿插。

## M1 后端管道

### Step 1.1 schemas.mjs — 枚举与守卫
- [x] `capability` 枚举 +`'kline'`
- [x] 抽取 `marketSchema` 导出（八市场），routeSchema/securitySchema 引用同源
- [x] 备源守卫放宽: `['quotes','kline'].includes(r.capability)` 才允许 fallback/failoverMode!=='off'
- [x] `endpointsSchema` 并入 providerSchema（z.record URL）
- [x] `klineQuerySchema` 导出（securityId/period 枚举/limit 20..1000 默认 250）
- [x] defaultConfig: em-default `capabilityLimits` +`{ kline: 30 }`
- 测试（schemas.test.mjs）: 八市场逐一过 routeSchema 构造；XAMEX 拒绝；kline 路由带 fallback 通过守卫、catalog 路由带 fallback 仍拒；endpoints 非法 URL 拒；klineQuerySchema limit 默认 250/越界拒
- RED 顺序: 先写测试（引用未导出的 marketSchema/klineQuerySchema 编译失败即 RED）→ 实现 → GREEN

### Step 1.2 market-model.mjs — MARKET_META 派生
- [x] `MARKET_META` 常量导出（八市场 currency/timezone/priceScale/codePattern，见设计"schema 扩展（五处联动）"节 MARKET_META 代码块）
- [x] securitySchema: currency→string、timezone→string、priceScale→number，superRefine 对照 MARKET_META 校验一致
- [x] makeSecurity: 币种/时区/精度从 MARKET_META 派生（签名不变）
- [x] 新增 `parseSecurityId(id)` 导出: split(':') 解析 + codePattern 校验，非法抛 fail('INVALID_PARAM')
- 测试（market-model.test.mjs 新建）: 港股 00700 构造（HKD/Asia/Hong_Kong/2）、美股 AAPL（USD/^[A-Z]{1,5}$/）、日股 7203（JPY/0 位）构造与校验通过；沪深既有值断言不变（无迁移）；codePattern 违反（XHKG:equity:ABC）拒绝；parseSecurityId 正反例
- 回归: 既有 catalog/collector 测试不动应全绿（派生值兼容验证）

### Step 1.3 kline-cache.mjs — 新建
- [x] `createKlineCache({ cacheTable, now })` → get/put/invalidate
- [x] key `kline:{instanceId}:{market}:{period}:{code}`；value 套 cache 表壳 `{kind:'kline', source, fetchedAt, payload:{candles,preClose,complete,routingRevision}}`
- [x] TTL 表（引用"数据结构-kline 缓存"节唯一事实源）: put 时 TTL=0（trend）直接跳过写入
- [x] get: 过期/routingRevision 不符/JSON 损坏→null+异步删除；invalidate(keyParts): 删指定条目（强刷消费点）
- 测试（kline-cache.test.mjs 新建）: 命中（payload 原样返回）；过期 1ms 边界；版本不符 miss；损坏条目 miss 且后台删除不抛；trend TTL=0 put 后 get 仍 miss（未写入）；invalidate 后 get miss
- 固定时钟注入（now 参数）驱动 TTL 断言

### Step 1.4 eastmoney.mjs — kline 主源
- [x] descriptor: capabilities +`'kline'`，markets 八市场
- [x] `SECID_PREFIX` 常量表；美股 mktNum 从 ctx.usSymbols 读（miss→105+重试路径）
- [x] kline(): trend→trends2（fields2=f51-f58，avg 列→candles[].avg，preClose=data.preClose）；1d/1w/1M→push2his（fields2=f51-f57 固定 7 列，**f52=open/f53=close/f54=high/f55=low**，preClose=data.preKPrice，lmt=limit，fqt=1）
- [x] CSV 解析: split(',') 列数<7→BAD_PAYLOAD；升序校验（重复→BAD_PAYLOAD）；parseFloat
- [x] data:null→美股 suggest 解析（ctx.fetch 直连 searchapi）重试一次→NO_DATA；非美股 null 直接 NO_DATA
- 测试（public-providers.test.mjs）: 八市场 secid 映射表断言；7 列 CSV 解析（夹具固定串）；data:null→重试→成功（fetch 计数=2）；data:null×2→NO_DATA；trend 8 列含 avg；preKPrice 提取；乱序/重复 BAD_PAYLOAD；usSymbols stub 注入 miss→默认 105；complete=false（dktotal<lmt 夹具）

### Step 1.5 tencent.mjs — kline 备源（扩展既有文件）
- [x] descriptor: capabilities +`'kline'`，markets +XHKG/XNAS/XNYS
- [x] symbolOf 内联三元重构为 `SYMBOL_PREFIX` 查表（quotes 共用，防漂移）；美股 `us{code}.{suffix}`（suffix=JYS_TO_SUFFIX 映射取 usSymbols.jys；无映射→UNSUPPORTED_CAPABILITY）
- [x] kline(): URL param=`{symbol},{day|week|month},,,{limit},qfq`，Referer gu.qq.com；键名兜底 `Object.values(data[symbol]).find(Array.isArray)`；行数组 parseFloat；升序校验
- [x] preClose 从 `data.{symbol}.qt.{symbol}` 提取 + AMEX 腾讯符号形态——**本步首任务：真实拉取实测（qt 字段族索引/JYS=AMEX 候选的腾讯符号），回填设计文档"实测证据基线-数据端点"表**（未决项清零）；preClose 提取失败→缺省（合同可空）
- [x] period='trend'→UNSUPPORTED_CAPABILITY
- 测试: 三市场映射；键名漂移兜底（夹具只给 qfqday 键）；trend 拒绝；字符串数值 parseFloat；美股无映射拒绝文案；JYS_TO_SUFFIX 映射断言

### Step 1.6 接线层 — registry/executor/application/routes
- [x] provider-registry.mjs: 能力白名单数组 +`'kline'`
- [x] executor.mjs: createExecutor 签名 +`usSymbols`，ctx 注入只读引用（一行透传）
- [ ] application.mjs: usSymbols Map；search() 东财候选写 usSymbols（MktNum→mktNum+JYS→jys，TTL 24h）+候选项按 MARKET_META 附带 currency/priceScale；kline() 按设计"application 接线"节伪代码（缓存链查询→runWithFailover 即时轨→非 trend 缓存写实际源）；runWithFailover 私有函数；snapshot() +klineReady/vendorAvailable
- [x] routes.mjs: `kline: ['GET', (input, signal) => app.kline(input, signal)]`
- 测试（routes.test.mjs/application 相关）: 无路由 422（router 自抛语义）；缓存命中 executor 计数不变+fetchedAt=缓存时间；备源链缓存命中（主源 miss+备源 hit）；runWithFailover 主源 NETWORK→备源成功 source=备源；全败抛最后一错；RATE_LIMIT 不触发 failover；search 后 usSymbols 命中（适配器收到非空 Map）+候选含 currency/priceScale；klineReady 只含已配市场；400 校验（period 非法/limit 越界）

### Step 1.7 M1 出口
- [x] npm test 全绿（75 旧+37 新，实际 112/112）
- [x] 真实拉取矩阵（唯一执行点，标记 `test('real', { skip: 无网 })`）: 沪深（000001）/港（00700）/美（AAPL）日K 各 3 条双源对齐 ±0.01+腾讯 preClose/AMEX 符号实测回填——证据记入兼容性测试文档
- [x] 设计文档未决项（腾讯 preClose 索引/AMEX 腾讯符号）清零确认

## M2 前端图表

### Step 2.1 vendor 落地
- [ ] `npm i lightweight-charts@5.2.1`（package.json dependencies）
- [ ] `vendor/lightweight-charts.standalone.production.js` 从 node_modules/dist 手动复制（manifest 测试防漂移，无需专用脚本）
- 测试（manifest.test.mjs）: vendor 文件存在+大小 <300KB+包版本一致

### Step 2.2 vendor 路由完整实现
- [ ] index.js: webServer.register prefix 路由+serveVendor（白名单/Content-Type/Cache-Control/读异常 404/注册异常 vendorAvailable=false）一次完成
- 测试: 200 头断言/白名单外 404/注册冲突降级 vendorAvailable=false

### Step 2.3 client.js — KlineView
- 实施规格唯一来源=设计"client 详情重构"节十步数据流+"主题适配"节 readChartTheme（本步骤不复制规格，按节实施）
- 测试（client-edge.test.mjs）: ensureLwc 幂等（二次调用不注入）/reject 文案/MA 数值断言（夹具 5 根蜡烛 MA5 第 5 值精确）/colorMode 映射（green-up→up=绿）/klineReady 置灰传播/降级渲染数字详情/vendorAvailable=false 无 script 注入

### Step 2.4 详情页重构
- [ ] 宽屏 detail 全页单列（`.ssb-view-detail` 钩子扩 grid-template-columns）
- [ ] 头部条（名称/代码/市场币种徽标/现价涨跌）+左右分栏（K线 flex+字段栏 240px）+<720px 折叠
- [ ] 周期按钮组/spinner/错误条/骨架/空态（文案按设计"文本定稿"表）
- 验收: dev-browser 真实宿主截图（沪深/港/美各一）→ 用户视觉确认

## M3 分时（trend 管道已归 Step 1.4，本里程碑仅渲染与验收）

### Step 3.1 client 分时渲染
- [ ] AreaSeries+avg LineSeries+createPriceLine 昨收虚线+timeVisible（设计"client 详情重构"节第 6 步）
- [ ] trend↔K线 series 重建路径（类型不同 removeSeries+addSeries）
- 验收: 真实拉取 000001 trend 断言（首元素 09:30/含 avg/preClose 一致）+dev-browser 截图（分时含均价线+昨收虚线）→ 用户确认

## M4 多市场

### Step 4.1 适配器市场扩展验收
- [ ] eastmoney: 港美 ulist 解析断言（夹具 f12-f18 字段族）
### Step 4.3 search 放宽
- [ ] eastmoney.search: Classify 集合按请求 markets 参数过滤（沪深/HKStock/US）
- 测试: 夹具候选含 00700；MktNum→usSymbols 写入计数
### Step 4.4 client 多市场 UI + kline 路由配置入口
- [ ] 搜索市场选择器/候选徽标/列表徽标列/详情一体徽标（文案按设计"文本定稿"表）
- [ ] 设置页"一键为已启用市场配置K线"按钮: 对 enabledByDefault 且探针通过的市场逐一生成 (market,'kline') 路由草稿（主源 em-default/备源 tencent 支持市场）→走既有"检查→保存"合同；已存在 kline 路由的市场跳过
- 测试: 夹具双实例下按钮生成 N 条草稿断言/检查失败拦截/保存后 klineReady 布尔翻转；BDD 场景"kline 路由一键配置"
### Step 4.5 端到端（dev-browser 真实宿主）
- [ ] 沪深+港+美各一证券: 搜索→添加→行情→四周期 K线全流程截图→用户验收
### Step 4.6 日/韩/英探针
- [ ] 逐市场真实 kline 拉取验证（176.7203/177.005930/155.TYT 等）
- [ ] 探针验证状态归属: market-model `MARKET_META[market].verifiedByDefault`（沪/深/港/美 true，日/韩/英 false——静态常量非运行时状态，探针通过后随代码改 true 交付）；router/设置检查按该标志拦截未验证市场的 kline 路由保存（CHECK_REQUIRED）+UI"未验证"标读取 snapshot 下发的 meta 摘要
- [ ] 证据回填设计文档证据表；通过后将该市场 verifiedByDefault 改 true（独立 commit）；未通过保持 false 标"未验证"

## M5 缺陷修复

### Step 5.1 撤销横幅时序
- [ ] 根因定位（第一期复现: 删除后横幅未及显示即消失——疑 snapshot 回刷冲 undo state 或 until 判定）
- [ ] 修复+测试: 删除后 500ms 内快照回刷横幅仍在；8s 后消失；撤销恢复
### Step 5.2 设置页渲染中断
- [ ] 根因定位（第一期复现: 默认双实例设置页渲染止于实例 fieldset，h3×3/按钮组缺失，无 console 错误）
- [ ] 修复+测试: 默认配置打开设置页全部节点存在断言
### Step 5.3 出口
- [ ] npm test 全绿+隔离宿主回归一遍第一期验收路径（浏览/加自选/别名不受 M1-M4 改动破坏）

## 交付清单

- [ ] 全部里程碑出口条件达成
- [ ] 设计文档"未决项"全部清零（腾讯 preClose 索引/日韩英探针证据）
- [ ] README 功能表更新（K线/多市场）
- [ ] 兼容性测试文档补真实拉取矩阵与端到端证据
- [ ] 版本号+CHANGELOG（structure-and-release.md 流程）
- [ ] 提交拆分: M1/M2+M3/M4/M5 各一 commit（可回溯）

## 附录 A: 参考目标来源（全部实证）

| 项 | 来源 |
|---|---|
| lightweight-charts v5.2.1 API | npm pack 解包 dist/typings.d.ts（createChart L212/addSeries L1640/CandlestickData L837/导出常量 L5036/CrosshairMode L35） |
| lightweight-charts v5.2.1 UMD 交付形态 | npm pack 解包 dist/lightweight-charts.standalone.production.js 实存 197922 字节（<300KB 断言数据源） |
| 宿主 webServer prefix 路由 | dsh-host-webserver lib/types/index.d.ts L31-32: `WebRouteKind = 'exact' \| 'prefix'`——prefix 匹配 p 及 p/&lt;anything&gt;，vendor 静态服务前提实证 |
| 韭菜盒子 K线实现 | github raw src/webview/stockTrend.ts（东财 iframe；hk→116/usr_→105 映射） |
| 韭菜盒子涨跌色配置 | github API contents package.json（riseColor/fallColor/stockKLineChartSwitch） |
| 韭菜盒子腾讯端点 | github raw src/shared/tencentStock.ts（qt.gtimg.cn GBK/smartbox search） |
| 东财 secid 全表 | 会话实测 push2his 逐前缀扫描+searchapi MktNum 反查 |
| 东财 h5chart 交互 | dev-browser 实页截图 em-h5chart.png（周期段/头部条格式/分时双轴/量副图） |
| 既有插件合同 | packages/dsh-stock-assistant/src/*（executor 滑动超时/schemas 枚举/state cache 壳/routes 模式/router.select 语义） |
| 东财 CSV fields2 列数关系 | 会话实测 f51-f57→7 列/f51-f61→11 列对照 |
| 腾讯 qt 字段族 preClose 索引 | 2026-10-30 实测 web.ifzq fqkline 响应 `qt.{symbol}[4]`=昨收（sz000001→11.54 与东财 f18 一致；[3]=现价/[5]=今开） |
| 腾讯美股后缀形态 | 2026-10-30 实测: .OQ/.N/裸代码三者同价有效（SPY 769.36 一致）；.A/.U 返回空数据——JYS_TO_SUFFIX={NASDAQ:OQ,NYSE:N,AMEX:''裸代码} |
| M1 真实拉取矩阵 | 2026-10-30 跨源对齐: 600519 EM 1392.05/000001 EM=TX 11.64/00700 EM=TX 383.6/AAPL 348.91（±0.01 达标） |
