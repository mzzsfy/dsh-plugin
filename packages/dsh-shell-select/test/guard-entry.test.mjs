// guard 入口集成(桩 ctx):安装 → 死态代挂两个官方行 → 复活卸载 → 官方包缺失停用。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { installGuard } from '../src/guard.js'
import { MAIN_ROW_ID, OFFICIAL_ROW_IDS } from '../src/guard-state.mjs'
import { shellSelectApplyState, shellSelectExecutorFiber } from '../src/apply-state.mjs'

function row({ id, disabled = false, running = false }) {
  const entry = {
    options: { id },
    _disabled: disabled,
    updates: [],
    get disabled() {
      return entry._disabled
    },
    fiber: running ? { uid: 'f' } : undefined,
    async update(patch) {
      entry.updates.push(patch)
      entry._disabled = patch.disabled
    },
  }
  return entry
}

function stubCtx({ rows, importOfficial }) {
  const log = []
  const mounts = []
  const listeners = new Map()
  const ctx = {
    logger: {
      warn: (msg) => log.push(['warn', msg]),
      error: (msg) => log.push(['error', msg]),
      info: (msg) => log.push(['info', msg]),
    },
    loader: {
      resolve(id) {
        const found = rows.find((candidate) => candidate.options.id === id)
        if (found) return found
        throw new Error('not found')
      },
    },
    on(event, handler) {
      listeners.set(event, handler)
    },
    plugin(module, config) {
      mounts.push({ moduleName: module.__name, config })
      return Promise.resolve({
        dispose: () => {
          mounts.length = 0
          return Promise.resolve()
        },
      })
    },
    effect(execute) {
      return execute()
    },
  }
  return { ctx, log, mounts, listeners }
}

const OFFICIAL_MODULE = (name) => ({ __name: name, name, apply() {} })

function makeImport() {
  return async (packageName) => OFFICIAL_MODULE(packageName)
}

function deadWorld() {
  return [
    row({ id: MAIN_ROW_ID, disabled: true }),
    row({ id: 'tool-pwsh', disabled: true }),
    row({ id: 'pwsh-sandbox', disabled: true }),
  ]
}

test('死态安装:代挂两个官方行(pwsh-sandbox 配置读空文档)', async () => {
  const { ctx, mounts, log } = stubCtx({ rows: deadWorld(), importOfficial: makeImport() })
  await installGuard(ctx, {
    importOfficial: makeImport(),
    delay: async () => {},
    sweepIntervalMs: 10 * 3600 * 1000,
  })
  assert.equal(mounts.length, 2)
  assert.deepEqual(mounts.map((mount) => mount.moduleName), ['@deepseek-ai/dsh-tool-pwsh', '@deepseek-ai/dsh-pwsh-sandbox'])
  assert.deepEqual(mounts[0].config, {})
  assert.deepEqual(mounts[1].config, {})
  assert.ok(log.some(([level, msg]) => level === 'warn' && msg.includes('代挂官方')))
})

test('非死态安装:不代挂', async () => {
  const rows = [
    row({ id: MAIN_ROW_ID }),
    row({ id: 'tool-pwsh', disabled: true }),
    row({ id: 'pwsh-sandbox', disabled: true }),
  ]
  const { ctx, mounts } = stubCtx({ rows })
  await installGuard(ctx, { importOfficial: makeImport(), delay: async () => {}, sweepIntervalMs: 3600 * 1000 })
  assert.equal(mounts.length, 0)
})

test('官方包加载失败:告警并停用自愈,不抛错不拖垮树', async () => {
  const { ctx, mounts, log } = stubCtx({ rows: deadWorld() })
  await installGuard(ctx, {
    importOfficial: async () => {
      throw new Error('module not found')
    },
    delay: async () => {},
  })
  assert.equal(mounts.length, 0)
  assert.ok(log.some(([level, msg]) => level === 'warn' && msg.includes('停用')))
})

test('复活边沿:受控行即将 init 时卸代挂再放行', async () => {
  const rows = deadWorld()
  const { ctx, mounts, listeners } = stubCtx({ rows })
  await installGuard(ctx, { importOfficial: makeImport(), delay: async () => {}, sweepIntervalMs: 3600 * 1000 })
  assert.equal(mounts.length, 2)
  const patchContext = listeners.get('loader/patch-context')
  assert.ok(typeof patchContext === 'function')
  // 复活行:主行 fiber 空(即将 init)→ guard 卸代挂后放行
  await patchContext(row({ id: MAIN_ROW_ID }), () => 'passed')
  assert.equal(mounts.length, 0)
})

