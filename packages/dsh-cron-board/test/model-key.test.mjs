// 模型表单态 key 序列化行为锁定:分隔符碰撞安全 + 往返还原 + 残缺形态回退。
// BDD:给定模型对象,序列化为表单 key;给定 key,还原模型对象;id 含历史分隔符 | 时不得错位。

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const client = readFileSync(join(pkgRoot, 'src', 'client.js'), 'utf8')
const begin = client.indexOf('/* MODELKEY-BEGIN */')
const end = client.indexOf('/* MODELKEY-END */')
assert.ok(begin >= 0 && end > begin, 'client.js 缺少 MODELKEY 标记段')
const block = client.slice(begin, end)
const { serializeModelKey, parseModelKey, MODEL_KEY_SEP } = new Function(
  block + '; return { serializeModelKey, parseModelKey, MODEL_KEY_SEP }',
)()

test('model-key:完整对象序列化含 effort,往返还原一致', () => {
  const key = serializeModelKey({ provider: 'p1', model: 'm1', reasoningEffort: 'high' })
  assert.equal(key, 'p1' + MODEL_KEY_SEP + 'm1' + MODEL_KEY_SEP + 'high')
  assert.deepEqual(parseModelKey(key), { provider: 'p1', model: 'm1', reasoningEffort: 'high' })
})

test('model-key:无 effort 序列化,还原无 effort 字段(空段即跟随模型默认)', () => {
  const key = serializeModelKey({ provider: 'p1', model: 'm2' })
  assert.equal(key, 'p1' + MODEL_KEY_SEP + 'm2' + MODEL_KEY_SEP)
  assert.deepEqual(parseModelKey(key), { provider: 'p1', model: 'm2' })
})

test('model-key:id 含历史分隔符 | 时不错位(阻断2回归)', () => {
  const key = serializeModelKey({ provider: 'a|b', model: 'm' })
  const parsed = parseModelKey(key)
  assert.deepEqual(parsed, { provider: 'a|b', model: 'm' })
})

test('model-key:残缺形态回退空串/undefined(跟随宿主默认)', () => {
  assert.equal(serializeModelKey(undefined), '')
  assert.equal(serializeModelKey({ provider: '', model: 'm' }), '')
  assert.equal(parseModelKey(''), undefined)
  assert.equal(parseModelKey('solo'), undefined)
  assert.equal(parseModelKey(undefined), undefined)
})

test('model-key:目录选项 value 经 serializeModelKey 构造可被 parse 还原(阻断2回归·第三侧)', () => {
  // 镜像 JobForm 选项构造形态:provider+模型 id(+默认 effort),还原后与选择对象一致
  const buildOptionValue = (group, model) => serializeModelKey({
    provider: group.provider,
    model: model.id,
    ...(model.efforts.length > 0 && model.defaultEffort ? { reasoningEffort: model.defaultEffort } : {}),
  })
  const plain = buildOptionValue({ provider: 'deepseek' }, { id: 'chat', efforts: [] })
  assert.deepEqual(parseModelKey(plain), { provider: 'deepseek', model: 'chat' })
  const withDefault = buildOptionValue({ provider: 'deepseek' }, { id: 'reason', efforts: [{ id: 'high' }], defaultEffort: 'high' })
  assert.deepEqual(parseModelKey(withDefault), { provider: 'deepseek', model: 'reason', reasoningEffort: 'high' })
})
