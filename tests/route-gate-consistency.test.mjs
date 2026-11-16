// 闸门一致性:15 份副本必须逐字节同源(避免各族语义漂移),并且每条路由注册点的
// handler 都必须真的被闸门包装——"文件里出现两次闸门名字"不算接线,注释/空文件不算。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { scanPackages } from './route-gate-scan.mjs'

const PACKAGES = fileURLToPath(new URL('../packages/', import.meta.url))
const GATE_COPY = fileURLToPath(new URL('../packages/dsh-usage-panel/src/route-gate.mjs', import.meta.url))

function copies() {
  const found = []
  for (const name of readdirSync(PACKAGES).sort()) {
    for (const dir of ['src', 'lib']) {
      const path = join(PACKAGES, name, dir, 'route-gate.mjs')
      if (!existsSync(path)) continue
      found.push({ name, dir, path, text: readFileSync(path, 'utf8') })
    }
  }
  return found
}

// 逐条注册点的例外:只登记"按设计不该过宿主闸门"的面,必须写明理由且精确命中一条
const REGISTRATION_EXCEPTIONS = [
  {
    pkg: 'dsh-tunnel',
    match: (registration) => /forwardHttp/.test(registration.handler) && /PATH_PREFIX/.test(registration.path),
    reason: '隧道转发面 /p/<name> 服务被转发的外部应用,宿主 cookie 闸门会拦死流量;该面不是插件 API',
  },
]

function audit(root, exceptions = REGISTRATION_EXCEPTIONS) {
  const scan = scanPackages(root)
  const problems = []
  const matched = new Map(exceptions.map((entry, index) => [index, 0]))
  for (const [pkg, result] of scan) {
    for (const item of result.unrecognized) {
      problems.push(`${pkg} ${relative(root, item.file)}:${item.line} 有 webServer.${item.callee} 调用但未识别出注册对象(变量形态注册),请用对象字面量`)
    }
    if (result.registrations.length === 0) {
      // 只放 route-gate.mjs 的包必须报出来;非副本包(upgrade 面)允许只有 upgrade 注册
      if (result.hasRouteGateCopy) problems.push(`${pkg}: 未找到任何路由注册(只放 route-gate.mjs 不算接线)`)
      continue
    }
    for (const registration of result.registrations) {
      if (registration.gated) continue
      const index = exceptions.findIndex((entry) => entry.pkg === pkg && entry.match(registration))
      const where = `${pkg} ${relative(root, registration.file)}:${registration.line}`
      if (index === -1) {
        problems.push(`${where} 注册点未接闸门(callee=${registration.callee},handler=${registration.handler.replace(/\s+/g, ' ').slice(0, 60)})`)
        continue
      }
      matched.set(index, matched.get(index) + 1)
    }
  }
  for (const [index, entry] of exceptions.entries()) {
    if (matched.get(index) !== 1) problems.push(`例外必须精确命中一条注册点: ${entry.pkg} 命中 ${matched.get(index)} 次`)
  }
  return { scan, problems }
}

test('每个有路由的包都带 route-gate.mjs,且副本逐字节一致', () => {
  const all = copies()
  assert.equal(all.length, 15, `副本数量 ${all.length},新增/删除包时必须同步更新本断言`)
  const [first, ...rest] = all
  for (const item of rest) {
    assert.equal(item.text, first.text, `${item.name}/${item.dir}/route-gate.mjs 与 ${first.name} 不一致`)
  }
})

test('副本必须把闸门自身异常判为拒绝,不得 fail-open', () => {
  for (const item of copies()) {
    assert.match(item.text, /catch \{\s*\/\/[^]*?rejection = (?:403|DEFAULT_REJECTION)/, `${item.name} 的 catch 分支未按 403 拒绝`)
    assert.doesNotMatch(item.text, /rejection = undefined\s*\n\s*\}\s*\n\s*if \(rejection === undefined\) return false/)
  }
})

// 宿主 requestRejection 的契约只保证"undefined = 放行,非 undefined = 拒绝",拒绝值的形态
// 不受控:null/0/对象/Promise 直接喂 writeHead 会抛 Invalid status code,请求拿不到响应。
// 每份副本都要跑一遍真实导出,响应桩按 Node 同款规则拒收非法码——回退成 writeHead(rejection)
// 的实现会在这里直接抛错。
function strictRes() {
  const res = { status: null, body: null, headers: null, ended: 0 }
  res.writeHead = (status, headers) => {
    if (!Number.isInteger(status) || status < 100 || status > 999) throw new RangeError(`Invalid status code: ${status}`)
    res.status = status
    res.headers = headers
  }
  res.end = (body) => {
    res.ended += 1
    res.body = body
  }
  return res
}

