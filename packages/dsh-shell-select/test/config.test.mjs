// config 设置 schema 与 argv 组装:BDD 场景见 docs/progress/shell-select-plan.md「模块 config」。
// schemastery schema 走真实官方包验证默认值与校验行为。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveConfig, resolveConfigStrict, coerceServiceable, defaultConfig, entryById, requireEntry, buildArgv, KINDS, RESOLVED_AUTO } from '../src/config.mjs'
import { assertServiceableConfig } from '../src/config.mjs'

test('schema 应用出厂默认:三客户端 + 默认 pwsh', () => {
  const applied = resolveConfig({})
  assert.deepEqual(applied, defaultConfig())
  assert.equal(applied.default, 'pwsh')
  assert.deepEqual(applied.shells.map((entry) => entry.id), ['pwsh', 'git-bash', 'cmd'])
  for (const entry of applied.shells) {
    assert.equal(entry.path, '')
    assert.ok(KINDS.includes(entry.kind))
  }
})

test('schema 拒绝未知 kind;default 跨字段一致性由 validate hook 与 requireEntry 兜底', () => {
  assert.throws(() => resolveConfig({ shells: [{ id: 'x', name: 'X', kind: 'fish', path: '' }], default: 'x' }))
})

test('落盘坏形态防御:volatile 字段被序列化成对象时降级默认,行构造不炸', () => {
  // 事故:原生设置页/ref 序列化把 shells 落盘为 {},冷启动 Config 抛
  // "expected array but got [object Object]" → 行死 → settings 无节 →
  // 设置页 "no longer configurable" 死锁。类型不符的键必须降级默认。
  const poisoned = {
    shells: {},
    deny: { 0: 'rm' },
    default: 42,
    timeoutMs: 'forever',
    cwd: ['C:\\'],
    good: 'ignored-by-schema',
  }
  const applied = resolveConfig(poisoned)
  assert.deepEqual(applied, defaultConfig())
  // 合法值原样保留,清洗不做过度剥离
  const valid = resolveConfig({ shells: [{ id: 'pwsh', kind: 'pwsh' }], default: 'pwsh', deny: ['rm -rf'], cwd: 'C:\\tmp', timeoutMs: 5000 })
  assert.equal(valid.shells.length, 1)
  assert.equal(valid.default, 'pwsh')

  // 执行面 strict:同款坏形态必须炸(宿主 resolve 产物须先解箱;静默降级
  // 曾让行 config 永不生效,0.2.0-rc.2 真机实证)。宽容路径(上方)保留。
  assert.throws(() => resolveConfigStrict(poisoned), /形态非法.*shells/)
  // 合法输入与 undefined 缺省:strict 与宽容同产出
  assert.deepEqual(resolveConfigStrict(valid), valid)
  assert.deepEqual(resolveConfigStrict(undefined), defaultConfig())
  assert.deepEqual(valid.deny, ['rm -rf'])
  assert.equal(valid.cwd, 'C:\\tmp')
  assert.equal(valid.timeoutMs, 5000)
  // 非对象整体(null/数组/标量)= 无配置,出厂默认
  for (const junk of [null, 'x', 42, ['shells']]) {
    assert.deepEqual(resolveConfig(junk), defaultConfig())
  }
})

// --- coerceServiceable:任意用户输入产出可服务配置(插件不因配置死) ---

test('coerce:悬空 default 归 shells[0],空/全非法 shells 回落出厂默认', () => {
  const { config, warnings } = coerceServiceable({ shells: [{ id: 'pwsh', kind: 'pwsh' }], default: 'nope' })
  assert.equal(config.default, 'pwsh')
  assert.ok(warnings.some((line) => line.includes('default')))
  const emptied = coerceServiceable({ shells: [{ id: 'x', kind: 'fish' }], default: 'x' })
  assert.deepEqual(emptied.config.shells.map((entry) => entry.id), ['pwsh', 'git-bash', 'cmd'])
  assert.equal(emptied.config.default, 'pwsh')
  assert.ok(emptied.warnings.length >= 2)
})

test('coerce:预算字段非正数降默认,deny 剔除不可编译条目,合法输入零告警原样', () => {
  const { config, warnings } = coerceServiceable({
    shells: [{ id: 'pwsh', kind: 'pwsh' }],
    default: 'pwsh',
    timeoutMs: -5,
    graceMs: Number.MAX_SAFE_INTEGER,
    deny: ['rm -rf', '(unclosed', '', 42],
  })
  assert.equal(config.timeoutMs, undefined)
  assert.equal(config.graceMs, undefined)
  assert.deepEqual(config.deny, ['rm -rf'])
  assert.equal(warnings.length, 3)
  const clean = coerceServiceable({ shells: [{ id: 'pwsh', kind: 'pwsh' }], default: 'pwsh' })
  assert.equal(clean.warnings.length, 0)
  // 产物必过可服务校验:任意输入不产出会炸挂载的配置
  assertServiceableConfig(resolveConfig(clean.config))
  assertServiceableConfig(resolveConfig(config))
})