test('运行主行使复活行跳过让位逻辑(事件快速返回)', async () => {
  const rows = deadWorld()
  const { ctx, mounts, listeners } = stubCtx({ rows })
  await installGuard(ctx, { importOfficial: makeImport(), delay: async () => {}, sweepIntervalMs: 3600 * 1000 })
  const patchContext = listeners.get('loader/patch-context')
  const runningEntry = row({ id: MAIN_ROW_ID, running: true })
  await patchContext(runningEntry, () => 'passed')
  assert.equal(mounts.length, 2)
})

test('apply 旗标:guard 引用的旗标模块可用', () => {
  assert.equal(shellSelectApplyState(), 'pending')
})

test('模块归一:apply 型模块直挂,default 类模块挂类(tool-pwsh/pwsh-sandbox 真实形态)', async () => {
  const applyShaped = { __name: '@deepseek-ai/dsh-tool-pwsh', name: 'tool-pwsh', apply() {}, Config: {}, inject: ['tools'] }
  const classShaped = { __name: '@deepseek-ai/dsh-pwsh-sandbox', default: class SandboxPwshExecutor {} }
  const modules = { '@deepseek-ai/dsh-tool-pwsh': applyShaped, '@deepseek-ai/dsh-pwsh-sandbox': classShaped }
  const mounted = []
  const { ctx } = stubCtx({ rows: deadWorld() })
  ctx.plugin = (plugin, config) => {
    mounted.push({ plugin, config })
    return Promise.resolve({ dispose: () => Promise.resolve() })
  }
  await installGuard(ctx, {
    importOfficial: async (packageName) => modules[packageName],
    delay: async () => {},
    sweepIntervalMs: 3600 * 1000,
  })
  assert.equal(mounted.length, 2)
  assert.equal(mounted[0].plugin, applyShaped)
  assert.equal(mounted[1].plugin, classShaped.default)
})

test('模块归一:两形态皆无的官方包按预载失败处理,停用自愈', async () => {
  const { ctx, mounts, log } = stubCtx({ rows: deadWorld() })
  await installGuard(ctx, {
    importOfficial: async () => ({ __name: 'shapeless' }),
    delay: async () => {},
  })
  assert.equal(mounts.length, 0)
  assert.ok(log.some(([level, msg]) => level === 'warn' && msg.includes('停用')))
})

// HOST-022(0.2.2 写事务重评 !!js 表达式):官方行翻回启用时先重禁;重禁
// 失败也不让位——写事务过程中撤执行器会把'翻回'放大成 shell 真空。
test('官方行翻回启用+执行器在场:重禁保持接管,不 dispose', async () => {
  const rows = [
    row({ id: MAIN_ROW_ID, disabled: false, running: true }),
    row({ id: 'tool-pwsh', disabled: true }),
    row({ id: 'pwsh-sandbox', disabled: false }),
  ]
  const { ctx, log, listeners } = stubCtx({ rows })
  await installGuard(ctx, { importOfficial: makeImport(), delay: async () => {}, sweepIntervalMs: 3600 * 1000 })
  const patchContext = listeners.get('loader/patch-context')
  let disposed = 0
  shellSelectExecutorFiber.current = { dispose: () => { disposed += 1; return Promise.resolve() } }
  try {
    await patchContext(rows[2], () => 'passed')
    assert.equal(disposed, 0)
    assert.notEqual(shellSelectExecutorFiber.current, undefined)
    assert.equal(rows[2]._disabled, true)
    assert.ok(log.some(([level, msg]) => level === 'warn' && msg.includes('重新禁用')))
  } finally {
    shellSelectExecutorFiber.current = undefined
  }
})

test('官方行保持禁用态 patch:零动作', async () => {
  const rows = [
    row({ id: MAIN_ROW_ID, disabled: false, running: true }),
    row({ id: 'tool-pwsh', disabled: true }),
    row({ id: 'pwsh-sandbox', disabled: true }),
  ]
  const { ctx, listeners } = stubCtx({ rows })
  await installGuard(ctx, { importOfficial: makeImport(), delay: async () => {}, sweepIntervalMs: 3600 * 1000 })
  const patchContext = listeners.get('loader/patch-context')
  let disposed = 0
  shellSelectExecutorFiber.current = { dispose: () => { disposed += 1; return Promise.resolve() } }
  try {
    await patchContext(rows[1], () => 'passed')
    assert.equal(disposed, 0)
    assert.notEqual(shellSelectExecutorFiber.current, undefined)
  } finally {
    shellSelectExecutorFiber.current = undefined
  }
})

