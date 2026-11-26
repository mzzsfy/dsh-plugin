import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

// 纯函数有牙, 但调用点是裸奔的: 上一轮做了 30 个变异, 把下面这些接线改回坏写法, 全量测试仍然全绿。
// 这些 bug 都已经真实发生过一次, 所以用结构断言把它们钉住——宁可脆弱, 也不要第二次静默回归。
const client = await readFile(new URL('../src/client.js', import.meta.url), 'utf8')

const count = re => [...client.matchAll(re)].length
const must = (re, why) => assert.match(client, re, why)
const mustNot = (re, why) => assert.doesNotMatch(client, re, why)

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

test('代际淘汰的请求不许落地, 退避到点也要再查一次', () => {
  // 失败分支先查代际再查 key, 否则旧请求的失败会覆盖新请求已经写好的数据
  assert.ok(count(/if \(seq !== klineSeq\) return undefined/g) >= 2, '成功与失败两条路径都要查代际')
  must(/if \(state\.klineKey !== key\) throw e/, '切走之后不该再为废弃的 key 落错误')
  // 退避等待期间可能已经有同 key 的新请求, 到点了就不能再打一枪
  must(/klineDelay\(delayMs\)\.then\(\(\) => \{[\s\S]{0,200}seq !== klineSeq/, '退避到点前必须查代际')
  must(/klineSeq\+\+;[\s\S]{0,400}klineRetryTimers/, 'dispose 要递增代际并清掉退避定时器')
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
  must(/if \(period !== 'trend' && state\.klineKey !== key\) return/, '灌日周月数据前必须校验 key')
  // 分时量是每分钟增量, 取末条会让图例只剩一分钟
  must(/candles\.reduce\(\(sum, candle\) => sum \+ \(finiteOr\(candle\.volume\) \|\| 0\), 0\)/, '分时量必须累计整段')
  // 缺 avg 的分钟线要回退收盘价, 否则均价线断线
  must(/value: c\.avg \?\? c\.close/, '缺 avg 必须回退收盘价')
  must(/const axisTime = trendAxis\(result\.candles\)/, '横轴必须优先用行情自带时间')
  must(/return \(candle, index\) => candle\.at \?\? base \+ index \* 60/, '缺 at 时退回「当天零点 + 分钟偏移」')
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
  // 键集一致只保证调用与解构对齐; 参数被解构却没在函数体里用, 行为会静默消失(这个错漏到过线上)
  const body = /function useFloatingPolling\(\{([^}]*)\}\)\s*\{([\s\S]*?)\n    \}\n/.exec(client)
  assert.ok(body, '必须能定位 useFloatingPolling 的函数体')
  for (const key of keysOf(body[1])) {
    if (key === 'runtime' || key === 'setFetched' || key === 'setError') continue
    assert.ok(new RegExp(`\\b${key}\\b`).test(body[2]), `参数 ${key} 解构后必须在函数体里被用到`)
  }
  // 暂停必须同时出现在守卫与依赖里: 只加守卫不改依赖, 暂停后定时器还在跑
  assert.match(body[2], /if \(!open \|\| !picked\.length \|\| live === false \|\| paused\) return/, '暂停必须进轮询守卫')
  assert.match(body[2], /\}, \[[^\]]*\bpaused\b[^\]]*\]\)/, '暂停必须在 effect 依赖里')
})

test('标记线重涂按建线时记下的种类换色', () => {
  // 曾经重涂读 liveRef.marks(从未写入), 切主题后成本线与卖价线同色
  must(/markLinesRef\.current = \(list \|\| \[\]\)\.map\(mark => \(\{\s*kind: mark\.kind,/, '建线时必须记下种类')
  must(/for \(const \{ kind, line \} of markLinesRef\.current\) line\.applyOptions\(\{ color: kind === 'target'/, '重涂必须按记录的种类取色')
  mustNot(/liveRef.current.marks/, '重涂不得回读从未写入的 marks')
})

test('量副图两种形态都建, 量均线挂在量副图那一栏', () => {
  // 分时的分钟量原先只存在于十字线读数里, 图上没有柱; 只给蜡烛建量副图等于分时永远没有量
  must(/volRef\.current = chart\.addSeries\(LWC\.HistogramSeries[^\n]*\}, 1\)\n\s*if \(wantTrend\)/, '量副图必须建在形态分支之前, 两种形态共用')
  must(/mavol: MAVOL_WINDOWS\.map\(\(n, i\) => chart\.addSeries\(LWC\.LineSeries, \{[^}]*\}, 1\)\)/, '量均线必须挂 pane 1, 与量柱同轴')
  // 量柱数据只能有一个产出点: 首灌与重涂各写一套会在换主题后量柱与量均线错位
  must(/volRef\.current\?\.setData\(volumeBarPoints\(/, '量柱必须走统一产出函数')
  must(/if \(indicatorValues && guides\.mavol\) MAVOL_WINDOWS\.forEach/, '量均线开关必须接到图例')
  must(/if \(info\.guides\?\.mavol\) MAVOL_WINDOWS\.forEach/, '量均线开关必须接到十字线读数')
})

test('悬浮窗拖动只从标题条发起', () => {
  // touch-action 是路径交集: 父级 none 会废掉子元素的 pan-y, 列表就滚不动
  must(/closest\('\.ssb-float-head'\)/, '拖动必须限定标题条')
  must(/\.ssb-float \{ touch-action:pan-y; \}/, '容器要放行纵向手势')
  must(/\.ssb-float-head \{ touch-action:none;/, '标题条独占拖动')
})

test('分组 tab 的保留键不会与用户标签名撞车', () => {
  // 标签名来自用户输入且只校验长度, 拿名字当 tab 键的话, 用户建一个叫「全部」的标签就会顶掉保留 tab
  must(/ALL_TAB_KEY = ['"]\\u0000/, '全部 tab 的键必须带不可见前缀')
  must(/REST_TAB_KEY = ['"]\\u0000/, '未分组 tab 的键必须带不可见前缀')
  must(/key: ALL_TAB_KEY/, '全部 tab 必须用特殊键')
  must(/key: REST_TAB_KEY/, '未分组 tab 必须用特殊键')
  assert.deepEqual([...client.matchAll(/key: (['"])(全部|未分组)/g)], [], '不能拿中文 label 当 tab 键')
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

test('全屏浮层层级高于宿主侧栏拖拽手柄', () => {
  // 宿主 0.2.2-rc.1 的侧栏手柄(.pI_x6G_handle, 类名哈希随宿主构建变) z-index 11 且横贯整屏;
  // 浮层更低时设置弹窗与详情抽屉横穿一条不可点带, 落在带内的下拉点了没反应
  // (2026-11-12 实测: 悬浮盯盘刷新下拉中心命中手柄). 文本断言只能防插件侧回退, 宿主改层级要靠兼容性测试兜底.
  const overlay = /\.ssb-overlay\s*\{[^}]*z-index:\s*(\d+)/.exec(client)
  assert.ok(overlay, '浮层必须显式声明层级')
  assert.ok(Number(overlay[1]) > 11, `浮层层级 ${overlay[1]} 必须高于宿主手柄 11`)
})

test('数据源保存声明保留路由草稿, 路由页保存提交整份草稿', () => {
  // 数据源页只提交实例: 若调用处不声明 keepRoutes, 市场/能力页里改了一半的路由会被整份草稿清空
  must(/runtime\.configuration\(providersOnly, \{ keepRoutes: true \}\)/, '数据源页保存必须声明保留路由草稿')
  must(/runtime\.configuration\(routesOnly\)/, '路由页保存提交整份草稿')
})
