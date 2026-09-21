// buildClientEnv:spawn env 构造纯函数。BDD 场景见 docs/feat-shell-select-optim/plan.md S1-S4。
// 三层并集:内置覆盖集 < 条目 env(用户客户端配置,如 MSYSTEM) < 调用方 env(spec.env+dshEnv)。
// wsl 追加键 = 条目与调用方全部键(WSLENV 本身除外);调用方显式 WSLENV 优先于继承值。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildClientEnv, ENV_OVERRIDES } from '../src/executor.mjs'

test('pwsh 形:DSH_* 直接并入,不动 WSLENV', () => {
  const env = buildClientEnv('pwsh', { DSH_WORKSPACE: 'C:\\w' })
  assert.equal(env.DSH_WORKSPACE, 'C:\\w')
  assert.equal(env.WSLENV, undefined)
  assert.equal(env.NO_COLOR, '1')
})

test('S1 bash 条目 env 并存:MSYSTEM 注入且内置覆盖集仍在', () => {
  const env = buildClientEnv('bash', undefined, { MSYSTEM: 'MINGW64' })
  assert.equal(env.MSYSTEM, 'MINGW64')
  assert.equal(env.NO_COLOR, '1')
  assert.equal(env.PAGER, 'cat')
})

test('S2 三层优先级:条目压内置,调用方压条目', () => {
  const overridden = buildClientEnv('pwsh', undefined, { NO_COLOR: '0' })
  assert.equal(overridden.NO_COLOR, '0')
  const callerWins = buildClientEnv('pwsh', { NO_COLOR: '2' }, { NO_COLOR: '0' })
  assert.equal(callerWins.NO_COLOR, '2')
})

test('S3 wsl 条目 env 键追加进 WSLENV,与 DSH_* 键并存', () => {
  const env = buildClientEnv('wsl', { DSH_X: '1' }, { MSYSTEM: 'MINGW64' }, { inheritedWslenv: 'WT_SESSION:' })
  assert.equal(env.WSLENV, 'WT_SESSION:MSYSTEM:DSH_X')
})

test('S4 非 wsl 形条目 env 不触发 WSLENV', () => {
  const env = buildClientEnv('bash', undefined, { MSYSTEM: 'MINGW64' }, { inheritedWslenv: 'WT_SESSION:' })
  assert.equal(env.WSLENV, undefined)
})

test('wsl 形:DSH_* 键追加进 WSLENV,继承条目保留,无空段', () => {
  const env = buildClientEnv('wsl', { DSH_WORKSPACE: 'C:\\w' }, undefined, { inheritedWslenv: 'WT_SESSION:WT_PROFILE_ID:' })
  assert.equal(env.DSH_WORKSPACE, 'C:\\w')
  assert.equal(env.WSLENV, 'WT_SESSION:WT_PROFILE_ID:DSH_WORKSPACE')
})

test('wsl 形:无追加键时 WSLENV 原样继承', () => {
  const env = buildClientEnv('wsl', undefined, undefined, { inheritedWslenv: 'WT_SESSION:' })
  assert.equal(env.WSLENV, 'WT_SESSION:')
})

test('wsl 形:调用方显式 WSLENV 优先于继承值', () => {
  const env = buildClientEnv('wsl', { DSH_X: '1', WSLENV: 'A' }, undefined, { inheritedWslenv: 'B' })
  assert.equal(env.WSLENV, 'A:DSH_X')
})

test('条目显式 WSLENV 优先于继承值,追加键去重保留', () => {
  const env = buildClientEnv('wsl', { DSH_X: '1' }, { WSLENV: 'E', MSYSTEM: 'MINGW64' }, { inheritedWslenv: 'WT_SESSION:MSYSTEM:' })
  assert.equal(env.WSLENV, 'E:MSYSTEM:DSH_X')
})

test('继承值已含的追加键不产生重复段', () => {
  const env = buildClientEnv('wsl', { DSH_X: '1' }, { MSYSTEM: 'MINGW64' }, { inheritedWslenv: 'WT:DSH_X:' })
  assert.equal(env.WSLENV, 'WT:DSH_X:MSYSTEM')
})

test('wsl 形:无继承无显式时从空构建,无空条目', () => {
  const env = buildClientEnv('wsl', { DSH_X: '1' }, undefined, { inheritedWslenv: undefined })
  assert.equal(env.WSLENV, 'DSH_X')
})

test('非 wsl 形不受 inheritedWslenv 影响', () => {
  const env = buildClientEnv('bash', { DSH_X: '1' }, undefined, { inheritedWslenv: 'B' })
  assert.equal(env.WSLENV, undefined)
})

test('覆盖集始终在场且可被 dshEnv 覆盖', () => {
  const env = buildClientEnv('cmd', { PAGER: 'more' })
  assert.equal(env.NO_COLOR, '1')
  assert.equal(env.PAGER, 'more')
  assert.deepEqual(Object.keys(ENV_OVERRIDES).sort(), ['GIT_PAGER', 'NO_COLOR', 'PAGER'])
})