test('句柄空缺(guard 代挂态):官方行翻回零动作', async () => {
  const rows = [
    row({ id: MAIN_ROW_ID, disabled: true }),
    row({ id: 'tool-pwsh', disabled: true }),
    row({ id: 'pwsh-sandbox', disabled: false }),
  ]
  const { ctx, listeners } = stubCtx({ rows })
  await installGuard(ctx, { importOfficial: makeImport(), delay: async () => {}, sweepIntervalMs: 3600 * 1000 })
  const patchContext = listeners.get('loader/patch-context')
  await patchContext(rows[2], () => 'passed')
  assert.equal(shellSelectExecutorFiber.current, undefined)
})

// H2 回归(策略更新):代挂态下官方行翻回启用(0.2.2 写事务)。此时撤代挂
// 让官方行激活,会与写事务重建过程抢 ctx.shell;官方行激活失败后没有第二个
// 服务方,终端真空只能重启。改为重禁保持代挂:写事务要么被宿主判失败,要么
// 行被重新禁用,代挂始终有服务可用。
test('HOST-022:代挂态下官方行翻回启用,重禁保持代挂不让位', async () => {
  const rows = deadWorld()
  const { ctx, mounts, listeners } = stubCtx({ rows })
  // 每个代挂 fiber 占用 shell 服务位:官方行 provide 时撞重复即失败(真实冲突形态)
  const provided = new Set()
  ctx.plugin = (module) => {
    const mount = { moduleName: module.__name }
    mounts.push(mount)
    provided.add('shell')
    return Promise.resolve({
      dispose: () => {
        mounts.splice(mounts.indexOf(mount), 1)
        if (mounts.length === 0) provided.delete('shell')
        return Promise.resolve()
      },
    })
  }
  await installGuard(ctx, { importOfficial: makeImport(), delay: async () => {}, sweepIntervalMs: 3600 * 1000 })
  assert.equal(mounts.length, 2)
  assert.equal(provided.has('shell'), true)
  // 陈旧句柄:主行被禁,执行器 fiber 已退役,句柄记账残留
  let disposed = 0
  shellSelectExecutorFiber.current = { dispose: () => { disposed += 1; return Promise.resolve() } }
  try {
    rows[2] = row({ id: 'pwsh-sandbox', disabled: false })
    const patchContext = listeners.get('loader/patch-context')
    let providedAtInit
    const next = () => {
      providedAtInit = provided.has('shell')
      return 'passed'
    }
    assert.equal(await patchContext(rows[2], next), 'passed')
    assert.equal(providedAtInit, true, '代挂占位保持,官方行激活交给写事务判失败')
    assert.equal(mounts.length, 2, 'guard 代挂记账保留')
    assert.equal(disposed, 0, '不让位,执行器句柄不退役')
    assert.equal(rows[2]._disabled, true, '官方行被重新禁用')
  } finally {
    shellSelectExecutorFiber.current = undefined
  }
})

// P2-37:代挂半失败时,已发起但未落定/落定在失败点之后的 fiber 也必须回收——
// 否则半挂 fiber 永不进账,长期占着 ctx.shell 与工具注册,下轮 sweep 重复
// provide 必抛,死态窗口更破碎。
test('P2-37 代挂半失败:在途 fiber 全部 allSettled 后逐个 dispose', async () => {
  // Given 死态 + 第二个官方插件的挂载抛错
  const { ctx, log } = stubCtx({ rows: deadWorld() })
  const disposed = []
  let call = 0
  ctx.plugin = (module) => {
    call += 1
    if (call === 1) {
      return Promise.resolve({ dispose: () => { disposed.push(module.__name); return Promise.resolve() } })
    }
    throw new Error('duplicate service: shell')
  }
  await installGuard(ctx, {
    importOfficial: makeImport(),
    delay: async () => {},
    timeouts: { mount: 50, load: 50 },
    sweepIntervalMs: 3600 * 1000,
  })
  // Then 已挂成的第一个 fiber 被回收(不留半套官方链),错误进排障面
  assert.deepEqual(disposed, ['@deepseek-ai/dsh-tool-pwsh'])
  assert.ok(log.some(([level, msg]) => level === 'error' && msg.includes('代挂官方插件失败')))
})

