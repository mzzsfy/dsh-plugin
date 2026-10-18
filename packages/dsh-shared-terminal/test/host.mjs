import { createRequire } from 'node:module'
import { readFile, realpath } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { SUPPORTED_VERSIONS } from '../src/index.js'

export const hostRequire = createRequire(process.env.DSH_TEST_HOST
  ? resolve(process.env.DSH_TEST_HOST, 'package.json')
  : import.meta.url)
const entry = await realpath(hostRequire.resolve('@deepseek-ai/dsh-tools'))
const manifest = JSON.parse(await readFile(createRequire(entry).resolve('@deepseek-ai/dsh-tools/package.json'), 'utf8'))
if (!SUPPORTED_VERSIONS.includes(manifest.version)) throw new Error(`Tests require supported Tools (${SUPPORTED_VERSIONS.join(' / ')}); found ${manifest.version}`)
export const { defineTool, validateJsonSchemaValue } = await import(pathToFileURL(entry).href)
