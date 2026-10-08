// 后台 job owner 必须传 agent id(场景:run_in_background 报 "[object Object] has no live agent"):源级守卫
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'src', 'tool.mjs'), 'utf8')

test('后台 job owner 传 agent id 而非 agent 对象', () => {
  assert.match(source, /owner: exec\.agent\.id/)
  assert.doesNotMatch(source, /owner: exec\.agent \}/)
})
