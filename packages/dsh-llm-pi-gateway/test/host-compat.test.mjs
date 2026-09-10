// 宿主兼容探测 BDD:0.1.2 引入的 dsh-llm 导出缺失时插件禁用,不注册任何服务;
// 齐全时正常注册。apply 接线以假宿主 + importOfficial 桩验证:官方包缺失降级、
// 接管冲突双文案、onChange 抛错保旧注册。纯函数三态直测兜底。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as realDshLlm from '@deepseek-ai/dsh-llm'
import { apply, missingHostExports } from '../src/index.js'
import { SETTINGS_NS, OFFICIAL_SETTINGS_NS } from '../src/config.mjs'

test('探测清单:宿主导出齐全返回空表', () => {
  assert.deepEqual(missingHostExports(realDshLlm), [])
})

test('场景: 宿主 settings 服务面缺 installSection(rc.2 形态),apply 干净禁用不注册', async () => {
  const { ctx, logs, llmCalls, installed } = makeCtx({ legacySettings: true })
  await apply(ctx, undefined, OFFICIAL_MISSING)
  assert.match(logs.warn.join('\n'), /settings 服务缺少 installSection/)
  assert.deepEqual(installed, [], '禁用态不得安装任何 settings 节')
  assert.deepEqual(llmCalls.adapters, [], '禁用态不得注册 adapter')
  assert.deepEqual(llmCalls.discovery, [], '禁用态不得注册 discovery')
})

test('探测清单:缺失任一必备导出即报告其名,双缺报告两名', () => {
  const partial = { ...realDshLlm, offloadedImageText: undefined }
  assert.deepEqual(missingHostExports(partial), ['offloadedImageText'])
  const bare = {}
  assert.deepEqual(missingHostExports(bare), ['resolveImageAttachmentAccess', 'offloadedImageText'])
})

// 假宿主:settings 安装记录可注入接管失败形态,llm 注册与 logger 全程 spy。
const CONFLICT_MESSAGE_FORM = (ns) => `settings namespace "${ns}" is already registered`

function makeCtx({ officialInstallFailure, officialDiscoveryPresent, legacySettings = false } = {}) {
  const logs = { warn: [], error: [] }
  const installed = []
  const hooksByNs = {}
  const llmCalls = { adapters: [], adapterReplaces: 0, directories: 0, discovery: [] }
  const sectionValues = {}
  const discoveries = new Set()
  if (officialDiscoveryPresent) discoveries.add(OFFICIAL_SETTINGS_NS)
  const ctx = {
    logger: {
      warn: (message) => logs.warn.push(message),
      error: (message) => logs.error.push(message),
    },
    get: () => undefined,
    llm: {
      registerAdapter: (providers) => {
        llmCalls.adapters.push(providers)
        return { replace: () => { llmCalls.adapterReplaces += 1 } }
      },
      registerConfigurableProviders: () => {
        llmCalls.directories += 1
        return { replace: () => {} }
      },
      // 宿主真契约:同 ns 重复注册硬抛 DUPLICATE_DISCOVERY(dsh-llm lib 同构)
      registerModelDiscovery: (ns) => {
        if (discoveries.has(ns)) {
          throw new Error(`model discovery for "${ns}" is already registered`)
        }
        discoveries.add(ns)
        llmCalls.discovery.push(ns)
      },
    },
    settings: legacySettings
      ? {}
      : {
          installSection: (target, ns, schema, config, hooks) => {
            if (ns === OFFICIAL_SETTINGS_NS && officialInstallFailure !== undefined) {
              throw officialInstallFailure()
            }
            installed.push(ns)
            hooksByNs[ns] = hooks
            hooks.setSource(() => sectionValues[ns] ?? config)
          },
        },
  }
  return { ctx, logs, installed, hooksByNs, llmCalls, sectionValues }
}

function gatewayConfig() {
  return {
    providers: {
      'new-api': {
        api: 'anthropic-messages',
        baseURL: 'https://gw.example.com',
        models: [{ id: 'auto' }],
      },
    },
  }
}

const OFFICIAL_MISSING = async () => ({})
const OFFICIAL_STUB = async () => ({ Config: {} })
const officialBroken = async () => { throw new Error('module not found') }

