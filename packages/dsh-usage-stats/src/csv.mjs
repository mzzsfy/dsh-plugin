// CSV 序列化:防公式注入 + 全字符集转义,纯函数。

// 以公式起始符或制表/回车前缀开头的单元格前置单引号(OWASP CSV 注入防护),阻断表格软件公式求值。
const FORMULA_PREFIX = /^[=+\-@\t\r]/
const NEEDS_QUOTING = /[",\r\n]/
const SEPARATOR = ','
const LINE_END = '\r\n'
const CSV_BOM = '﻿'

export function csvCell(value) {
  let text = value === null || value === undefined ? '' : String(value)
  if (FORMULA_PREFIX.test(text)) text = "'" + text
  if (NEEDS_QUOTING.test(text)) text = '"' + text.replace(/"/g, '""') + '"'
  return text
}

export function csvRow(values) {
  return values.map(csvCell).join(SEPARATOR)
}

// BOM 保证表格软件按 UTF-8 解析,不串列不乱码。
export function toCsv(rows) {
  return CSV_BOM + rows.map(csvRow).join(LINE_END)
}
