// 股票助手用例:交易时段判定按报价逐笔调用,是 refresh 内最热的纯函数。
// 输入规模取自选表上限量级,覆盖单次 refresh 的判定次数。
import { SCALE } from '../scale.mjs'
import { sessionStateOf } from '../../../packages/dsh-stock-assistant/src/market-model.mjs'

// 交替覆盖沪深与美股,使两个时区各走一半
const EXCHANGES = ['XSHG', 'XNAS']
const NOW = new Date(2026, 10, 11, 10, 30, 0).getTime()
const CALLS = SCALE.quotesPerRefresh

export const cases = [
  {
    name: 'stock/sessionStateOf',
    description: `单次刷新内逐笔判定 ${CALLS} 次`,
    scale: `${EXCHANGES.length} 个时区`,
    iterations: 20,
    setup: () => EXCHANGES,
    run: (exchanges) => {
      let trading = 0
      for (let index = 0; index < CALLS; index += 1) {
        if (sessionStateOf(exchanges[index % exchanges.length], NOW) === 'trading') trading += 1
      }
      return trading
    },
  },
]

export default cases[0]