const ctxReturning = (requestRejection) => ({ get: (name) => (name === 'connection' ? { requestRejection } : undefined) })

test('拒绝值非整数/越界时显式 403 并 end;整数 4xx-5xx 按码;undefined 放行', async () => {
  const rejected = [
    ['null', () => null, 403],
    ['0', () => 0, 403],
    ['对象', () => ({ status: 401 }), 403],
    ['Promise', () => Promise.resolve(401), 403],
    ['字符串', () => '401', 403],
    ['布尔', () => true, 403],
    ['NaN', () => Number.NaN, 403],
    ['非整数 401.5', () => 401.5, 403],
    ['越界 399', () => 399, 403],
    ['越界 600', () => 600, 403],
    ['闸门抛错', () => { throw new Error('boom') }, 403],
    ['400', () => 400, 400],
    ['401', () => 401, 401],
    ['429', () => 429, 429],
    ['599', () => 599, 599],
  ]
  for (const item of copies()) {
    const gate = await import(pathToFileURL(item.path).href)
    for (const [label, requestRejection, expected] of rejected) {
      const res = strictRes()
      let blocked
      assert.doesNotThrow(() => { blocked = gate.rejectUnadmitted(ctxReturning(requestRejection), { headers: {} }, res) },
        `${item.name} ${label}: 非 undefined 拒绝值不得让 writeHead 抛错`)
      assert.equal(blocked, true, `${item.name} ${label}: 非 undefined 必须中断请求`)
      assert.equal(res.status, expected, `${item.name} ${label}: 状态码应为 ${expected}`)
      assert.equal(res.ended, 1, `${item.name} ${label}: 必须 end 一次`)
      assert.equal(res.body, expected === 401 ? 'unauthorized' : 'forbidden', `${item.name} ${label}: 响应体`)
    }
    for (const [label, ctx] of [
      ['服务缺失', { get: () => undefined }],
      ['无 requestRejection', { get: () => ({}) }],
    ]) {
      const res = strictRes()
      assert.equal(gate.rejectUnadmitted(ctx, { headers: {} }, res), false, `${item.name} ${label}: undefined 必须放行`)
      assert.equal(res.ended, 0, `${item.name} ${label}: 放行不得写响应`)
    }
  }
})

