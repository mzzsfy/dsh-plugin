// resolve 候选探测:BDD 场景见 docs/progress/shell-select-plan.md「模块 resolve」。
// 平台差异经注入 env/platform 消除,测试不依赖真机安装布局。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { candidatePaths, resolveEntryPath, detectCandidates } from '../src/resolve.mjs'

// 桩 lstat:按路径集合判定存在,文件形态命中
function stubExists(existing) {
  const set = new Set(existing)
  return (candidate) => set.has(candidate)
}

const ENV = {
  ProgramFiles: 'C:\\PF',
  'ProgramFiles(x86)': 'C:\\PF86',
  LocalAppData: 'C:\\LAD',
  SystemRoot: 'C:\\WINDOWS',
  PATH: 'C:\\one;C:\\two ;"C:\\three"',
}

const ENV_WITH_SYSTEM32_PATH = {
  ...ENV,
  PATH: 'C:\\WINDOWS\\System32;C:\\one',
}

test('pwsh 候选顺序:PowerShell 7 → PATH 各项 → System32 5.1', () => {
  const candidates = candidatePaths('pwsh', ENV)
  assert.deepEqual(candidates, [
    'C:\\PF\\PowerShell\\7\\pwsh.exe',
    'C:\\one\\pwsh.exe',
    'C:\\two\\pwsh.exe',
    'C:\\three\\pwsh.exe',
    'C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  ])
})

test('bash 候选顺序:Git 三常见位置 → msys2 真实 bash → PATH', () => {
  const candidates = candidatePaths('bash', ENV)
  assert.deepEqual(candidates, [
    'C:\\PF\\Git\\bin\\bash.exe',
    'C:\\PF86\\Git\\bin\\bash.exe',
    'C:\\LAD\\Programs\\Git\\bin\\bash.exe',
    'C:\\msys64\\usr\\bin\\bash.exe',
    'C:\\msys64\\bin\\bash.exe',
    'C:\\one\\bash.exe',
    'C:\\two\\bash.exe',
    'C:\\three\\bash.exe',
  ])
})

test('bash 候选排除 SystemRoot 下的 PATH 条目(WSL forwarder)', () => {
  const candidates = candidatePaths('bash', ENV_WITH_SYSTEM32_PATH)
  assert.deepEqual(candidates, [
    'C:\\PF\\Git\\bin\\bash.exe',
    'C:\\PF86\\Git\\bin\\bash.exe',
    'C:\\LAD\\Programs\\Git\\bin\\bash.exe',
    'C:\\msys64\\usr\\bin\\bash.exe',
    'C:\\msys64\\bin\\bash.exe',
    'C:\\one\\bash.exe',
  ])
})

test('bash 候选排除 SystemRoot 下的正斜杠 PATH 条目', () => {
  const env = { ...ENV, PATH: 'C:/WINDOWS/System32;C:\\one' }
  const candidates = candidatePaths('bash', env)
  assert.ok(!candidates.some((candidate) => candidate.toLowerCase().startsWith('c:\\windows')))
  assert.ok(candidates.includes('C:\\one\\bash.exe'))
})

test('LocalAppData 缺省:LAD 锚位跳过,其余候选不受影响', () => {
  const env = { ProgramFiles: 'C:\\PF', 'ProgramFiles(x86)': 'C:\\PF86', LocalAppData: '', PATH: '' }
  const candidates = candidatePaths('bash', env)
  assert.ok(!candidates.some((candidate) => candidate.startsWith('\\\\')), 'LocalAppData 为空不得产出空根拼接候选')
  assert.ok(!candidates.some((candidate) => candidate.startsWith('undefined')))
  assert.ok(candidates.includes('C:\\PF\\Git\\bin\\bash.exe'))
  assert.ok(candidates.includes('C:\\msys64\\usr\\bin\\bash.exe'))
})

test('bash 候选永不含 msys2.exe 启动器(管道下静默失败)', () => {
  for (const candidate of candidatePaths('bash', ENV)) {
    assert.ok(!candidate.toLowerCase().includes('msys2.exe'), candidate)
  }
})

test('cmd/wsl 候选:仅 System32 单点', () => {
  assert.deepEqual(candidatePaths('cmd', ENV), ['C:\\WINDOWS\\System32\\cmd.exe'])
  assert.deepEqual(candidatePaths('wsl', ENV), ['C:\\WINDOWS\\System32\\wsl.exe'])
})

test('显式路径原样使用,不探测', () => {
  const resolved = resolveEntryPath({ kind: 'bash', path: 'D:\\tools\\my-bash.exe' }, stubExists([]))
  assert.equal(resolved, 'D:\\tools\\my-bash.exe')
})

test('自动解析命中首个存在候选', () => {
  const resolved = resolveEntryPath({ kind: 'bash', path: '' }, stubExists([
    'C:\\one\\bash.exe',
    'C:\\PF\\Git\\bin\\bash.exe',
  ]), ENV)
  assert.equal(resolved, 'C:\\PF\\Git\\bin\\bash.exe')
})

test('无候选存在返回 undefined', () => {
  assert.equal(resolveEntryPath({ kind: 'pwsh', path: '' }, stubExists([]), ENV), undefined)
})

test('detect 返回全部命中并去重', () => {
  const found = detectCandidates(['bash', 'cmd'], ENV, stubExists([
    'C:\\PF\\Git\\bin\\bash.exe',
    'C:\\three\\bash.exe',
    'C:\\WINDOWS\\System32\\cmd.exe',
  ]))
  assert.deepEqual(found, [
    { kind: 'bash', path: 'C:\\PF\\Git\\bin\\bash.exe' },
    { kind: 'bash', path: 'C:\\three\\bash.exe' },
    { kind: 'cmd', path: 'C:\\WINDOWS\\System32\\cmd.exe' },
  ])
})

test('detect 同路径跨 kind 不重复收录', () => {
  const found = detectCandidates(['pwsh', 'bash'], ENV, stubExists(['C:\\one\\bash.exe', 'C:\\one\\pwsh.exe']))
  assert.equal(found.length, 2)
})
