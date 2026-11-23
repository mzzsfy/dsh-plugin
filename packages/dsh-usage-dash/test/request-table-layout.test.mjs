// 最近请求详情表格布局:首列容纳展开箭头与两位序号,表宽下限跟随列宽总和,窄屏横向滚动而不压扁列宽。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CLIENT_SOURCE } from './client-eval.mjs'

const columnsSource = CLIENT_SOURCE.match(/const REQUEST_TABLE_COLUMNS = \[[^\]]+\]/)?.[0]
const columns = columnsSource ? [...columnsSource.matchAll(/'(\d+)px'/g)].map((match) => Number(match[1])) : []
// 两位序号在 12px tabular-nums 下的实测宽度,字体度量无法从样式表静态推导
const TWO_DIGITS_WIDTH = 14

const cssNumber = (pattern, fallback) => Number(CLIENT_SOURCE.match(pattern)?.[1] ?? fallback)

test('Given 最近请求详情表格 When 读取列宽 Then 首列同时容纳展开箭头与两位序号', () => {
  assert.ok(columns.length > 0, '缺少 REQUEST_TABLE_COLUMNS 常量')
  const [first] = columns
  const chevron = cssNumber(/\.ud-request-chevron\{[^}]*width:(\d+)px/, NaN)
  const cellPadding = cssNumber(/\.ud-request-table td\{[^}]*padding:(\d+)px/, NaN)
  const firstPaddingLeft = cssNumber(/\.ud-request-table th:first-child,\.ud-request-table td:first-child\{padding-left:(\d+)px\}/, NaN)
  assert.ok(Number.isFinite(chevron) && Number.isFinite(cellPadding) && Number.isFinite(firstPaddingLeft), '样式表中的箭头宽度或单元格内边距缺失')
  const required = chevron + TWO_DIGITS_WIDTH + firstPaddingLeft + cellPadding
  assert.ok(first >= required, `首列 ${first}px 放不下箭头与两位序号(需 ${required}px)`)
})

test('Given 最近请求详情表格 When 声明表宽下限 Then 等于列宽总和且由常量派生', () => {
  const declaration = CLIENT_SOURCE.match(/const REQUEST_TABLE_MIN_WIDTH = ([^\n]+)/)?.[1]
  assert.ok(declaration, '缺少 REQUEST_TABLE_MIN_WIDTH 常量')
  const total = columns.reduce((sum, width) => sum + width, 0)
  const actual = new Function(`const REQUEST_TABLE_COLUMNS = [${columns.map((width) => `'${width}px'`).join(',')}]; return ${declaration}`)()
  assert.equal(actual, total)
  assert.ok(CLIENT_SOURCE.includes('min-width:${REQUEST_TABLE_MIN_WIDTH}px'), '表格最小宽度应引用列宽总和常量')
  assert.match(CLIENT_SOURCE, /REQUEST_TABLE_COLUMNS\.map\(/, 'colgroup 应使用列宽常量')
})
