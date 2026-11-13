// 归档行文件大小展示契约:批量请求 host sizes 路由,标题下单行元信息显示大小,
// 所有归档视图共用同一行组件;紧凑布局参数锁定,防重构把信息拆回多行或逐行发请求。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const CLIENT_SRC = readFileSync(fileURLToPath(new URL('../src/client.js', import.meta.url)), 'utf8')
const INDEX_SRC = readFileSync(fileURLToPath(new URL('../src/index.js', import.meta.url)), 'utf8')

// host 批量上限从源码提取:client 常量必须同值,避免两份魔法值漂移
const hostMaxMatch = INDEX_SRC.match(/export const SIZES_MAX_IDS = (\d+)/)
assert.ok(hostMaxMatch, 'index.js 缺少 SIZES_MAX_IDS 导出')
const HOST_SIZES_MAX_IDS = Number(hostMaxMatch[1])

test('源码契约:sizes 路由批量请求、分批上限与取消释放', () => {
  assert.ok(CLIENT_SRC.includes("const SIZES_URL = '/api/session-manager/sizes'"), '缺 sizes 路由常量')
  assert.ok(new RegExp('const SIZES_BATCH_SIZE = ' + HOST_SIZES_MAX_IDS + '\\b').test(CLIENT_SRC),
    'client 分批大小与 host SIZES_MAX_IDS 漂移')
  assert.ok(/api\(SIZES_URL, \{ method: 'POST', body: JSON\.stringify\(\{ sessionIds: batch \}\) \}\)/.test(CLIENT_SRC),
    'sizes 请求未按批发送 sessionIds')
  const effectStart = CLIENT_SRC.indexOf('const rowIdsKey')
  assert.notEqual(effectStart, -1, '缺 sizes effect 锚点')
  const effectEnd = CLIENT_SRC.indexOf('}, [rowIdsKey])', effectStart)
  assert.notEqual(effectEnd, -1, '缺 sizes effect 结束锚点')
  const effectSrc = CLIENT_SRC.slice(effectStart, effectEnd)
  assert.equal((effectSrc.match(/if \(cancelled\) return/g) || []).length, 2, '卸载后迟到响应未拦截')
  assert.ok(effectSrc.includes('if (!settled.has(id)) requestedSizesRef.current.delete(id)'), '清理未释放未完成请求标记')
})

test('源码契约:归档行元信息行渲染工作区、时间与文件大小', () => {
  const rowSrc = CLIENT_SRC.slice(CLIENT_SRC.indexOf('function ArchiveRow'), CLIENT_SRC.indexOf('function DeleteDialog'))
  assert.ok(rowSrc.includes("sm-row sm-row--archive"), '归档行未使用独立紧凑布局类')
  assert.ok(rowSrc.includes('sm-row__main'), '归档行缺主内容容器')
  assert.ok(!rowSrc.includes('sm-row__title-wrap'), '标题前空容器未移除')
  const metaStart = rowSrc.indexOf("className: 'sm-row__meta'")
  assert.notEqual(metaStart, -1, '归档行缺元信息行')
  const metaSrc = rowSrc.slice(metaStart, rowSrc.indexOf('confirm && confirm.error', metaStart))
  assert.ok(metaSrc.includes('sm-row__ws'), '工作区徽标未移入元信息行')
  assert.ok(metaSrc.includes('row.updatedAt'), '元信息行未保留更新时间')
  assert.ok(metaSrc.includes("' · ' + fmtTime(row.updatedAt) + ' · '"), '元信息行时间与前后字段的分隔符缺失')
  assert.ok(metaSrc.includes('fmtSize('), '元信息行未渲染格式化后的文件大小')
})