test('冻结输入防御:volatile ref 深冻结快照喂入不改写不抛(挂载路径)', () => {  // 事故:cosmokit createVolatile 的 snapshot 对 volatile 值逐层 Object.freeze,
  // 行 Config ref .get() 产物是深冻结对象;sanitizeConfigEntry 引用透传,
  // schemastery resolve 原地改写入参(填默认)撞冻结 env 抛
  // "Cannot assign to read only property 'MSYSTEM'" → 执行器挂载失败,
  // 每次启动回滚官方 pwsh 链,shell 工具永不注册。
  // 契约:resolveConfig 对输入不可变(与 unwrapConfig 输出 clone 对称)。
  const frozenSection = Object.freeze({
    shells: Object.freeze([
      Object.freeze({ id: 'pwsh', kind: 'pwsh', path: '', args: Object.freeze([]), env: Object.freeze({}) }),
      Object.freeze({ id: 'git-bash', kind: 'bash', path: '', args: Object.freeze([]), login: true, distro: '', env: Object.freeze({ MSYSTEM: 'MINGW64' }) }),
    ]),
    default: 'git-bash',
  })
  const applied = resolveConfig(frozenSection)
  assert.equal(applied.default, 'git-bash')
  assert.deepEqual(applied.shells.map((entry) => entry.id), ['pwsh', 'git-bash'])
  assert.deepEqual(applied.shells[1].env, { MSYSTEM: 'MINGW64' })
  // 二轮 resolve(行重载/快照回灌常态)同样幂等
  const again = resolveConfig(frozenSection)
  assert.deepEqual(again, applied)
  // 输出与冻结输入脱耦:改输出不 affects 输入,反复解析结果稳定
  applied.shells[1].env.MSYSTEM = 'TERM'
  assert.deepEqual(resolveConfig(frozenSection).shells[1].env, { MSYSTEM: 'MINGW64' })
})

test('pwsh argv:非交互形 + 编码前缀', () => {
  const argv = buildArgv({ kind: 'pwsh', path: 'C:\\pf\\pwsh.exe' }, 'Get-Item .')
  assert.deepEqual(argv, [
    'C:\\pf\\pwsh.exe',
    '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
    '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $OutputEncoding = [System.Text.UTF8Encoding]::new($false); Get-Item .',
  ])
})

test('bash argv:-c 直传', () => {
  assert.deepEqual(buildArgv({ kind: 'bash', path: 'C:\\Git\\bin\\bash.exe' }, 'ls -la'), [
    'C:\\Git\\bin\\bash.exe', '-c', 'ls -la',
  ])
})

test('bash argv:login 条目走 -lc 登录壳(profile 注入 PATH)', () => {
  assert.deepEqual(buildArgv({ kind: 'bash', path: 'C:\\msys64\\usr\\bin\\bash.exe', login: true }, 'uname -a'), [
    'C:\\msys64\\usr\\bin\\bash.exe', '-lc', 'uname -a',
  ])
})

test('bash argv:login=false 与缺省等价(-c)', () => {
  assert.deepEqual(buildArgv({ kind: 'bash', path: 'C:\\b.exe', login: false }, 'x'), ['C:\\b.exe', '-c', 'x'])
})

test('login 显式配置与自定义 args 模板互斥时模板优先', () => {
  assert.deepEqual(buildArgv({ kind: 'bash', path: 'C:\\b.exe', login: true, args: ['-x'] }, 'hi'), ['C:\\b.exe', '-x', 'hi'])
})

test('schema 往返:login 布尔保留,旧配置缺省落 false', () => {
  const applied = resolveConfig({ shells: [
    { id: 'm', name: 'MSYS2', kind: 'bash', path: 'C:\\msys64\\usr\\bin\\bash.exe', login: true },
    { id: 'g', name: 'Git Bash', kind: 'bash', path: '' },
  ], default: 'm' })
  assert.equal(applied.shells[0].login, true)
  assert.equal(applied.shells[1].login, false)
})

test('cmd argv:/d /s /c 忽略 AutoRun', () => {
  assert.deepEqual(buildArgv({ kind: 'cmd', path: 'C:\\S32\\cmd.exe' }, 'dir'), [
    'C:\\S32\\cmd.exe', '/d', '/s', '/c', 'dir',
  ])
})

test('wsl argv:--exec 绕过默认 shell', () => {
  assert.deepEqual(buildArgv({ kind: 'wsl', path: 'C:\\S32\\wsl.exe' }, 'uname -a'), [
    'C:\\S32\\wsl.exe', '--exec', 'bash', '-c', 'uname -a',
  ])
})

test('自定义 args 模板:{command} 占位替换', () => {
  const argv = buildArgv({ kind: 'bash', path: 'C:\\x\\fish.exe', args: ['--login', '-c', '{command}'] }, 'echo hi')
  assert.deepEqual(argv, ['C:\\x\\fish.exe', '--login', '-c', 'echo hi'])
})

test('自定义 args 模板:无占位则追加末项', () => {
  const argv = buildArgv({ kind: 'bash', path: 'C:\\x\\sh.exe', args: ['-s'] }, 'echo hi')
  assert.deepEqual(argv, ['C:\\x\\sh.exe', '-s', 'echo hi'])
})

test('entryById 按 id 取条目', () => {
  const shells = [
    { id: 'a', name: 'A', kind: 'bash', path: '' },
    { id: 'b', name: 'B', kind: 'cmd', path: '' },
  ]
  assert.equal(entryById(shells, 'b'), shells[1])
  assert.equal(entryById(shells, 'zz'), undefined)
})

test('requireEntry:缺省用 default,default 缺失报配置指引', () => {
  const shells = [
    { id: 'a', name: 'A', kind: 'bash', path: '' },
    { id: 'b', name: 'B', kind: 'cmd', path: '' },
  ]
  assert.equal(requireEntry(shells, undefined, 'b'), shells[1])
  assert.equal(requireEntry(shells, 'a', 'b'), shells[0])
  assert.throws(() => requireEntry(shells, undefined, undefined), /default.*shell-select|shell-select.*default/is)
  assert.throws(() => requireEntry(shells, 'zz', 'b'), /zz/)
})

test('kind 常量与自动解析标记', () => {
  assert.deepEqual(KINDS, ['pwsh', 'bash', 'cmd', 'wsl'])
  assert.equal(RESOLVED_AUTO, '')
})
