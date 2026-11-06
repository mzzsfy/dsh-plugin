// 测试夹具: mock ctx + apply + 工具面入口。宿主面一律用 support/fake-host.mjs 的真实
// http.Server 替身, 不再自建分发语义。
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { busStub, resetBusStub } from '../_mocks.common-tools.mjs'

export const DEFAULT_CONNECT_TIMEOUT = 10 * 1000
export const PORT_MAX = 65535

// settings 服务桩: 内存存储 + watch 回调, 测试手动触发模拟设置页写入
export function createSettingsService(initial = {}) {
  const store = { tunnel: { ...initial } }
  const watchers = []
  return {
    store,
    watchers,
    setTunnel(patch) {
      store.tunnel = { ...store.tunnel, ...patch }
      for (const callback of watchers) callback()
    },
    service: {
      get: (ns) => store[ns],
      update: (ns, patch) => { store[ns] = { ...(store[ns] ?? {}), ...patch } },
      register: (ns) => ({ watch: (callback) => watchers.push(callback) }),
    },
  }
}

const tempDataDirs = new Set()
export function tempDataDir() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-tunnel-test-'))
  tempDataDirs.add(dir)
  return dir
}
process.on('exit', () => {
  for (const dir of tempDataDirs) rmSync(dir, { recursive: true, force: true })
})

function createCtx(webServer, settings) {
  const toolsService = {
    registered: [],
    register(tool) { this.registered.push(tool); return () => {} },
  }
  const effectDisposers = []
  const runEffect = (fn) => {
    const disposer = fn()
    if (typeof disposer === 'function') effectDisposers.push(disposer)
    return disposer
  }
  resetBusStub()
  const ctx = {
    webServer,
    get: () => undefined,
    on: () => () => {},
    effect: runEffect,
    inject: (names, callback) => callback({ tools: toolsService, settings, effect: runEffect }),
  }
  return { ctx, toolsService, effectDisposers, published: busStub.published }
}

export async function applyPlugin(webServer, options = {}) {
  const { apply } = await import('../../src/index.js')
  const { ctx, toolsService, effectDisposers, published } = createCtx(webServer, options.settings)
  const dataDir = options.dataDir ?? tempDataDir()
  const warnings = []
  const originalWarn = console.warn
  console.warn = (...args) => warnings.push(args.join(' '))
  let dispose
  try {
    dispose = apply(ctx, { connectTimeoutMs: options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT, dataDir })
  } finally {
    console.warn = originalWarn
  }
  const tools = Object.fromEntries(toolsService.registered.map((tool) => [tool.name, tool]))
  // 宿主语义: 停用 = apply disposer + 各 effect 清理(逆序, fiber 回收)
  const disposeAll = () => {
    if (typeof dispose === 'function') dispose()
    for (const disposer of effectDisposers.reverse()) disposer()
  }
  return { webServer, tools, dataDir, warnings, dispose: disposeAll, ctx, published }
}

export function toolOf(plugin, name) {
  const tool = plugin.tools[name]
  assert.ok(tool, `工具未注册: ${name}`)
  return tool
}

export const open = (plugin, args) => toolOf(plugin, 'tunnel_open').execute(args)
export const list = (plugin) => toolOf(plugin, 'tunnel_list').execute({})
export const close = (plugin, name) => toolOf(plugin, 'tunnel_close').execute({ name })

export function storeRows(dataDir) {
  try {
    return JSON.parse(readFileSync(join(dataDir, 'tunnels.json'), 'utf8'))
  } catch {
    return []
  }
}

export const tunnelPrefixCount = (webServer) => [...webServer.prefixes.keys()].filter((path) => path.startsWith('/p/')).length