test('源码契约:紧凑行高与单行元信息样式锁定', () => {
  assert.ok(CLIENT_SRC.includes('.sm-row--archive { display:flex; align-items:center; gap:8px; padding:4px 10px;'),
    '归档行未改为紧凑 flex 布局')
  assert.ok(CLIENT_SRC.includes('.sm-row--archive .sm-row__title { font-size:14px; line-height:20px;'),
    '归档行标题行高未压缩')
  assert.ok(CLIENT_SRC.includes('.sm-row__meta { display:flex; align-items:center; gap:4px; font-family:var(--ds-font-family-code); font-size:11px; line-height:16px;'),
    '元信息行样式缺失或未压到 11px/16px')
  assert.ok(/\.sm-row__ws \{[^}]*padding:0 6px[^}]*line-height:16px/.test(CLIENT_SRC), '元信息行工作区徽标未同步压到 16px')
  assert.ok(CLIENT_SRC.includes('.sm-group__head {') && /\.sm-group__head \{[^}]*min-height:40px/.test(CLIENT_SRC),
    '按工作区分组头未同步压缩')
})

test('源码契约:已删除行保持原 grid 结构不受紧凑归档行影响', () => {
  assert.ok(/\.sm-row \{ display:grid; grid-template-columns:88px minmax\(0,1fr\) auto;/.test(CLIENT_SRC),
    '基础 sm-row grid 结构被归档行改动污染')
  const deletedSrc = CLIENT_SRC.slice(CLIENT_SRC.indexOf('function DeletedRow'), CLIENT_SRC.indexOf('function DeletedSection'))
  assert.ok(!deletedSrc.includes('sm-row--archive'), '已删除行误用归档紧凑布局')
})

test('归档大小汇总:已知总量、缺失、不可得与未加载分桶', () => {
  const start = CLIENT_SRC.indexOf('function sizeSummaryOf(')
  assert.notEqual(start, -1, '缺 sizeSummaryOf 汇总函数')
  const end = CLIENT_SRC.indexOf('function ArchiveRow(', start)
  const factory = new Function(CLIENT_SRC.slice(start, end) + '; return sizeSummaryOf')
  const sizeSummaryOf = factory()

  assert.deepEqual(sizeSummaryOf([], {}), { totalBytes: 0, known: 0, missing: 0, unsupported: 0, pending: 0 })
  assert.deepEqual(sizeSummaryOf([
    { id: 'a' },
    { id: 'b' },
    { id: 'c' },
    { id: 'd' },
    { id: 'e' },
  ], {
    a: { supported: true, sizeBytes: 1024 },
    b: { supported: true, sizeBytes: 0, missing: true },
    c: { supported: false },
    e: { supported: true, sizeBytes: Number.NaN },
  }), { totalBytes: 1024, known: 1, missing: 1, unsupported: 2, pending: 1 })
})

test('源码契约:面板头显示归档总大小与缺失数', () => {
  assert.ok(CLIENT_SRC.includes('sizeSummaryOf(rows, sizes)'), '面板头未计算归档大小汇总')
  const headerStart = CLIENT_SRC.indexOf("className: 'sm-head__count'")
  assert.notEqual(headerStart, -1, '缺面板头计数锚点')
  const headerEnd = CLIENT_SRC.indexOf("view === 'recent'", headerStart)
  assert.notEqual(headerEnd, -1, '缺面板头结束锚点')
  const headerSrc = CLIENT_SRC.slice(headerStart, headerEnd)
  assert.ok(headerSrc.includes('sm-head__missing'), '缺失数未使用独立样式')
  assert.ok(headerSrc.includes('sizeSummary.pending === 0 && sizeSummary.known > 0'), '未等大小加载完成再显示总大小')
  assert.ok(headerSrc.includes('sizeSummary.pending === 0 && sizeSummary.missing > 0'), '缺失数未等大小加载完成')
  assert.ok(headerSrc.includes('sizeSummary.pending === 0 && sizeSummary.unsupported > 0'), '不可得数未等大小加载完成')
  assert.ok(headerSrc.includes("' · ' + fmtSize(sizeSummary.totalBytes)"), '面板头未显示总大小')
  assert.ok(headerSrc.includes("' · 缺失 ' + sizeSummary.missing + ' 条'"), '面板头未显示产物缺失数')
  assert.ok(headerSrc.includes("' · ' + sizeSummary.unsupported + ' 条不可得'"), '面板头未显示大小不可得数')
})
