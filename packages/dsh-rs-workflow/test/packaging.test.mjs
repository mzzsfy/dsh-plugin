// 打包回归:lib 运行时按包根路径读取的数据文件必须进 tarball——files 白名单漏项 = 安装即坏,
// 1.0.0 即因漏 engine/ 与 preset/ 而发布损坏(runner.mjs 模块顶层读取,加载直接 ENOENT)。
// lib 内新增包根数据文件读取时,必须同步 REQUIRED 清单。
import { execSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import assert from 'node:assert/strict'

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

// lib 内运行时读取的包根数据文件 → 读取方
const REQUIRED = [
  ['engine/flow-exec.js', 'lib/driver/runner.mjs'],
  ['preset/rs-workflow/agent.cordis.yml', 'lib/release.mjs'],
]

const packReport = JSON.parse(execSync('npm pack --dry-run --json', { cwd: PKG_ROOT, encoding: 'utf8' }))[0]

for (const [rel, reader] of REQUIRED) {
  test(`tarball 包含 ${rel}`, () => {
    const paths = packReport.files.map((f) => f.path.replaceAll('\\', '/'))
    assert.ok(paths.includes(rel), `files 白名单漏掉 ${rel},安装后 ${reader} 读取即 ENOENT`)
  })
}
