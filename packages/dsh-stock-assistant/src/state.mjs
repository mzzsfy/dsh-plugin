import { createHash } from 'node:crypto'
import { domainSpec, cacheDomainSpec, initialControl, controlSchema } from './schemas.mjs'
import { fail } from './market-model.mjs'
const DAY = 24 * 60 * 60 * 1000
export const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export async function openState(storageDomain, changed = () => {}, now = Date.now) {
  const domain = await storageDomain.open(domainSpec)
  let cacheDomain
  try { cacheDomain = await storageDomain.open(cacheDomainSpec) } catch (e) { await Promise.allSettled([domain.close()]); throw e }
  const table = domain.table('control'), meta = domain.table('meta'), cache = cacheDomain.table('cache')
  const initialized = { schemaVersion: domainSpec.version }
  try {
    // 存量字段改名的归一发生在数据域的 valueSchema 上(storageDomain.open 阶段), 这里读到的已是新格式
    if (!table.get('root')) {
      // meta 在 = 以前确实写出过控制记录: 现在读不出来只可能是记录损坏或版本不认, 宿主会把它当作缺失且不备份,
      // 此时写空就是把自选覆盖掉。停下来让人先看数据目录, 而不是拿可用性换数据。
      if (meta.get('state')) fail('AUTHORITY_LOST', '控制记录读不出来（损坏或版本不认），为避免用空自选覆盖已停止初始化；请检查数据目录 stock_assistant/control/root.json，并保留同目录下的 *.bak.* 与旧版 stock_assistant.json', 503)
      await table.put('root', initialControl())
    }
    // 先写控制记录再打标记: 中途崩溃只会退化成"没有标记", 不会把正常数据误判成损坏
    if (!meta.get('state')) await meta.put('state', initialized)
  } catch (e) { await Promise.allSettled([domain.close(), cacheDomain.close()]); throw e }
  let tail = Promise.resolve(), stopped = false
  return {
    get: () => structuredClone(table.get('root')),
    cache,
    replay(operation) {
      const prior = table.get('root').operations.find(o => o.id === operation.operationId && now() - o.at < DAY)
      if (!prior) return null
      if (prior.hash !== digest({ action: operation.action, payload: operation.payload })) fail('OPERATION_REUSED', '操作标识已用于其他请求', 409)
      return structuredClone(prior.result)
    },
    mutate(operation, transform) {
      const run = async () => {
        if (stopped) fail('STOPPED', '股票工具已停止', 503)
        const current = table.get('root'), hash = digest({ action: operation.action, payload: operation.payload })
        const existing = current.operations.find(o => o.id === operation.operationId && now() - o.at < DAY)
        if (existing) {
          if (existing.hash !== hash) fail('OPERATION_REUSED', '操作标识已用于其他请求', 409)
          return structuredClone(existing.result)
        }
        if (operation.expectedRevision !== current.revision) fail('REVISION_CONFLICT', '数据已被其他页面修改，请重新确认', 409, { revision: current.revision })
        const next = transform(structuredClone(current))
        if (!next || JSON.stringify(next) === JSON.stringify(current)) return { revision: current.revision, unchanged: true }
        next.revision = current.revision + 1
        const result = { revision: next.revision, unchanged: false, ...(next.operationResult || {}) }
        delete next.operationResult
        next.operations = [...current.operations.filter(o => now() - o.at < DAY), { id: operation.operationId, hash, at: now(), result, action: operation.action, payload: operation.payload }].slice(-256)
        try { controlSchema.parse(next) } catch (e) { fail('INVARIANT_VIOLATION', '写入结果违反内部不变式', 500, { cause: e }) }
        try {
          await table.update('root', stored => {
            if (stored.revision !== current.revision) fail('REVISION_CONFLICT', '数据版本已变化', 409)
            return next
          })
        } catch (e) {
          if (e.code === 'REVISION_CONFLICT') throw e
          fail('STORAGE_WRITE_FAILED', '保存失败，原数据未更改', 503)
        }
        changed()
        return result
      }
      const job = tail.then(run); tail = job.catch(() => {}); return job
    },
    async close() {
      stopped = true
      await tail
      // 两个域都要关到底: 一个关失败不该把另一个的已打开占位留在宿主里
      const results = await Promise.allSettled([domain.close(), cacheDomain.close()])
      const failed = results.find(r => r.status === 'rejected')
      if (failed) throw failed.reason
    },
  }
}