test('场景: importOfficial 返回空对象,apply 跳过官方节,settings 仅装本包节且 hooks 可用', async () => {
  const { ctx, logs, installed, hooksByNs } = makeCtx()
  await apply(ctx, undefined, OFFICIAL_MISSING)
  assert.match(logs.warn.join('\n'), /官方 dsh-llm-pi-ai 不可用/)
  assert.deepEqual(installed, [SETTINGS_NS])
  const hooks = hooksByNs[SETTINGS_NS]
  for (const hook of ['validate', 'setSource', 'onChange']) {
    assert.equal(typeof hooks[hook], 'function', `本包节 hooks.${hook} 应已挂上`)
  }
})

test('场景: importOfficial reject,apply 不抛,降级告警后只装本包节', async () => {
  const { ctx, logs, installed } = makeCtx()
  await apply(ctx, undefined, officialBroken)
  assert.match(logs.warn.join('\n'), /官方 dsh-llm-pi-ai 不可用/)
  assert.deepEqual(installed, [SETTINGS_NS])
})

test('场景: 官方节接管遇 settings namespace 冲突,error 首参为冲突文案,本包节照常安装', async () => {
  const { ctx, logs, installed } = makeCtx({
    officialInstallFailure: () => new Error(CONFLICT_MESSAGE_FORM(OFFICIAL_SETTINGS_NS)),
  })
  await apply(ctx, undefined, OFFICIAL_STUB)
  assert.match(logs.error[0], /官方 llm-pi-ai 插件仍在/)
  assert.ok(installed.includes(SETTINGS_NS), '冲突降级后本包节仍必须安装')
})

test('场景: 官方节接管抛普通错误,error 首参为通用接管失败文案', async () => {
  const { ctx, logs } = makeCtx({
    officialInstallFailure: () => new Error('disk on fire'),
  })
  await apply(ctx, undefined, OFFICIAL_STUB)
  assert.match(logs.error[0], /接管失败/)
  assert.equal(/官方 llm-pi-ai 插件仍在/.test(logs.error[0]), false)
})

test('场景: onChange 后配置不可解析,logger 报保留先前注册且 apply 已不炸返回', async () => {
  const { ctx, logs, llmCalls, hooksByNs, sectionValues } = makeCtx()
  await apply(ctx, gatewayConfig(), OFFICIAL_MISSING)
  assert.deepEqual(llmCalls.adapters, [['new-api']], '启动期合法配置应注册一次')
  sectionValues[SETTINGS_NS] = {
    providers: { 'new-api': { api: 'no-such-protocol', baseURL: 'https://gw.example.com', models: [{ id: 'auto' }] } },
  }
  hooksByNs[SETTINGS_NS].onChange()
  const text = logs.error.join('\n')
  assert.match(text, /拒绝的更新后保留先前注册/)
  assert.match(text, /拒绝的更新后保留先前的可配置目录/)
  assert.equal(llmCalls.adapters.length, 1, '坏配置不得触发重复注册')
})

test('场景: 官方包缺失,discovery 双 ns 注册为 [本包节, 官方节]', async () => {
  const { ctx, llmCalls } = makeCtx()
  await apply(ctx, undefined, OFFICIAL_MISSING)
  assert.deepEqual(llmCalls.discovery, [SETTINGS_NS, OFFICIAL_SETTINGS_NS], '官方 ns 必须补注册,否则官方节配置面拉取模型必失败')
})

test('场景: 官方插件仍在(discovery 已占官方 ns),注册冲突降级告警且 apply 不炸', async () => {
  const { ctx, logs, llmCalls, installed } = makeCtx({ officialDiscoveryPresent: true })
  await apply(ctx, gatewayConfig(), OFFICIAL_STUB)
  assert.match(logs.warn.join('\n'), /官方 discovery 注册冲突/)
  assert.deepEqual(llmCalls.discovery, [SETTINGS_NS], '冲突时只保留本包 ns 注册')
  assert.ok(installed.includes(SETTINGS_NS), 'discovery 冲突不得阻断 settings 节安装')
})
