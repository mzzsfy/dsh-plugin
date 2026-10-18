import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { readdirSync, realpathSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SUPPORTED_VERSIONS } from '../src/index.js'

const here = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(here, '..')
const require = createRequire(import.meta.url)
const host = process.argv[2] ?? process.env.DSH_TEST_HOST
const hostRequire = host
  ? createRequire(resolve(host, 'package.json'))
  : createRequire(realpathSync(require.resolve('@deepseek-ai/dsh-tools')))
const manifestPath = hostRequire.resolve('@deepseek-ai/dsh-api-terminal-controller/package.json')
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
if (!SUPPORTED_VERSIONS.includes(manifest.version)) throw new Error(`Tests require supported Controller (${SUPPORTED_VERSIONS.join(' / ')}); found ${manifest.version}`)
const moduleRoot = resolve(dirname(manifestPath), '../..')
const files = readdirSync(here).filter((name) => name.endsWith('.test.mjs')).map((name) => resolve(here, name))
const result = spawnSync(process.execPath, ['--test', ...files], {
  cwd: packageRoot,
  env: { ...process.env, DSH_TEST_HOST: host ? resolve(host) : undefined, NODE_PATH: moduleRoot },
  stdio: 'inherit',
})
if (result.error) throw result.error
process.exitCode = result.status ?? 1
