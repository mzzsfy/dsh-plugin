import { fail } from './market-model.mjs'
const TTL = 90 * 1000
export function createDemand(changed = () => {}, now = Date.now, timers = globalThis) {
  const pages = new Map()
  let timer, stopped = false
  const clean = () => {
    for (const [id, p] of pages) {
      if (p.active && p.until <= now()) { p.active = false; p.until = now() + TTL }
      else if (!p.active && p.until <= now()) pages.delete(id)
    }
  }
  const active = () => { clean(); return [...pages.values()].some(p => p.active) }
  function arm() {
    timers.clearTimeout(timer)
    if (stopped || !pages.size) return
    const wait = Math.max(1, Math.min(...[...pages.values()].map(p => p.until)) - now())
    timer = timers.setTimeout(() => { clean(); changed(); arm() }, wait); timer?.unref?.()
  }
  return {
    active,
    update(message) {
      if (stopped || !message || typeof message.pageId !== 'string' || !/^[\da-f-]{36}$/i.test(message.pageId) || !Number.isSafeInteger(message.generation) || message.generation < 1 || typeof message.active !== 'boolean') return
      clean()
      const old = pages.get(message.pageId)
      if (old && old.generation >= message.generation) return
      if (!old && pages.size >= 512) fail('DEMAND_LIMIT', '页面需求数量超过上限', 429)
      if (message.active && !old?.active && [...pages.values()].filter(p => p.active).length >= 256) fail('DEMAND_LIMIT', '活跃页面数量超过上限', 429)
      pages.set(message.pageId, { generation: message.generation, active: message.active, until: now() + TTL })
      changed(); arm()
    },
    dispose() { stopped = true; timers.clearTimeout(timer); pages.clear() },
  }
}
