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
  must(/\bfetched\?\.\[id\]\?\.quote\b/, '自己的快照要经 quote 层')
  must(/\bquotes\?\.\[id\]\?\.quote\b/, '面板的快照也要经 quote 层')
  assert.deepEqual([...client.matchAll(/quotes\?\.\[[^\]]+\]\?\.sessionState/g)], [], 'quotes[id] 必须再进一层 quote')
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

test('轮询决策走纯函数, 不散落在分支里', () => {
  // 决策一旦写成 if 分支就只能靠文本断言, 而文本分辨不出「死代码」与「分支执行」.
  // 抽成 pollPlan 后由 groups.test 直接断言各分支, 这里只钉住调用点
  must(/const plan = pollPlan\(\{ mode, quiet: allQuiet, tick \}\)/, '拉取前必须由 pollPlan 决定这一拍做什么')
  must(/if \(plan === 'skip'\) return/, 'skip 必须真的跳过')
  must(/plan === 'refresh'/, 'refresh 分支必须存在')
  must(/plan === 'snapshot'/, 'snapshot 分支必须存在')
  must(/if \(beat\) return 'refresh'/, '整十拍无条件真刷新, 否则时段翻不过来')
  must(/return quiet \? 'skip' : 'trend'/, '安静档跳过, 否则打分时')
})

test('收市判断按 receivedAt 取最新的一份', () => {
  // 无条件偏爱自己那份会让它变成单向闩锁: 一旦写成 trading, 面板的新鲜 closed 也压不过它
  must(/const stateOf = id => pickNewest\(fetched\?\.\[id\]\?\.quote, quotes\?\.\[id\]\?\.quote\)/, '推广两份必须经同一个择优函数')
  must(/function pickNewest|const pickNewest =/, '择优逻辑只能有一份实现')
  assert.equal(count(/pickNewest = /g), 1, 'stateOf 与 entryOf 必须共用同一份平局规则')
})

