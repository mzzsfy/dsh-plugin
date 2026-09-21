// 条目级 env 与 wsl distro:schema 默认、argv 形、entryFor 透传。BDD 场景见 docs/feat-shell-select-optim/plan.md S5-S10。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import ShellSelectExecutor from '../src/executor.mjs'
import { Config, buildArgv, defaultConfig } from '../src/config.mjs'

test('S5 schema 默认:条目 env 空对象、distro 空串,旧配置反序列化补默认', () => {
  const config = Config({ shells: [{ id: 'w', name: 'WSL', kind: 'wsl' }], default: 'w' })
  const entry = config.shells[0]
  assert.deepEqual(entry.env, {})
  assert.equal(entry.distro, '')
  const factory = defaultConfig()
  assert.deepEqual(factory.shells[0].env, {})
  assert.equal(factory.shells[0].distro, '')
})

test('S8 wsl distro 非空:argv 带 -d 发行版', () => {
  const argv = buildArgv({ kind: 'wsl', path: 'C:\\wsl.exe', distro: 'Ubuntu' }, 'ls')
  assert.deepEqual(argv, ['C:\\wsl.exe', '-d', 'Ubuntu', '--exec', 'bash', '-c', 'ls'])
})

test('S9 wsl distro 空:argv 现状形态', () => {
  const argv = buildArgv({ kind: 'wsl', path: 'C:\\wsl.exe', distro: '' }, 'ls')
  assert.deepEqual(argv, ['C:\\wsl.exe', '--exec', 'bash', '-c', 'ls'])
})

test('S10 args 模板条目接管 argv,distro 不出现', () => {
  const argv = buildArgv({ kind: 'wsl', path: 'C:\\wsl.exe', args: ['--data', '{command}'], distro: 'Ubuntu' }, 'ls')
  assert.deepEqual(argv, ['C:\\wsl.exe', '--data', 'ls'])
})

test('S6 entryFor 透传 env 与 distro;spawnSpec env 含条目键', () => {
  const cmdPath = `${process.env.SystemRoot ?? 'C:\\WINDOWS'}\\System32\\cmd.exe`
  const config = Config({
    shells: [{ id: 'c', name: 'CMD', kind: 'cmd', path: cmdPath, env: { MSYSTEM: 'MINGW64' } }, { id: 'p', name: 'pwsh', kind: 'pwsh' }],
    default: 'c',
  })
  const executor = new ShellSelectExecutor(stubCtxFor(config), config)
  const entry = executor.entryFor('c')
  assert.deepEqual(entry.env, { MSYSTEM: 'MINGW64' })
  const spec = executor.resolve({ command: 'ver', workdir: process.cwd() })
  const spawned = executor.spawnSpec(entry, spec, executor.argvFor(entry, spec), 1024, undefined)
  assert.equal(spawned.env.MSYSTEM, 'MINGW64')
  assert.equal(spawned.env.NO_COLOR, '1')
})

test('S7 updateConfig 接受 env/distro 字段并落盘回读', async () => {
  const section = Config({
    shells: [
      { id: 'p', name: 'pwsh', kind: 'pwsh' },
      { id: 'w', name: 'WSL', kind: 'wsl', distro: 'Debian', env: { LANG: 'C.UTF-8' } },
    ],
    default: 'p',
  })
  const executor = new ShellSelectExecutor(stubCtxFor(section), section)
  const next = await executor.updateConfig({})
  const wsl = next.shells.find((entry) => entry.id === 'w')
  assert.equal(wsl.distro, 'Debian')
  assert.deepEqual(wsl.env, { LANG: 'C.UTF-8' })
})

function stubCtxFor(config) {
  const registered = { sections: [], tools: [], promptSections: [], routes: [] }
  return {
    reflect: { provide: () => {} },
    logger: { warn: () => {} },
    effect: (fn) => { registered.routes.push(fn) },
    get() { return { register: () => {} } },
    subprocess: { spawn: () => { throw new Error('not expected') } },
    sandbox: { confine: (argv) => ({ argv, enforcement: 'full', denialSignatures: [], runnerFailureRules: [] }) },
    sandboxPolicy: { resolve: () => ({ mode: 'danger-full-access', roots: [] }) },
    tools: { register: (definition) => registered.tools.push(definition) },
    systemPrompt: {
      section: (item) => registered.promptSections.push(item),
      getSectionOrder: () => 10,
    },
    settings: {
      installSection: (ctx, ns, schema, base) => {
        registered.sections.push({ ns, base })
      },
      replace: async (ns, next) => { registered.replaced = { ns, next } },
    },
    webServer: undefined,
    shellEnv: { collect: () => ({}) },
    _config: config,
    _registered: registered,
    ...configAccessor(),
  }
  function configAccessor() {
    return { get config() { return config } }
  }
}