test('P2-37 代挂半失败:在途挂载超时同样回收已挂成部分', async () => {
  // Given 死态 + 第二个官方插件的挂载永不落定
  const { ctx, log } = stubCtx({ rows: deadWorld() })
  const disposed = []
  let call = 0
  ctx.plugin = (module) => {
    call += 1
    if (call === 1) {
      return Promise.resolve({ dispose: () => { disposed.push(module.__name); return Promise.resolve() } })
    }
    return new Promise(() => {})
  }
  await installGuard(ctx, {
    importOfficial: makeImport(),
    delay: async () => {},
    timeouts: { mount: 20, load: 50 },
    sweepIntervalMs: 3600 * 1000,
  })
  // Then 超时后仍回收已挂成部分(有界等待,不无限挂在 allSettled 上)
  assert.deepEqual(disposed, ['@deepseek-ai/dsh-tool-pwsh'])
  assert.ok(log.some(([level, msg]) => level === 'error' && msg.includes('代挂官方插件')))
})

// S5:回收等待窗口之外的迟到落定也必须回收——旧实现只等 2×mountTimeout,
// 更晚落定的半挂 fiber 永不 dispose,长期占着 ctx.shell 与工具注册,下轮
// sweep 再代挂即撞重复服务。
test('S5 代挂迟到落定(超出回收窗口):落定即回收,不留半挂 fiber', async () => {
  const waitFor = async (probe, rounds = 200) => {
    for (let round = 0; round < rounds; round += 1) {
      if (probe()) return true
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    return probe()
  }
  const { ctx, log } = stubCtx({ rows: deadWorld() })
  const disposed = []
  let call = 0
  let resolveLate
  ctx.plugin = (module) => {
    call += 1
    if (call === 1) {
      return Promise.resolve({ dispose: () => { disposed.push(module.__name); return Promise.resolve() } })
    }
    return new Promise((resolve) => { resolveLate = resolve })
  }
  await installGuard(ctx, {
    importOfficial: makeImport(),
    delay: async () => {},
    timeouts: { mount: 20, load: 50 },
    sweepIntervalMs: 3600 * 1000,
  })
  assert.equal(await waitFor(() => typeof resolveLate === 'function'), true, '第二个 fiber 已发起')
  // 越过分装载窗口与回收窗口(2×mountTimeout)后再落定
  await new Promise((resolve) => setTimeout(resolve, 80))
  assert.deepEqual(disposed, ['@deepseek-ai/dsh-tool-pwsh'], '窗口内已回收第一路')
  resolveLate({ dispose: () => { disposed.push('@deepseek-ai/dsh-pwsh-sandbox'); return Promise.resolve() } })
  assert.equal(await waitFor(() => disposed.length === 2), true, '迟到落定必须被回收')
  assert.deepEqual(disposed.sort(), ['@deepseek-ai/dsh-pwsh-sandbox', '@deepseek-ai/dsh-tool-pwsh'].sort())
  assert.ok(log.some(([level, msg]) => level === 'warn' && msg.includes('迟到落定')))
})

test('官方行求值抛错(disabledUnreliable):零动作安全向', async () => {
  const rows = [
    row({ id: MAIN_ROW_ID, disabled: false, running: true }),
    row({ id: 'tool-pwsh', disabled: true }),
    row({ id: 'pwsh-sandbox', disabled: true }),
  ]
  const { ctx, listeners } = stubCtx({ rows })
  await installGuard(ctx, { importOfficial: makeImport(), delay: async () => {}, sweepIntervalMs: 3600 * 1000 })
  const patchContext = listeners.get('loader/patch-context')
  let disposed = 0
  shellSelectExecutorFiber.current = { dispose: () => { disposed += 1; return Promise.resolve() } }
  try {
    const hostile = { options: { id: 'pwsh-sandbox' }, get disabled() { throw new Error('broken') }, fiber: undefined }
    await patchContext(hostile, () => 'passed')
    assert.equal(disposed, 0)
  } finally {
    shellSelectExecutorFiber.current = undefined
  }
})
