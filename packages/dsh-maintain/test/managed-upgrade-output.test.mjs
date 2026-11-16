import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLayout } from '../src/managed-layout.mjs'

async function setup(t) {
  const prefix = await mkdtemp(join(tmpdir(), 'maintain-output-test-'))
  t.after(() => rm(prefix, { recursive: true, force: true }))
  const root = join(prefix, '.dsh-maintain')
  await mkdir(root, { recursive: true })
  const originalPackage = process.platform === 'win32'
    ? join(prefix, 'node_modules/@deepseek-ai/dsh')
    : join(prefix, 'lib/node_modules/@deepseek-ai/dsh')
  await mkdir(join(originalPackage, 'lib'), { recursive: true })
  await writeFile(join(originalPackage, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '1.0.0', bin: { dsh: 'lib/bin.js' } }))
  await writeFile(join(originalPackage, 'lib/bin.js'), 'original')
  if (process.platform === 'win32') await writeFile(join(prefix, 'dsh.cmd'), '@"%dp0%node.exe" "%dp0%node_modules\\@deepseek-ai\\dsh\\lib\\bin.js" %*')
  else {
    await mkdir(join(prefix, 'bin'), { recursive: true })
    await symlink(join(originalPackage, 'lib/bin.js'), join(prefix, 'bin/dsh'))
  }
  const layout = Object.freeze({ ...(await createLayout({ prefix, originalPackage, platform: process.platform })), root })
  return { prefix, root, layout, originalPackage }
}

test('performManagedUpgrade:安装输出经 onOutput 透传,state 记录 previousVersion', async (t) => {
  const f = await setup(t)
  const { performManagedUpgrade } = await import('../src/managed-upgrade.mjs')
  const outputs = []
  const result = await performManagedUpgrade({
    ...f,
    runningPackage: f.originalPackage,
    previousVersion: '1.0.0',
    targetVersion: '2.0.0',
    install: async (args) => {
      args.onOutput?.('npm\n')
      const pkg = join(args.slot, 'node_modules/@deepseek-ai/dsh')
      await mkdir(join(pkg, 'lib'), { recursive: true })
      await writeFile(join(pkg, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: args.version, bin: { dsh: 'lib/bin.js' } }))
      await writeFile(join(pkg, 'lib/bin.js'), 'candidate')
      return { ok: true, code: 0 }
    },
    validate: async () => ({ ok: true, code: 0 }),
    beforeSwitch: async () => {},
    onOutput: (chunk) => outputs.push(chunk),
  })
  assert.equal(result.switched, true)
  assert.deepEqual(outputs, ['npm\n'])
  const state = JSON.parse(await readFile(join(f.root, 'state.json'), 'utf8'))
  assert.equal(state.previousVersion, '1.0.0')
  assert.equal(state.phase, 'awaiting-restart')
})
