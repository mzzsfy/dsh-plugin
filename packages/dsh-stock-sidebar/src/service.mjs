import { z } from 'zod'
import { fail } from './market-model.mjs'
import { securitySchema } from './schemas.mjs'
const securityId = z.string().regex(/^(XSHG|XSHE):equity:\d{6}$/)
const payloads = {
  add: z.strictObject({ securityId }), remove: z.strictObject({ securityId }),
  restore: z.strictObject({ removeOperationId: z.uuid() }),
  alias: z.strictObject({ securityId, alias: z.string().refine(s => [...s].length <= 30) }),
  pin: z.strictObject({ securityId, pinned: z.boolean() }),
  move: z.strictObject({ securityId, beforeId: securityId.nullable() }),
}
export function createWatchlistService(state, resolveSecurity, now = Date.now) {
  return {
    async execute(operation) {
      const parsed = payloads[operation.action]?.safeParse(operation.payload)
      if (!parsed?.success) fail('INVALID_OPERATION', '自选操作参数无效')
      const p = parsed.data
      return state.mutate(operation, control => {
        const w = control.watchlist, item = w.items[p.securityId]
        const insert = (id, beforeId) => { const index = w.order.indexOf(beforeId); w.order.splice(index < 0 ? w.order.length : index, 0, id) }
        const regionEnd = pinned => w.order.find(id => w.items[id].pinned !== pinned && !w.items[id].pinned) || null
        if (operation.action === 'add') {
          if (item) return control
          if (w.order.length >= 100) fail('LIMIT_REACHED', '最多添加100只自选', 422)
          const security = resolveSecurity(p.securityId)
          if (!security || !securitySchema.safeParse(security).success) fail('CANDIDATE_EXPIRED', '候选已过期，请重新搜索', 409)
          w.items[p.securityId] = { ...security, alias: '', pinned: false }; w.order.push(p.securityId)
        } else if (operation.action === 'restore') {
          const deleted = control.operations.find(o => o.id === p.removeOperationId && o.action === 'remove')
          const restore = deleted?.result.restore
          if (!restore || now() - deleted.at > 8 * 1000) fail('RESTORE_EXPIRED', '撤销已过期，请重新添加', 409)
          if (w.items[restore.item.id]) return control
          if (w.order.length >= 100) fail('LIMIT_REACHED', '自选数量已达上限', 422)
          const restored = restore.item; w.items[restored.id] = restored
          const same = id => w.items[id]?.pinned === restored.pinned
          if (restore.previousId && same(restore.previousId)) {
            const after = w.order.indexOf(restore.previousId) + 1; w.order.splice(after, 0, restored.id)
          } else if (restore.nextId && same(restore.nextId)) insert(restored.id, restore.nextId)
          else insert(restored.id, restored.pinned ? regionEnd(true) : null)
        } else {
          if (!item) fail('NOT_FOUND', '证券已被移除', 404)
          if (operation.action === 'remove') {
            const i = w.order.indexOf(p.securityId)
            control.operationResult = { restore: { item, previousId: w.order[i - 1] || null, nextId: w.order[i + 1] || null } }
            w.order.splice(i, 1); delete w.items[p.securityId]
          } else if (operation.action === 'alias') item.alias = p.alias.trim()
          else if (operation.action === 'pin') {
            if (item.pinned === p.pinned) return control
            w.order = w.order.filter(id => id !== item.id); item.pinned = p.pinned
            insert(item.id, item.pinned ? regionEnd(true) : null)
          } else {
            if (p.beforeId === item.id) return control
            if (p.beforeId && (!w.items[p.beforeId] || w.items[p.beforeId].pinned !== item.pinned)) fail('INVALID_MOVE', '只能在同一置顶区域移动', 422)
            w.order = w.order.filter(id => id !== item.id)
            insert(item.id, p.beforeId || (item.pinned ? regionEnd(true) : null))
          }
        }
        return control
      })
    },
  }
}
