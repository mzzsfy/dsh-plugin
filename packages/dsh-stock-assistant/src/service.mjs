import { z } from 'zod'
import { fail, parseSecurityId, MARKET_META } from './market-model.mjs'
import { securitySchema, marksSchema, tagName, MAX_TAGS } from './schemas.mjs'
// 自选身份八市场: parseSecurityId 是唯一事实源(市场/代码形态随 MARKET_META)
const securityId = z.string().refine(v => { try { parseSecurityId(v); return true } catch { return false } })
// 标签输入先归一(trim/去空/去重), 再按存储规则校验: 空白条目等于没填, 不因输入框残留空格就拒绝整次操作
const tagValue = z.string().transform(value => value.trim()).refine(value => tagName.safeParse(value).success, '标签名需为 1-12 字, 不含控制字符')
const tagList = z.array(z.string()).transform(list => [...new Set(list.map(value => value.trim()).filter(Boolean))]).superRefine((list, ctx) => {
  if (list.length > MAX_TAGS) ctx.addIssue({ code: 'custom', message: `每只最多 ${MAX_TAGS} 个标签` })
  for (const tag of list) {
    const result = tagName.safeParse(tag)
    if (!result.success) ctx.addIssue({ code: 'custom', message: result.error.issues[0].message })
  }
})
const payloads = {
  add: z.strictObject({ securityId }), remove: z.strictObject({ securityId }),
  restore: z.strictObject({ removeOperationId: z.uuid() }),
  alias: z.strictObject({ securityId, alias: z.string().refine(s => [...s].length <= 30) }),
  marks: z.strictObject({ securityId, marks: marksSchema }),
  // 标签整组替换: 与 marks 同一语义, 协议面只有一个操作, 不出现半更新的中间态
  tags: z.strictObject({ securityId, tags: tagList }),
  tagRename: z.strictObject({ from: tagValue, to: tagValue }),
  tagRemove: z.strictObject({ tag: tagValue }),
  pin: z.strictObject({ securityId, pinned: z.boolean() }),
  move: z.strictObject({ securityId, beforeId: securityId.nullable() }),
  // 拖拽排序: 提交完整显示序, 前端算好顺序一次落库, 避免逐行 move 的中间态
  reorder: z.strictObject({ order: z.array(securityId).min(1) }),
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
        if (operation.action === 'reorder') {
          const ids = p.order
          if (ids.length !== w.order.length || new Set(ids).size !== ids.length || ids.some(id => !w.items[id])) fail('INVALID_ORDER', '排序参数无效')
          // 置顶项必须连续占据最前段: 与渲染分段一致, 防止拖动把置顶项沉底
          if (ids.some((id, index) => !w.items[id].pinned && ids.slice(index + 1).some(next => w.items[next].pinned))) fail('INVALID_ORDER', '置顶项必须保持在列表最前')
          w.order = ids
          return control
        }
        if (operation.action === 'add') {
          if (item) return control
          if (w.order.length >= 100) fail('LIMIT_REACHED', '最多添加100只自选', 422)
          const security = resolveSecurity(p.securityId)
          if (!security || !securitySchema.safeParse(security).success) fail('CANDIDATE_EXPIRED', '候选已过期，请重新搜索', 409)
          // 市场分组默认开: 该市场还没有自选时按市场归组; 该市场已无票持市场标签(解散/改名/逐票移除),
          // 不再把新票塞回去; 手动加回市场标签即恢复
          const marketTag = MARKET_META[security.exchange].tag
          const marketPeers = w.order.filter(id => w.items[id].exchange === security.exchange)
          const keepMarketTag = !marketPeers.length || marketPeers.some(id => w.items[id].tags.includes(marketTag))
          w.items[p.securityId] = { ...security, alias: '', pinned: false, marks: [], tags: keepMarketTag ? [marketTag] : [] }; w.order.push(p.securityId)
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
        } else if (operation.action === 'tags') {
          if (!w.items[p.securityId]) fail('NOT_FOUND', '证券已被移除', 404)
          w.items[p.securityId].tags = p.tags
        }
        // 标签是名称身份: 重命名即批量替换, 目标名已存在时合并去重而不是制造重复
        else if (operation.action === 'tagRename') {
          const holders = w.order.filter(id => w.items[id].tags.includes(p.from))
          if (!holders.length) fail('NOT_FOUND', '标签不存在', 404)
          for (const id of holders) w.items[id].tags = [...new Set(w.items[id].tags.map(tag => tag === p.from ? p.to : tag))]
        }
        else if (operation.action === 'tagRemove') {
          const holders = w.order.filter(id => w.items[id].tags.includes(p.tag))
          if (!holders.length) fail('NOT_FOUND', '标签不存在', 404)
          for (const id of holders) w.items[id].tags = w.items[id].tags.filter(tag => tag !== p.tag)
        }
        else {
          if (!item) fail('NOT_FOUND', '证券已被移除', 404)
          if (operation.action === 'remove') {
            const i = w.order.indexOf(p.securityId)
            control.operationResult = { restore: { item, previousId: w.order[i - 1] || null, nextId: w.order[i + 1] || null } }
            w.order.splice(i, 1); delete w.items[p.securityId]
          } else if (operation.action === 'alias') item.alias = p.alias.trim()
          else if (operation.action === 'marks') item.marks = p.marks
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