test('图形模式收市后不许再打 trend 上游', () => {
  // trend 端点不进缓存, 每次都是真上游. 行为由 groups.test 的 pollPlan 用例断言,
  // 这里只确认 trend 的唯一出口确实受 plan 控制(而不是另有旁路)
  assert.equal(count(/period: 'trend'/g), 1, 'trend 只应有一个请求点')
  const trendCall = client.slice(client.indexOf("period: 'trend'") - 260, client.indexOf("period: 'trend'"))
  assert.match(trendCall, /else if \(securityId\)/, 'trend 必须在 plan 的 else 分支里')
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

test('灌图的五处决策都落在调用点上', () => {
  // 手动刷新要保留用户的缩放: 恒传 fit 会把视图拽回去
  must(/maybeFill\(\{ candles: kline\?\.candles \|\| \[\], preClose: kline\?\.preClose \}, plan\.fit\)/, '必须用 plan.fit 而不是恒 true')
  // 切周期当帧旧数据会被灌进新形态, 面积序列拿到 HH:mm 会直接抛 Invalid date
  must(/if \(state\.klineKey !== key\) return/, '灌数据前必须校验 key')
  // 分时量是每分钟增量, 取末条会让图例只剩一分钟
  must(/candles\.reduce\(\(sum, candle\) => sum \+ \(finiteOr\(candle\.volume\) \|\| 0\), 0\)/, '分时量必须累计整段')
  // 缺 avg 的分钟线要回退收盘价, 否则均价线断线
  must(/value: c\.avg \?\? c\.close/, '缺 avg 必须回退收盘价')
  // 没有 at 的市场要靠「区间起点 + 分钟偏移」推横轴, 忽略它会整体偏时区
  must(/const axisTime = \(c, i\) => c\.at \?\? base \+ i \* 60/, '横轴必须优先用行情自带时间')
})

test('单只标的时不循环到自己', () => {
  // picked 只有一只时 next 就是自己, 清掉 trend 会让图空转到下一拍
  must(/if \(next && next !== securityId\) \{ setTrend\(null\)/, '单只时不该清 trend')
})

test('事件处理器不许把 React 事件当业务参数透传', () => {
  // onClick: quiet(runtime.refresh) 会把 SyntheticEvent 当成 securities 发给宿主, 序列化时循环引用
  mustNot(/onClick: quiet\(runtime\./, '不能把 runtime 方法直接交给 onClick')
  must(/onClick: [^,]*runtime\.refresh\(\)/, '刷新按钮必须包一层再调')
})

test('hook 的解构参数与调用处传的键必须一致', () => {
  // 少传一个就是 effect 里的运行时 ReferenceError: React 会把整棵悬浮窗卸掉, 界面表现为凭空消失.
  // node --check 只查语法, 不跑 effect 的静态渲染也发现不了——这个错误真的漏到过一次线上
  const keysOf = text => text.split(',').map(part => part.trim().split(':')[0].trim()).filter(Boolean).sort()
  const calls = [...client.matchAll(/useFloatingPolling\(\{([^}]*)\}\)/g)].map(m => m[1])
  assert.equal(calls.length, 2, '应当只有一处定义与一处调用')
  const [definition, invocation] = calls
  assert.deepEqual(keysOf(invocation), keysOf(definition), '传参键集必须与解构键集完全一致')
  // 参数表里出现的每个键都要在函数体里真的被用到, 反之函数体里读的键必须来自参数或本函数内声明
  const params = client.match(/function useFloatingPolling\(\{([^}]*)\}\)/)[1]
  // 必须锚在参数表上: 函数体里本来就有 fetched 的引用, 拿整个函数体去匹配的话,
  // 「参数表与调用处同时删掉 fetched」仍然会绿——那正是上次事故的形态
  assert.match(params, /\bfetched\b/, '收市判定用的自己的快照必须在参数表里')
  assert.match(params, /\bquotes\b/, '面板那份快照也要能用')
})

test('悬浮窗拖动只从标题条发起', () => {
  // touch-action 是路径交集: 父级 none 会废掉子元素的 pan-y, 列表就滚不动
  must(/closest\('\.ssb-float-head'\)/, '拖动必须限定标题条')
  must(/\.ssb-float \{ touch-action:pan-y; \}/, '容器要放行纵向手势')
  must(/\.ssb-float-head \{ touch-action:none;/, '标题条独占拖动')
})

test('分组折叠的特殊键不会与用户组名撞车', () => {
  // 组名来自用户输入且只校验长度, 拿可输入的名字当折叠键的话, 用户建一个同名组就会互相顶掉
  must(/PINNED_KEY = ['"]\\u0000/, '特殊折叠键必须带不可见前缀')
  must(/section\(PINNED_KEY/, '置顶段必须用特殊键')
  must(/section\(REST_KEY/, '未分组段必须用特殊键')
  assert.deepEqual([...client.matchAll(/section\((['"])(置顶|未分组)/g)], [], '不能拿中文 label 当折叠键')
})

test('本地存储只经两个封装, 且不接受就地字面量', () => {
  const hits = [...client.matchAll(/(?:local|session)Storage\b(\.[A-Za-z]+|\[[^\]]*\])?/g)].map(m => m[0]).sort()
  assert.deepEqual(hits, ['localStorage.getItem', 'localStorage.setItem'])
  assert.deepEqual([...client.matchAll(/(?:readPref|writePref)\(\s*['"]/g)], [])
})

test('标记价提醒必须经通知插件桥接, 铃铛是唯一开关', () => {
  // 装了通知插件却自己闪/弹, 等于无视用户在通知插件里的开关与专注静默
  must(/window\.__dshNotify/, '必须探测跨插件通知入口')
  must(/deliverMarkAlert\(\{ alert: markAlertText\(/, '触发点必须走统一分发')
  must(/const verdict = markAlertOf\(\{ mark, price, prev: prev\.side, lastFiredAt: prev\.at, now \}\)/, '穿越判定只有一处实现')
  must(/ssb-float-bell/, '开关是悬浮窗底部的铃铛')
  must(/price = finiteOr\(quoteOf\(id\)\?\.last\)/, '停牌没有 last 时不能 Number(null) 成 0')
  mustNot(/readPref\(FLOAT_KEY[^)]*\)\.open \? '关闭悬浮盯盘'/, '悬浮盯盘不再藏在更多菜单里')
})

test('悬浮盯盘入口在主导航', () => {
  must(/floating\.open \? '收起盯盘' : '悬浮盯盘'/, '主操作行必须有盯盘开关')
  must(/const \[floating, setFloating\] = usePref\(FLOAT_KEY, FLOAT_DEFAULT\)/, '入口要跟着真实偏好走')
})
