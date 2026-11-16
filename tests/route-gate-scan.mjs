// 路由闸门 per-handler 扫描:把"每一条 webServer.register 的 handler 是否被闸门包装"
// 变成可断言的静态事实,替掉"文件里出现两次闸门名字就算接线"的假绿口径。
//
// 口径:
//   - 注释与字符串内容先被抹成空白,只在真实代码上结构匹配(注释/空文件不可能变绿)
//   - 只认形如 `NAME({ ...handler... })` 的注册对象(含 spread 的包装器也算)
//   - 包装判定两级:注册调用本身是闸门别名(如 gatedRegister/route),或 handler 表达式
//     以闸门/闸门别名开头(含三元选择 (cond ? withRouteGate : withHostGate))
//   - 别名 = 同包源码里初始值/函数体出现 withRouteGate|withHostGate|rejectUnadmitted 的
//     具名定义;别家包的别名不串用
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const GATE_NAMES = ['withRouteGate', 'withHostGate', 'rejectUnadmitted']
const GATE_REFERENCE = new RegExp(`\\b(?:${GATE_NAMES.join('|')})\\b`)
// 内联闸门(common-tools 的 admit):定义自身 fail-closed 即视为闸门函数,可用于 upgrade handler
const FAIL_CLOSED_DEFINITION = /catch\s*\{\s*return\s+40[13]\s*\}/
const UPGRADE_CALLEE = 'registerUpgrade'
const SOURCE_EXT = /\.(?:mjs|js)$/
const STATEMENT_START = /^\s*(?:const|let|var|function|class|export|import)\b/

