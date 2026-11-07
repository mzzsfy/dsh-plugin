import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

// 纯函数有牙, 但调用点是裸奔的: 上一轮做了 30 个变异, 把下面这些接线改回坏写法, 全量测试仍然全绿。
// 这些 bug 都已经真实发生过一次, 所以用结构断言把它们钉住——宁可脆弱, 也不要第二次静默回归。
const client = await readFile(new URL('../src/client.js', import.meta.url), 'utf8')

const count = re => [...client.matchAll(re)].length
const must = (re, why) => assert.match(client, re, why)
const mustNot = (re, why) => assert.doesNotMatch(client, re, why)

test('悬浮窗读交易时段要走 quote 那一层', () => {
  // quotes[id] 的形状是 { quote, health }, 读成 quotes[id].sessionState 会让「全部收市降频」恒不成立
  must(/\?\.quote\?\.sessionState/, '必须quotes[id].quote.sessionState')
  mustNot(/\?\.sessionState\b(?!)/, '不能直接读 quotes[id].sessionState')
})

test('建图补灌走 fillRef, 不用首帧闭包', () => {
  // 建图 effect 空依赖, 直接调 maybeFill 会用到首帧那份, 建图期间的周期/辅助线/成本全部滞后
  must(/fillRef\.current\?\.\(/, '建图回调必须经 fillRef 转发')
  mustNot(/^\s*maybeFill\(early/m, '建图回调不能直接调 maybeFill')
  must(/fillRef\.current = maybeFill/, '每帧都要更新 fillRef')
  must(/liveRef\.current = \{[^}]*period/, 'liveRef 必须带上当前周期')
})

test('重涂按主序列形态选键名, 成交量按当前蜡烛重灌', () => {
  // 面积序列用 lineColor/topColor/bottomColor, 蜡烛用 up/down; 成交量只认逐柱 color
  must(/seriesPaintPlan\(t, !!avgRef\.current\)/, '必须按已建序列判断形态, 不能用首帧的 wantTrend')
  must(/volRef\.current\?\.setData\(/, '成交量不会响应系列级配色, 必须重灌数据')
  must(/repaintChart\(readChartTheme\(/, 'MutationObserver 必须调 repaintChart')
})

test('收市档既省额度又能自愈', () => {
  // 面板不在前台时宿主会 cancelIdle, 只读快照会一直停在旧数据上
  must(/const readOnly = allClosed && tick % \d+ !== 0/, '收市档必须隔若干拍插真刷新')
  must(/floatPollUrl\(readOnly\)/, 'URL 必须由 floatPollUrl 决定')
})

test('代际淘汰的请求不许落地, 退避到点也要再查一次', () => {
  // 失败分支先查代际再查 key, 否则旧请求的失败会覆盖新请求已经写好的数据
  assert.ok(count(/if \(seq !== klineSeq\) return undefined/g) >= 2, '成功与失败两条路径都要查代际')
  must(/if \(state\.klineKey !== key\) throw e/, '切走之后不该再为废弃的 key 落错误')
  // 退避等待期间可能已经有同 key 的新请求, 到点了就不能再打一枪
  must(/setTimeout\(resolve, delayMs\)\)\.then\(\(\) => \{[\s\S]{0,200}seq !== klineSeq/, '退避到点前必须查代际')
  must(/setKlineError\(item\.id, liveRef\.current\.period/, '报错要用当前周期, 不是首帧的')
})

test('K 线数据落 state 前必须清洗', () => {
  must(/const candles = sanitizeCandles\(result\?\.candles\)/, '成功分支必须走 sanitizeCandles')
  // 分时的昨收不能退回前一根分钟收盘, 那会算出个假的 0.0x% 涨跌
  must(/finiteOr\(kline\?\.preClose\) \|\| \(wantTrend \? NaN :/, '分时不得回退前一根收盘')
  // 指标与蜡烛可能不同代, 越界取 time 会抛 TypeError
  must(/value == null \|\| !candles\[i\] \? null/, 'toPoints 必须防越界')
})

test('单只标的时不循环到自己', () => {
  // picked 只有一只时 next 就是自己, 清掉 trend 会让图空转到下一拍
  must(/if \(next && next !== securityId\) \{ setTrend\(null\)/, '单只时不该清 trend')
})

test('事件处理器不许把 React 事件当业务参数透传', () => {
  // onClick: quiet(runtime.refresh) 会把 SyntheticEvent 当成 securities 发给宿主, 序列化时循环引用
  mustNot(/onClick: quiet\(runtime\.[a-zA-Z]+\)/, 'handler 必须包一层, 不能直接透传 runtime 方法')
  must(/onClick: quiet\(\(\) => runtime\.refresh\(\)\)/, '刷新按钮必须包一层')
})

test('悬浮窗拖动只从标题条发起', () => {
  // touch-action 是路径交集: 父级 none 会废掉子元素的 pan-y, 列表就滚不动
  must(/closest\('\.ssb-float-head'\)/, '拖动必须限定标题条')
  must(/\.ssb-float \{ touch-action:pan-y; \}/, '容器要放行纵向手势')
  must(/\.ssb-float-head \{ touch-action:none;/, '标题条独占拖动')
})

test('分组折叠的特殊键不会与用户组名撞车', () => {
  // 组名来自用户输入且只校验长度, 拿 '__pinned' 当键的话, 用户真建一个叫 __pinned 的组就会互相顶掉
  must(/const PINNED_KEY = '\\u0000pinned', REST_KEY = '\\u0000rest'/, '特殊折叠键必须带不可见前缀')
  mustNot(/section\('__pinned'|section\('__rest'/, '不能用可输入的名字当特殊键')
})

test('本地存储只经两个封装, 且不接受就地字面量', () => {
  const hits = [...client.matchAll(/(?:local|session)Storage\b(\.[A-Za-z]+|\[[^\]]*\])?/g)].map(m => m[0]).sort()
  assert.deepEqual(hits, ['localStorage.getItem', 'localStorage.setItem'])
  assert.deepEqual([...client.matchAll(/(?:readPref|writePref)\(\s*['"]/g)], [])
})
