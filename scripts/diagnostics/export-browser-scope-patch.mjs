import { execFileSync } from 'node:child_process'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'

const source = path.resolve(process.argv[2] ?? '.compat/browser-tool-sync-source')
const installed = process.argv[3]
if (!installed) throw new Error('需要原始浏览器包目录作为第二参数')
const output = path.resolve('scripts/patches/browser-session-scope')
await mkdir(output, { recursive: true })
const sourcePatch = execFileSync('git', ['diff', '--', 'src/index.ts', 'src/toolTiers.ts', 'tests/tier-mount.test.ts'], { cwd: source, encoding: 'utf8' })
await writeFile(path.join(output, 'source.patch'), sourcePatch)
let builtPatch
try {
  builtPatch = execFileSync('git', ['diff', '--no-index', '--', path.join(installed, 'lib/index.js'), path.join(source, 'lib/index.js')], { encoding: 'utf8' })
} catch (error) {
  if (error.status !== 1) throw error
  builtPatch = error.stdout
}
builtPatch = builtPatch.replace(/^diff --git .*$/m, 'diff --git a/lib/index.js b/lib/index.js')
  .replace(/^--- .*$/m, '--- a/lib/index.js').replace(/^\+\+\+ .*$/m, '+++ b/lib/index.js')
await writeFile(path.join(output, 'runtime.patch'), builtPatch)
const sha = async file => createHash('sha256').update(await readFile(file)).digest('hex')
await writeFile(path.join(output, 'manifest.json'), JSON.stringify({
  package: 'dsh-browser-cdp', version: '1.6.0',
  upstreamCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim(),
  originalSha256: await sha(path.join(installed, 'lib/index.js')),
  patchedSha256: await sha(path.join(source, 'lib/index.js')),
}, null, 2) + '\n')
console.log(output)