// 注释、字符串、模板、正则内容抹为空白(保留换行以维持行号);结构匹配只依赖代码骨架
export function stripLiterals(source) {
  const blank = (text) => text.replace(/[^\n]/g, ' ')
  let out = ''
  let i = 0
  let previous = ''
  while (i < source.length) {
    const char = source[i]
    const next = source[i + 1]
    if (char === '/' && next === '/') {
      const end = source.indexOf('\n', i)
      const stop = end === -1 ? source.length : end
      out += blank(source.slice(i, stop))
      i = stop
      continue
    }
    if (char === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2)
      const stop = end === -1 ? source.length : end + 2
      out += blank(source.slice(i, stop))
      i = stop
      continue
    }
    // 正则字面量:仅在"表达式位置"出现(上一个有效字符是运算符/分隔符)时按正则吞掉,
    // 否则按除号处理;两者都只影响结构切分,不影响 denial 判定
    if (char === '/' && (previous === '' || /[=(,:[!&|?{};+\-*%~^<>]/.test(previous))) {
      let j = i + 1
      let closed = false
      while (j < source.length) {
        if (source[j] === '\\') { j += 2; continue }
        if (source[j] === '\n') break
        if (source[j] === '/') { closed = true; j += 1; break }
        j += 1
      }
      if (closed) {
        while (j < source.length && /[a-z]/i.test(source[j])) j += 1
        out += blank(source.slice(i, j))
        previous = '/'
        i = j
        continue
      }
    }
    if (char === '\'' || char === '"' || char === '`') {
      let j = i + 1
      while (j < source.length) {
        if (source[j] === '\\') { j += 2; continue }
        if (source[j] === char) { j += 1; break }
        j += 1
      }
      out += blank(source.slice(i, j))
      previous = char
      i = j
      continue
    }
    if (!/\s/.test(char)) previous = char
    out += char
    i += 1
  }
  return out
}

// 从 open 位置的左括号开始找配对的右括号,返回其下标(找不到返回 -1)
function matchingBracket(code, open) {
  const pairs = { '(': ')', '[': ']', '{': '}' }
  const stack = []
  for (let i = open; i < code.length; i++) {
    const char = code[i]
    if (pairs[char] !== undefined) stack.push(pairs[char])
    else if (char === ')' || char === ']' || char === '}') {
      if (stack.pop() !== char) return -1
      if (stack.length === 0) return i
    }
  }
  return -1
}

// 顶层属性切分:按顶层逗号切开对象字面量,保留 key→value 文本
function objectEntries(body) {
  const entries = []
  let depth = 0
  let start = 0
  const push = (end) => {
    const raw = body.slice(start, end).trim()
    if (raw !== '') entries.push(raw)
    start = end + 1
  }
  for (let i = 0; i < body.length; i++) {
    const char = body[i]
    if ('([{'.includes(char)) depth += 1
    else if (')]}'.includes(char)) depth -= 1
    else if (char === ',' && depth === 0) push(i)
  }
  push(body.length)
  return entries
}

function propertyOf(entry) {
  const match = entry.match(/^(?:\.\.\.|([A-Za-z_$][\w$]*)\s*:)/)
  if (!match) {
    // 方法简写 handler(req, socket) {...}(upgrade 注册的常见形态)
    const method = entry.match(/^([A-Za-z_$][\w$]*)\s*\(/)
    return method === null ? null : { key: method[1], value: entry.slice(method[0].length - 1) }
  }
  if (entry.startsWith('...')) return { key: '...', value: entry.slice(3).trim() }
  return { key: match[1], value: entry.slice(match[0].length).trim() }
}

const leadingIdentifier = (expression) => expression.match(/^([A-Za-z_$][\w$]*)/)?.[1] ?? null

// 表达式是否被闸门包装:直接闸门/闸门别名/三元选择闸门/带括号的同义写法
export function isGatedExpression(expression, aliases) {
  let text = expression.trim()
  while (text.startsWith('(')) {
    const close = matchingBracket(text, 0)
    if (close === -1) return false
    const head = text.slice(1, close)
    if (GATE_REFERENCE.test(head)) return true
    // (cond ? withRouteGate : withHostGate)(ctx, h) 形态:括号组后还有调用
    text = text.slice(close + 1).trim()
    if (text.startsWith('.')) return false
  }
  const name = leadingIdentifier(text)
  if (name === null) return false
  const chain = text.slice(name.length)
  // handler: ctx.gates.route(...) 之类成员链只在最后一段是别名时采信
  if (chain.startsWith('.')) {
    const last = chain.match(/\.\s*([A-Za-z_$][\w$]*)\s*\(/)?.[1] ?? null
    return last !== null && aliases.has(last)
  }
  return GATE_NAMES.includes(name) || aliases.has(name)
}

// 具名定义的初始化文本(表达式/函数体),用于判定别名;不追求完整 JS 解析,只求不跨语句
export function definitionText(code, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const declarators = [...code.matchAll(new RegExp(`\\b(?:const|let|var)\\s+${escaped}\\s*=`, 'g'))]
  const functions = [...code.matchAll(new RegExp(`\\bfunction\\s+${escaped}\\s*\\(`, 'g'))]
  const starts = [
    ...declarators.map((match) => match.index + match[0].length),
    ...functions.map((match) => {
      const openParen = code.indexOf('(', match.index)
      const closeParen = matchingBracket(code, openParen)
      return closeParen === -1 ? null : closeParen + 1
    }).filter((value) => value !== null),
  ]
  if (starts.length === 0) return null
  const start = starts[0]
  let depth = 0
  for (let i = start; i < code.length; i++) {
    const char = code[i]
    if ('([{'.includes(char)) depth += 1
    else if (')]}'.includes(char)) depth -= 1
    else if (char === ';' && depth === 0) return code.slice(start, i)
    else if (char === '\n' && depth === 0) {
      const before = code.slice(start, i).trimEnd()
      const nextLine = (code.slice(i + 1).match(/^[^\n]*/) ?? [''])[0]
      // 续行:上一行以运算符/逗号/箭头结尾,或下一行以 . / 运算符开头
      const continues = /[=,.+\-*/&|?:([{!<>]$/.test(before) || /^\s*[.?]/.test(nextLine)
      if (!continues) return code.slice(start, i)
    }
  }
  return code.slice(start)
}

const gateAliasesOf = (texts) => {
  const aliases = new Set()
  const handlerAliases = new Set()
  const gateFunctions = new Set()
  const names = new Set()
  for (const code of texts) {
    for (const match of code.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g)) names.add(match[1])
    for (const match of code.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/g)) names.add(match[1])
  }
  for (const name of names) {
    const definition = texts.map((code) => definitionText(code, name)).find((value) => value !== null)
    if (definition === undefined || definition === null) continue
    if (!GATE_REFERENCE.test(definition)) {
      // 内联实现只作 upgrade handler 的闸门函数,不当 handler 包装器(避免 fail-closed 终态函数被误认成包装)
      if (FAIL_CLOSED_DEFINITION.test(definition)) gateFunctions.add(name)
      continue
    }
    aliases.add(name)
    // 注册包装器(gatedRegister/route/mountRoutes)是"调用它注册即被包",它返回的是 dispose,
    // 不能当 handler 结果用;handler 位置只认返回已包装 handler 的别名(gatedRoute 类)
    if (!/\.register\s*\(|\bregister\s*\(/.test(definition)) handlerAliases.add(name)
  }
  return { aliases, handlerAliases, gateFunctions }
}

// upgrade handler 的门禁在函数体内:必须用闸门函数(req) 得到拒绝值并落到响应。
// 只看"文件里定义过 admit"不算接线——删掉 handler 里的调用必须变红。
export function isGatedHandlerBody(expression, gateFunctions) {
  const names = [...new Set([...GATE_NAMES, ...gateFunctions])]
  if (names.length === 0) return false
  const escaped = names.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  if (!new RegExp(`\\b(?:${escaped.join('|')})\\s*\\(\\s*req\\b`).test(expression)) return false
  return /(?:rejection\s*!==\s*undefined|if\s*\(\s*reject)/.test(expression)
}

function lineOf(text, index) {
  let line = 1
  for (let i = 0; i < index && i < text.length; i++) if (text[i] === '\n') line += 1
  return line
}

function sourceFiles(dir) {
  const found = []
  const walk = (current) => {
    for (const name of readdirSync(current)) {
      const path = join(current, name)
      const stats = statSync(path)
      if (stats.isDirectory()) walk(path)
      else if (SOURCE_EXT.test(name)) found.push(path)
    }
  }
  if (statSafe(dir)) walk(dir)
  return found
}

function statSafe(path) {
  try { return statSync(path).isDirectory() } catch { return false }
}

// 注册点提取:NAME({...}) 且对象含 handler(附 kind/path/spread 之一,排除槽注册等)
export function registrationsIn(code) {
  const found = []
  for (const match of code.matchAll(/([A-Za-z_$][\w$]*)\s*\(\s*\{/g)) {
    const openBrace = match.index + match[0].length - 1
    const closeBrace = matchingBracket(code, openBrace)
    if (closeBrace === -1) continue
    const entries = objectEntries(code.slice(openBrace + 1, closeBrace))
    const properties = entries.map(propertyOf).filter((property) => property !== null)
    const handler = properties.find((property) => property.key === 'handler')
    if (handler === undefined) continue
    const routeLike = properties.some((property) => ['kind', 'path', '...'].includes(property.key))
    if (!routeLike) continue
    const path = properties.find((property) => property.key === 'path')?.value ?? ''
    found.push({
      callee: match[1],
      handler: handler.value,
      path,
      index: openBrace,
    })
  }
  return found
}

// 包级扫描:别名按包隔离,注册点带行号与文件。unrecognized 记录"有 webServer.register/
// registerUpgrade 调用但没有识别出注册对象"的位置(变量形态注册),避免扫描器被绕过后假绿。
export function scanPackage(packageDir) {
  const files = [...new Set([...sourceFiles(join(packageDir, 'src')), ...sourceFiles(join(packageDir, 'lib'))])]
  const codes = files.map((file) => ({ file, code: stripLiterals(readFileSync(file, 'utf8')) }))
  const { aliases, handlerAliases, gateFunctions } = gateAliasesOf(codes.map((item) => item.code))
  const registrations = []
  const unrecognized = []
  for (const { file, code } of codes) {
    if (file.endsWith('route-gate.mjs')) continue
    const detected = new Map()
    for (const registration of registrationsIn(code)) {
      const kind = registration.callee === UPGRADE_CALLEE ? 'upgrade' : 'route'
      const entry = {
        file,
        line: lineOf(code, registration.index),
        callee: registration.callee,
        kind,
        handler: registration.handler,
        path: registration.path,
        gatedByCallee: aliases.has(registration.callee),
        gatedByHandler: isGatedExpression(registration.handler, handlerAliases)
          || (kind === 'upgrade' && isGatedHandlerBody(registration.handler, gateFunctions)),
      }
      entry.gated = entry.gatedByCallee || entry.gatedByHandler
      registrations.push(entry)
      detected.set(registration.callee, (detected.get(registration.callee) ?? 0) + 1)
    }
    for (const callee of ['register', UPGRADE_CALLEE]) {
      const callSites = [...code.matchAll(new RegExp(`webServer\\s*\\.\\s*${callee}\\s*\\(`, 'g'))]
      const count = detected.get(callee) ?? 0
      if (callSites.length > count) {
        unrecognized.push({ file, callee, callSites: callSites.length, detected: count, line: lineOf(code, callSites[count].index) })
      }
    }
  }
  return {
    registrations,
    unrecognized,
    aliases: [...aliases].sort(),
    handlerAliases: [...handlerAliases].sort(),
    gateFunctions: [...gateFunctions].sort(),
  }
}

// 纳入扫描的包 = 带 route-gate 副本的包 + 直接调 webServer.register/registerUpgrade 的包
// (upgrade 面无共享副本,靠内联 admit 兜底;只扫副本包会漏掉 common-tools 这类面)
export function scanPackages(packagesRoot) {
  const result = new Map()
  for (const name of readdirSync(packagesRoot).sort()) {
    const dir = join(packagesRoot, name)
    if (!statSafe(dir)) continue
    const hasCopy = ['src', 'lib'].some((sub) => statSafe(join(dir, sub, 'route-gate.mjs')) || existsFile(join(dir, sub, 'route-gate.mjs')))
    if (!hasCopy && !hasRegistrationSurface(dir)) continue
    result.set(name, { ...scanPackage(dir), hasRouteGateCopy: hasCopy })
  }
  return result
}

function hasRegistrationSurface(packageDir) {
  for (const sub of ['src', 'lib']) {
    for (const file of sourceFiles(join(packageDir, sub))) {
      let text = ''
      try { text = readFileSync(file, 'utf8') } catch { continue }
      if (/webServer\s*\.\s*(?:register|registerUpgrade)\s*\(/.test(stripLiterals(text))) return true
    }
  }
  return false
}

function existsFile(path) {
  try { return statSync(path).isFile() } catch { return false }
}
