// L3 步骤判定纯函数:把 l3-probe 收集的实测值与声明式期望比对,失败时给出可复现归因。
// 归因口径:期望 <期望> · 实际 <实际>,选择器类断言另带 selector。
// 单独成文件是为了让 l3-probe.test.mjs 不走浏览器即可覆盖全部分支。

const SUMMARY_LIMIT = 300

// 点路径读取:'value.ok' / 'findings.0.state';缺失返回 undefined,与"显式 undefined"等价
export function readPath(value, path) {
  let cursor = value
  for (const key of String(path).split('.')) {
    if (cursor === null || cursor === undefined) return undefined
    cursor = cursor[key]
  }
  return cursor
}

export function deepEqual(left, right) {
  if (Object.is(left, right)) return true
  if (typeof left !== 'object' || typeof right !== 'object' || left === null || right === null) return false
  if (Array.isArray(left) !== Array.isArray(right)) return false
  const leftKeys = Object.keys(left)
  const rightKeys = Object.keys(right)
  if (leftKeys.length !== rightKeys.length) return false
  return leftKeys.every((key) => Object.prototype.hasOwnProperty.call(right, key) && deepEqual(left[key], right[key]))
}

export function summarize(value) {
  if (value === undefined) return 'undefined'
  if (typeof value === 'string') return value.length > SUMMARY_LIMIT ? `${value.slice(0, SUMMARY_LIMIT)}…` : value
  let text
  try {
    text = JSON.stringify(value)
  } catch {
    text = String(value)
  }
  if (text === undefined) return String(value)
  return text.length > SUMMARY_LIMIT ? `${text.slice(0, SUMMARY_LIMIT)}…` : text
}

export function formatMismatch(expected, actual, selector) {
  const head = selector ? `selector ${selector} · ` : ''
  return `${head}期望 ${summarize(expected)} · 实际 ${summarize(actual)}`
}

function fail(expected, actual, selector) {
  return { ok: false, expected, actual, error: formatMismatch(expected, actual, selector) }
}

// 字段匹配器:字面量即深比较;对象形态支持 equals/type/min/max/oneOf/includes/truthy/notNull/length
export function matchField(expected, actual) {
  if (expected === null || typeof expected !== 'object' || Array.isArray(expected)) {
    return deepEqual(expected, actual) ? { ok: true } : { ok: false, expected, actual }
  }
  const checks = {
    equals: () => deepEqual(expected.equals, actual),
    type: () => Array.isArray(actual)
      ? expected.type === 'array'
      : actual !== null && typeof actual === expected.type,
    min: () => typeof actual === 'number' && actual >= expected.min,
    max: () => typeof actual === 'number' && actual <= expected.max,
    oneOf: () => expected.oneOf.some((candidate) => deepEqual(candidate, actual)),
    includes: () => typeof actual === 'string'
      ? actual.includes(expected.includes)
      : Array.isArray(actual) && actual.includes(expected.includes),
    truthy: () => Boolean(actual) === Boolean(expected.truthy),
    notNull: () => (actual !== null && actual !== undefined) === Boolean(expected.notNull),
    length: () => actual !== null && actual !== undefined && actual.length === expected.length,
  }
  const keys = Object.keys(expected)
  if (keys.length === 0) return { ok: deepEqual(expected, actual), expected, actual }
  for (const [key, check] of Object.entries(checks)) {
    if (!Object.prototype.hasOwnProperty.call(expected, key)) continue
    if (!check()) return { ok: false, expected: { [key]: expected[key] }, actual }
  }
  return { ok: true }
}

// DOM 断言:actual 由 l3-probe 采集为 {selector,count,texts,attrs,computed,html}
export function judgeAssert(spec, actual) {
  const selector = spec?.selector ?? actual?.selector
  if (!selector) return fail('spec.selector', '缺失', selector)
  const count = actual?.count ?? 0
  const texts = actual?.texts ?? []
  if (spec.exists !== undefined) {
    const want = Boolean(spec.exists)
    if ((count > 0) !== want) return fail(`存在=${want}`, `count=${count}`, selector)
  }
  if (spec.empty !== undefined) {
    const want = Boolean(spec.empty)
    if ((count === 0) !== want) return fail(`空=${want}`, `count=${count}`, selector)
  }
  if (spec.count !== undefined && count !== spec.count) return fail(`count=${spec.count}`, `count=${count}`, selector)
  if (spec.minCount !== undefined && count < spec.minCount) return fail(`count>=${spec.minCount}`, `count=${count}`, selector)
  if (spec.maxCount !== undefined && count > spec.maxCount) return fail(`count<=${spec.maxCount}`, `count=${count}`, selector)
  if (spec.exactTexts !== undefined && !deepEqual(spec.exactTexts, texts)) {
    return fail(spec.exactTexts, texts, selector)
  }
  const terms = spec.text === undefined ? null : [].concat(spec.text)
  if (terms !== null && !texts.some((text) => terms.every((term) => text.includes(term)))) {
    return fail(`任一元素含 ${summarize(terms)}`, texts, selector)
  }
  const anyTerms = spec.textAny === undefined ? null : [].concat(spec.textAny)
  if (anyTerms !== null && !texts.some((text) => anyTerms.some((term) => text.includes(term)))) {
    return fail(`任一元素含任一词 ${summarize(anyTerms)}`, texts, selector)
  }
  if (spec.textNot !== undefined) {
    const banned = [].concat(spec.textNot)
    if (texts.some((text) => banned.some((term) => text.includes(term)))) {
      return fail(`无元素含 ${summarize(banned)}`, texts, selector)
    }
  }
  if (spec.attr !== undefined) {
    const { name, equals, includes, regex } = spec.attr
    const value = actual?.attrs?.[name]
    if (equals !== undefined && !deepEqual(equals, value)) return fail(`${name}=${summarize(equals)}`, value, selector)
    if (includes !== undefined && !(typeof value === 'string' && value.includes(includes))) {
      return fail(`${name} 含 ${includes}`, value, selector)
    }
    if (regex !== undefined && !(typeof value === 'string' && new RegExp(regex).test(value))) {
      return fail(`${name} 匹配 /${regex}/`, value, selector)
    }
  }
  if (spec.computed !== undefined) {
    const { prop, equals } = spec.computed
    const value = actual?.computed?.[prop]
    if (equals !== undefined && !deepEqual(equals, value)) return fail(`${prop}=${summarize(equals)}`, value, selector)
  }
  if (spec.htmlIncludes !== undefined && !String(actual?.html ?? '').includes(spec.htmlIncludes)) {
    return fail(`innerHTML 含 ${spec.htmlIncludes}`, actual?.html, selector)
  }
  return { ok: true, expected: spec, actual: { count, texts } }
}

