import assert from 'node:assert/strict'
import { test } from 'node:test'
import { detectRuntimeEnv, RUNTIME_KINDS } from '../src/runtime.mjs'

const POSIX = 'linux'
const WIN32 = 'win32'
const BOTH_TTY = { stdin: true, stdout: true }
const NO_TTY = { stdin: false, stdout: false }
const noProbes = { existsImpl: async () => false, readFileImpl: async () => { throw new Error('ENOENT') } }

test('环境检测:env 覆盖最高优先', async () => {
  const managed = await detectRuntimeEnv({ env: { DSH_MAINTAIN_RUNTIME_ENV: 'managed', pm_id: '0' }, platform: POSIX, isTTY: BOTH_TTY, ...noProbes })
  assert.deepEqual(managed, { kind: RUNTIME_KINDS.DECLARED_MANAGED, declared: true })
  const manual = await detectRuntimeEnv({ env: { DSH_MAINTAIN_RUNTIME_ENV: 'manual', pm_id: '0' }, platform: POSIX, isTTY: NO_TTY, ...noProbes })
  assert.deepEqual(manual, { kind: RUNTIME_KINDS.MANUAL_START, declared: false })
  // 非法覆盖值不生效,继续走常规判定
  const bogus = await detectRuntimeEnv({ env: { DSH_MAINTAIN_RUNTIME_ENV: 'sideways' }, platform: POSIX, isTTY: NO_TTY, ...noProbes })
  assert.deepEqual(bogus, { kind: RUNTIME_KINDS.UNKNOWN, declared: false })
})

test('环境检测:env 表命中各托管形态', async () => {
  const table = [
    [{ pm_id: '0' }, RUNTIME_KINDS.PM2],
    [{ PM2_HOME: 'C:/pm2' }, RUNTIME_KINDS.PM2],
    [{ pm_uptime: '123' }, RUNTIME_KINDS.PM2],
    [{ INVOCATION_ID: 'x' }, RUNTIME_KINDS.SYSTEMD],
    [{ JOURNAL_STREAM: '9' }, RUNTIME_KINDS.SYSTEMD],
    [{ NOTIFY_SOCKET: '/run/notify' }, RUNTIME_KINDS.SYSTEMD],
    [{ SUPERVISOR_ENABLED: '1' }, RUNTIME_KINDS.SUPERVISORD],
    [{ SUPERVISOR_PROCESS_NAME: 'dsh' }, RUNTIME_KINDS.SUPERVISORD],
    [{ KUBERNETES_SERVICE_HOST: '10.0.0.1' }, RUNTIME_KINDS.KUBERNETES],
  ]
  for (const [env, kind] of table) {
    const result = await detectRuntimeEnv({ env, platform: POSIX, isTTY: NO_TTY, ...noProbes })
    assert.deepEqual(result, { kind, declared: true }, JSON.stringify(env))
  }
  // 空串环境值不构成声明
  const empty = await detectRuntimeEnv({ env: { pm_id: '' }, platform: POSIX, isTTY: NO_TTY, ...noProbes })
  assert.deepEqual(empty, { kind: RUNTIME_KINDS.UNKNOWN, declared: false })
})

test('环境检测:POSIX 容器探测', async () => {
  const docker = await detectRuntimeEnv({ env: {}, platform: POSIX, isTTY: NO_TTY, existsImpl: async (p) => p === '/.dockerenv', readFileImpl: async () => { throw new Error('ENOENT') } })
  assert.deepEqual(docker, { kind: RUNTIME_KINDS.DOCKER, declared: true })
  for (const [marker, kind] of [['/docker/', RUNTIME_KINDS.DOCKER], ['kubepods', RUNTIME_KINDS.KUBERNETES], ['containerd', RUNTIME_KINDS.CONTAINER], ['lxc', RUNTIME_KINDS.CONTAINER], ['podman', RUNTIME_KINDS.CONTAINER]]) {
    const result = await detectRuntimeEnv({ env: {}, platform: POSIX, isTTY: NO_TTY, existsImpl: async () => false, readFileImpl: async () => '12:pids:/sys/fs/cgroup/' + marker + 'abc' })
    assert.deepEqual(result, { kind, declared: true }, marker)
  }
  // 探测器异常不致命,继续后续判定
  const broken = await detectRuntimeEnv({ env: {}, platform: POSIX, isTTY: NO_TTY, existsImpl: async () => { throw new Error('EACCES') }, readFileImpl: async () => { throw new Error('EACCES') } })
  assert.deepEqual(broken, { kind: RUNTIME_KINDS.UNKNOWN, declared: false })
})

test('环境检测:win32 跳过 POSIX 探测', async () => {
  const win = await detectRuntimeEnv({ env: {}, platform: WIN32, isTTY: NO_TTY, existsImpl: async () => true, readFileImpl: async () => '/docker/xyz' })
  assert.deepEqual(win, { kind: RUNTIME_KINDS.UNKNOWN, declared: false })
})

test('环境检测:双 TTY 判手动直跑,单 TTY 不构成', async () => {
  const both = await detectRuntimeEnv({ env: {}, platform: POSIX, isTTY: BOTH_TTY, ...noProbes })
  assert.deepEqual(both, { kind: RUNTIME_KINDS.MANUAL_START, declared: false })
  const stdinOnly = await detectRuntimeEnv({ env: {}, platform: POSIX, isTTY: { stdin: true, stdout: false }, ...noProbes })
  assert.deepEqual(stdinOnly, { kind: RUNTIME_KINDS.UNKNOWN, declared: false })
  // 托管声明优先于 TTY
  const declaredWithTty = await detectRuntimeEnv({ env: { pm_id: '0' }, platform: POSIX, isTTY: BOTH_TTY, ...noProbes })
  assert.deepEqual(declaredWithTty, { kind: RUNTIME_KINDS.PM2, declared: true })
})