test('每条路由注册点都必须接闸门:注释、空文件、只放副本一律不得绿', (t) => {
  // 1) 真实仓库:逐条注册点审计(例外只允许 REGISTRATION_EXCEPTIONS 精确命中的面)
  const real = audit(PACKAGES)
  assert.deepEqual(real.problems, [], real.problems.join('\n'))
  assert.equal(real.scan.size, 16, `扫描包数(15 副本包 + common-tools upgrade 面)${real.scan.size}`)
  const common = real.scan.get('dsh-common-tools')
  assert.ok(common !== undefined, 'common-tools 的 registerUpgrade 面必须纳入扫描')
  const upgrades = common.registrations.filter((registration) => registration.kind === 'upgrade')
  assert.equal(upgrades.length, 1, 'registerUpgrade 注册点必须被识别')
  assert.equal(upgrades[0].gated, true, 'upgrade handler 必须调用内联 admit 并处理拒绝')
  assert.equal(upgrades[0].gatedByHandler, true, 'upgrade 面按 handler 体判定,不允许只靠文件里定义过 admit')
  const total = [...real.scan.values()].reduce((sum, result) => sum + result.registrations.length, 0)
  assert.ok(total >= 40, `注册点总数 ${total} 异常偏低,扫描器可能漏识别注册形态`)

  // 2) 负向自测:注释里只出现闸门名字 + 注册点未包装 → 必须报出来
  const tree = (files) => {
    const root = mkdtempSync(join(tmpdir(), 'route-gate-scan-'))
    t.after(() => rmSync(root, { recursive: true, force: true }))
    for (const [path, text] of Object.entries(files)) {
      const full = join(root, path)
      mkdirSync(dirname(full), { recursive: true })
      writeFileSync(full, text)
    }
    return root
  }
  const copyText = readFileSync(GATE_COPY, 'utf8')
  const commentOnly = tree({
    'fake/src/route-gate.mjs': copyText,
    'fake/src/index.js': `// 全部路由都经 withRouteGate / withHostGate / rejectUnadmitted 包装
// rejectNonJson(req, res) 挡跨站表单
export function apply(ctx) {
  ctx.webServer.register({ kind: 'exact', path: '/api/fake/x', handler: async (req, res) => { res.end('x') } })
  ctx.webServer.register({ kind: 'prefix', path: '/api/fake', handler: handleFake })
}
`,
  })
  const commented = audit(commentOnly, [])
  assert.equal(commented.scan.get('fake').registrations.length, 2, '注释里的名字不得吞掉注册点识别')
  assert.equal(commented.problems.filter((problem) => problem.includes('未接闸门')).length, 2, commented.problems.join('\n'))

  // 3) 空文件/只放副本 → 必须报"未找到任何路由注册"
  const empty = tree({
    'empty/src/route-gate.mjs': copyText,
    'empty/src/index.js': '',
  })
  const emptyAudit = audit(empty, [])
  assert.equal(emptyAudit.problems.length, 1)
  assert.match(emptyAudit.problems[0], /未找到任何路由注册/)

  // 4) 变量形态注册(把对象抽到变量再注册)→ 扫描器不得静默放过
  const indirect = tree({
    'indirect/src/route-gate.mjs': copyText,
    'indirect/src/index.js': `export function apply(ctx) {
  const routeConfig = { kind: 'exact', path: '/api/indirect', handler: handleIndirect }
  ctx.webServer.register(routeConfig)
}
`,
  })
  const indirectAudit = audit(indirect, [])
  assert.equal(indirectAudit.problems.filter((problem) => problem.includes('变量形态注册')).length, 1, indirectAudit.problems.join('\n'))

  // 5) 反向对照:真正包装过的注册点必须绿(闸门包装/闸门别名/三元选择三种形态)
  const wired = tree({
    'wired/src/route-gate.mjs': copyText,
    'wired/src/index.js': `import { withHostGate, withRouteGate } from './route-gate.mjs'
const gatedRoute = (method, handler) => withRouteGate(ctx, route(method, handler))
const gatedRegister = (route) => register({ ...route, handler: withRouteGate(ctx, route.handler) })
export function apply(ctx) {
  ctx.webServer.register({ kind: 'exact', path: '/a', handler: withRouteGate(ctx, handleA) })
  ctx.webServer.register({ kind: 'exact', path: '/b', handler: (write ? withRouteGate : withHostGate)(ctx, handleB) })
  ctx.webServer.register({ kind: 'exact', path: '/c', handler: gatedRoute('GET', handleC) })
  gatedRegister({ kind: 'exact', path: '/d', handler: handleD })
}
`,
  })
  const wiredAudit = audit(wired, [])
  assert.deepEqual(wiredAudit.problems, [], wiredAudit.problems.join('\n'))
  // 4 条业务注册 + gatedRegister 包装器内部那条 register({...withRouteGate}) 也算注册点
  assert.equal(wiredAudit.scan.get('wired').registrations.length, 5)

  // 6) registerUpgrade 面:定义过 admit 但 handler 不调用必须红(删 admit 调用不得假绿)
  const upgradeTree = (handlerBody) => tree({
    'upbus/src/index.js': `const admit = (req) => { try { return ctx.get('connection')?.requestRejection?.(req) } catch { return 403 } }
export function apply(ctx) {
  ctx.webServer.registerUpgrade({ path: '/bus', handler(req, socket) { ${handlerBody} } })
}
`,
  })
  const upgradeOff = audit(upgradeTree('socket.destroy()'), [])
  assert.equal(upgradeOff.problems.filter((problem) => problem.includes('未接闸门')).length, 1, upgradeOff.problems.join('\n'))
  const upgradeWired = audit(upgradeTree(`const rejection = admit(req)
    if (rejection !== undefined) { socket.destroy(); return }`), [])
  assert.deepEqual(upgradeWired.problems, [], upgradeWired.problems.join('\n'))
})

test('common-tools 的内联实现同样是 fail-closed', () => {
  const bus = readFileSync(new URL('../packages/dsh-common-tools/src/host.js', import.meta.url), 'utf8')
  assert.match(bus, /const admit = \(req\)[\s\S]*?catch \{\s*return 403/)
})
