// 任务表单提交差异集行为锁定:编辑只提交 dirty 字段 + updatedAt 基线(服务端乐观锁),
// 并发上限空串提交 null(服务端删键),会话子对象仅在变化时整体提交且 modelKey 还原为对象。
// 全量重提旧快照会把他处变更(自动禁用/开关/会话绑定)静默回滚,是本文件守护的缺陷面。

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const client = readFileSync(join(pkgRoot, 'src', 'client.js'), 'utf8')

// 标记段按依赖顺序拼接求值(MODELKEY 提供 parseModelKey,JOBPATCH 消费它)
function markedSection(name) {
  const begin = client.indexOf('/* ' + name + '-BEGIN */')
  const end = client.indexOf('/* ' + name + '-END */')
  assert.ok(begin >= 0 && end > begin, 'client.js 缺少 ' + name + ' 标记段')
  return client.slice(begin + ('/* ' + name + '-BEGIN */').length, end)
}
const helpers = new Function(
  markedSection('MODELKEY') + markedSection('JOBPATCH')
  + '; return { jobCreatePayload, jobUpdatePayload, JOB_FORM_FIELDS, JOB_SESSION_FIELDS };',
)()

const BASELINE = {
  name: '日报',
  kind: 'shell',
  command: 'echo hi',
  prompt: '',
  workdir: '',
  schedule: '0 9 * * *',
  timeoutMs: 60 * 1000,
  runOnce: false,
  concurrency: '3',
  enabled: true,
  updatedAt: 1750000000000,
  session: { mode: 'fresh', pinnedSessionId: '', agentPreset: '', modelKey: '' },
}

function edit(patch) {
  const current = { ...BASELINE, ...patch }
  if (patch.session) current.session = { ...BASELINE.session, ...patch.session }
  return helpers.jobUpdatePayload(BASELINE, current)
}

test('job-patch:无改动只提交 updatedAt 基线(不重提任何字段)', () => {
  assert.deepEqual(edit({}), { updatedAt: BASELINE.updatedAt })
  // 多表达式计划同理:未改动时 schedule 字符串原样比较,不因多行被判脏
  const multi = { ...BASELINE, schedule: '0 9 * * *\n30 8 * * 1-5T+8' }
  assert.deepEqual(helpers.jobUpdatePayload(multi, { ...multi }), { updatedAt: BASELINE.updatedAt })
  // 计划行增减或改序即视为改动
  assert.deepEqual(
    helpers.jobUpdatePayload(multi, { ...multi, schedule: '30 8 * * 1-5T+8\n0 9 * * *' }),
    { schedule: '30 8 * * 1-5T+8\n0 9 * * *', updatedAt: BASELINE.updatedAt },
  )
})

test('job-patch:只提交改动字段,未改动字段不出现在载荷中(防旧快照回滚他处变更)', () => {
  // Given 表单只改了名称(编辑期间任务可能已被自动禁用/开关改动)
  // When 计算提交载荷
  const payload = edit({ name: '新名' })
  // Then 仅名称与基线时间,enabled/schedule/session 等一概不携带
  assert.deepEqual(payload, { name: '新名', updatedAt: BASELINE.updatedAt })
  for (const field of ['enabled', 'schedule', 'runOnce', 'timeoutMs', 'session']) {
    assert.equal(field in payload, false, field + ' 不得随未改动的编辑提交')
  }
})

test('job-patch:并发上限清空提交 null(服务端删键),保留值提交数值', () => {
  assert.deepEqual(edit({ concurrency: '' }), { concurrency: null, updatedAt: BASELINE.updatedAt })
  assert.deepEqual(edit({ concurrency: '5' }), { concurrency: 5, updatedAt: BASELINE.updatedAt })
})

test('job-patch:会话子字段变化才整体提交,MODELKEY 还原为模型对象', () => {
  const baseline = {
    ...BASELINE,
    kind: 'session',
    session: { mode: 'pinned', pinnedSessionId: 's-1', agentPreset: 'coder', modelKey: 'p' + '\u001f' + 'm' + '\u001f' },
  }
  // When 只调推理强度(其余子字段不动)
  const payload = helpers.jobUpdatePayload(baseline, {
    ...baseline,
    session: { ...baseline.session, modelKey: 'p' + '\u001f' + 'm' + '\u001f' + 'high' },
  })
  // Then 会话子对象整体提交且 modelKey 已还原,state 内 modelKey 不被提交
  assert.deepEqual(payload.session, {
    mode: 'pinned', pinnedSessionId: 's-1', agentPreset: 'coder',
    model: { provider: 'p', model: 'm', reasoningEffort: 'high' },
  })
  assert.equal('modelKey' in payload.session, false)
  // When 子字段全未变
  // Then 不提交 session(避免无谓覆盖)
  assert.equal('session' in helpers.jobUpdatePayload(baseline, { ...baseline }), false)
})

test('job-patch:脚本任务改成会话任务必须提交 session;改成脚本任务不提交', () => {
  const toSession = edit({ kind: 'session' })
  assert.equal(toSession.kind, 'session')
  assert.deepEqual(toSession.session, { mode: 'fresh', pinnedSessionId: '', agentPreset: '', model: undefined })
  const sessionBaseline = { ...BASELINE, kind: 'session' }
  const toShell = helpers.jobUpdatePayload(sessionBaseline, { ...sessionBaseline, kind: 'shell' })
  assert.deepEqual(toShell, { kind: 'shell', updatedAt: sessionBaseline.updatedAt })
})

test('job-patch:新建提交完整字段集,并发上限空串同样归一为 null', () => {
  const payload = helpers.jobCreatePayload({ ...BASELINE, concurrency: '' })
  for (const field of helpers.JOB_FORM_FIELDS) assert.ok(field in payload, '新建缺少字段 ' + field)
  assert.equal(payload.concurrency, null)
  // 脚本任务不携带会话子对象(undefined 经 JSON.stringify 丢弃)
  assert.equal(JSON.stringify(payload).includes('"session"'), false)
  const sessionPayload = helpers.jobCreatePayload({ ...BASELINE, concurrency: '', kind: 'session' })
  assert.deepEqual(sessionPayload.session, { mode: 'fresh', pinnedSessionId: '', agentPreset: '', model: undefined })
  assert.equal('modelKey' in sessionPayload.session, false)
})
