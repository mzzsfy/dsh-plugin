import { createHash } from 'node:crypto'
import { domainSpec, cacheDomainSpec, initialControl, controlSchema } from './schemas.mjs'
import { fail } from './market-model.mjs'
const DAY = 24 * 60 * 60 * 1000
export const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export async function openState(storageDomain, changed = () => {}, now = Date.now, warn = () => {}) {
  const domain = await storageDomain.open(domainSpec)
  let cacheDomain
  try { cacheDomain = await storageDomain.open(cacheDomainSpec) } catch (e) { await domain.close(); throw e }
  const table = domain.table('control'), cache = cacheDomain.table('cache')
  try {
    // 存量字段改名的归一发生在数据域的 valueSchema 上(storageDomain.open 阶段), 这里读到的已是新格式
    if (!table.get('root')) {
      // 记录缺失说明宿主的校验把坏记录备份成 *.bak.<时间戳> 后跳过了。此时只能按空自选跑起来,
      // 但必须在日志里留下恢复线索, 否则用户的自选会无声消失。
      warn('股票工具：权威记录 control/root 缺失，已按空自选初始化；若不是首次使用，请从数据目录的 control/root.json.bak.* 恢复')
      await table.put('root', initialControl())
    }
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
