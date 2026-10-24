import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFile, writeFile, mkdir, mkdtemp, rename } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import os from 'node:os'

const target = process.argv[2]
assert.ok(target, '用法：node scripts/diagnostics/apply-browser-scope-patch.mjs <浏览器插件包目录>')
const patchDir = path.resolve(import.meta.dirname, '../patches/browser-session-scope')
const manifest = JSON.parse(await readFile(path.join(patchDir, 'manifest.json'), 'utf8'))
const pkg = JSON.parse(await readFile(path.join(target, 'package.json'), 'utf8'))
assert.equal(pkg.name, manifest.package)
assert.equal(pkg.version, manifest.version)
const entry = path.join(target, 'lib/index.js')
const original = await readFile(entry)
const sha = content => createHash('sha256').update(content).digest('hex')
if (sha(original) === manifest.patchedSha256) {
  console.log('补丁已应用，无需改写')
} else {
  assert.equal(sha(original), manifest.originalSha256, '入口文件已变化，拒绝覆盖；需重新审查补丁')
  const temp = await mkdtemp(path.join(os.tmpdir(), 'browser-scope-patch-'))
  await mkdir(path.join(temp, 'lib'))
  await writeFile(path.join(temp, 'lib/index.js'), original)
  const patch = await readFile(path.join(patchDir, 'runtime.patch'))
  execFileSync('git', ['apply', '--check', '--unsafe-paths', '-'], { cwd: temp, input: patch })
  execFileSync('git', ['apply', '--unsafe-paths', '-'], { cwd: temp, input: patch })
  const patched = await readFile(path.join(temp, 'lib/index.js'))
  assert.equal(sha(patched), manifest.patchedSha256, '补丁产物校验不一致')
  execFileSync(process.execPath, ['--check', path.join(temp, 'lib/index.js')])
  const backup = `${entry}.before-session-scope-${Date.now()}`
  await writeFile(backup, original, { flag: 'wx' })
  const staging = `${entry}.session-scope-${process.pid}.tmp`
  await writeFile(staging, patched, { flag: 'wx' })
  assert.equal(sha(await readFile(entry)), manifest.originalSha256, '备份后入口被并行修改，拒绝覆盖')
  await rename(staging, entry)
  console.log(JSON.stringify({ entry, backup, sha256: sha(patched), runtimeReloaded: false }))
}
