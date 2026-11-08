import { createHash } from 'node:crypto'
import { domainSpec, initialControl, controlSchema } from './schemas.mjs'
import { fail } from './market-model.mjs'
const DAY = 24 * 60 * 60 * 1000
export const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export async function openState(storageDomain, changed = () => {}, now = Date.now) {
  const domain = await storageDomain.open(domainSpec)
  const table = domain.table('control'), cache = domain.table('cache')
  try {
    if (!table.get('root')) await table.put('root', initialControl())
    controlSchema.parse(table.get('root'))
  } catch (e) { await domain.close(); throw e }
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
    async close() { stopped = true; await tail; await domain.close() },
  }
}