// HTTP 断言:expect = {status, fields, present, absent}
export function judgeHttp(expect, response) {
  if (!expect) {
    const ok = response?.status >= 200 && response?.status < 300
    return { ok, expected: '2xx', actual: response?.status, error: ok ? undefined : formatMismatch('2xx', response?.status) }
  }
  if (expect.status !== undefined) {
    const statuses = [].concat(expect.status)
    const actualStatus = response?.status
    if (!statuses.includes(actualStatus)) {
      return { ok: false, expected: statuses, actual: actualStatus, error: `${actualStatus} 不满足门槛 ${statuses.join('|')}` }
    }
  }
  if (expect.fields !== undefined) {
    for (const [path, matcher] of Object.entries(expect.fields)) {
      const actual = readPath(response?.body, path)
      const result = matchField(matcher, actual)
      if (!result.ok) {
        return { ok: false, expected: { [path]: result.expected }, actual: { [path]: actual }, error: formatMismatch(result.expected, actual, `body.${path}`) }
      }
    }
  }
  for (const path of expect.present ?? []) {
    const actual = readPath(response?.body, path)
    if (actual === undefined) return { ok: false, expected: `${path} 在场`, actual, error: formatMismatch(`${path} 在场`, 'undefined', `body.${path}`) }
  }
  for (const path of expect.absent ?? []) {
    const actual = readPath(response?.body, path)
    if (actual !== undefined) return { ok: false, expected: `${path} 缺席`, actual, error: formatMismatch(`${path} 缺席`, actual, `body.${path}`) }
  }
  return { ok: true, expected: expect, actual: { status: response?.status } }
}

// eval 断言:expect = {equals|truthy|falsy|type|includes|fields}
export function judgeEval(expect, value) {
  if (!expect) return { ok: true, actual: value }
  if (Object.prototype.hasOwnProperty.call(expect, 'equals') && !deepEqual(expect.equals, value)) {
    return { ok: false, expected: expect.equals, actual: value, error: formatMismatch(expect.equals, value) }
  }
  if (expect.truthy !== undefined && Boolean(value) !== Boolean(expect.truthy)) {
    return { ok: false, expected: `truthy=${expect.truthy}`, actual: value, error: formatMismatch(`truthy=${expect.truthy}`, value) }
  }
  if (expect.falsy !== undefined && Boolean(value) !== !expect.falsy) {
    return { ok: false, expected: `falsy=${expect.falsy}`, actual: value, error: formatMismatch(`falsy=${expect.falsy}`, value) }
  }
  if (expect.type !== undefined) {
    const actualType = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value
    if (actualType !== expect.type) return { ok: false, expected: expect.type, actual: actualType, error: formatMismatch(expect.type, actualType) }
  }
  if (expect.includes !== undefined) {
    const hit = typeof value === 'string' ? value.includes(expect.includes) : Array.isArray(value) && value.includes(expect.includes)
    if (!hit) return { ok: false, expected: `含 ${expect.includes}`, actual: value, error: formatMismatch(`含 ${expect.includes}`, value) }
  }
  for (const [path, matcher] of Object.entries(expect.fields ?? {})) {
    const actual = readPath(value, path)
    const result = matchField(matcher, actual)
    if (!result.ok) {
      return { ok: false, expected: { [path]: result.expected }, actual: { [path]: actual }, error: formatMismatch(result.expected, actual, path) }
    }
  }
  return { ok: true, expected: expect, actual: value }
}

// 日志断言:expect = {includes:[...], regex:[...]};text 为已截取的行文本
export function judgeLog(expect, text) {
  const body = String(text ?? '')
  for (const needle of expect.includes ?? []) {
    if (!body.includes(needle)) {
      return { ok: false, expected: `含 ${needle}`, actual: body.slice(-300), error: formatMismatch(`含 ${needle}`, body.slice(-300)) }
    }
  }
  for (const pattern of expect.regex ?? []) {
    if (!new RegExp(pattern).test(body)) {
      return { ok: false, expected: `匹配 /${pattern}/`, actual: body.slice(-300), error: formatMismatch(`匹配 /${pattern}/`, body.slice(-300)) }
    }
  }
  return { ok: true, expected: expect, actual: body.slice(-120) }
}
