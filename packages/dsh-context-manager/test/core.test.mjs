// core 纯函数测试:历史输入提取(G1-G3)/聚合(G4-G5)/搜索过滤/fork 错误文案/巨产物跳过线

import test from 'node:test'
import assert from 'node:assert/strict'

const {
  extractUserInputs,
  aggregateInputs,
  filterHistoryInputs,
  forkFailureText,
  forkRetryText,
  reorderPrompts,
  renamePromptItem,
  trimPrompts,
  promptsToInputs,
  maxArtifactBytesForHost,
  HISTORY_ALIGN_LEGACY_MAX_ARTIFACT_BYTES,
  HISTORY_ALIGN_MODERN_MAX_ARTIFACT_BYTES,
  HISTORY_SCOPES,
  HISTORY_INPUT_LIMIT,
  HISTORY_INPUT_MAX_CHARS,
  HISTORY_PROMPTS_MAX,
} = await import('../src/core.mjs')

function userEvent(overrides, text, at) {
  return {
    type: 'user/message',
    seq: 1,
    time: at,
    ...overrides,
    data: {
      id: 'm1',
      role: 'user',
      source: { kind: 'user' },
      content: text === undefined ? [] : [{ type: 'text', text }],
      ...overrides?.data,
    },
  }
}

// ── 历史输入:事件提取(G1-G3)──

test('历史输入提取:user/message 且 kind=user 产出文本与时间', () => {
  const events = [userEvent(null, '修复归档面板', 500)]
  assert.deepEqual(extractUserInputs(events), [{ text: '修复归档面板', at: 500 }])
})

test('历史输入提取:tool 结果与 plugin 注入不产出', () => {
  const tool = userEvent({ data: { source: { kind: 'tool', callId: 'c1' }, content: [{ type: 'tool-result', toolCallId: 'c1', content: [] }] } }, undefined, 100)
  const plugin = userEvent({ data: { source: { kind: 'plugin', plugin: 'x', form: 'instructions' }, content: [{ type: 'text', text: '注入' }] } }, undefined, 200)
  assert.deepEqual(extractUserInputs([tool, plugin]), [])
})

test('历史输入提取:纯图与空文本跳过', () => {
  const image = userEvent({ data: { content: [{ type: 'image', attachment: { id: 'a1' } }] } }, undefined, 100)
  const blank = userEvent(null, '', 200)
  const whitespace = userEvent(null, ' \n ', 300)
  assert.deepEqual(extractUserInputs([image, blank, whitespace]), [])
})

test('历史输入提取:多 text block 按行拼接为单条', () => {
  const events = [userEvent({ data: { content: [{ type: 'text', text: '第一段' }, { type: 'text', text: '第二段' }] } }, undefined, 300)]
  assert.deepEqual(extractUserInputs(events), [{ text: '第一段\n第二段', at: 300 }])
})

// ── 历史输入:斜杠命令提取(command/run)──

test('历史输入提取:command/run 重组为完整命令行,args 为命令名后 verbatim rawInput', () => {
  const events = [{
    type: 'command/run',
    seq: 2,
    time: 600,
    data: { commandId: 'c1', name: 'goal', args: ' 完成目标文档', source: { kind: 'user' } },
  }]
  assert.deepEqual(extractUserInputs(events), [{ text: '/goal 完成目标文档', at: 600 }])
})

test('历史输入提取:command/run 无 args(recordInput: false)产出裸命令名', () => {
  const events = [{
    type: 'command/run',
    seq: 2,
    time: 600,
    data: { commandId: 'c1', name: 'think', source: { kind: 'user' } },
  }]
  assert.deepEqual(extractUserInputs(events), [{ text: '/think', at: 600 }])
})

test('历史输入提取:非用户来源的 command/run 不产出', () => {
  const events = [{
    type: 'command/run',
    seq: 2,
    time: 600,
    data: { commandId: 'c1', name: 'goal', args: ' x', source: { kind: 'agent' } },
  }]
  assert.deepEqual(extractUserInputs(events), [])
})

test('历史输入提取:畸形 command/run(data 缺失/name 空串/args 非字符串)安全跳过或归一', () => {
  const noData = { type: 'command/run', seq: 1, time: 100 }
  const emptyName = { type: 'command/run', seq: 2, time: 200, data: { commandId: 'c1', name: '', source: { kind: 'user' } } }
  const nonStringArgs = { type: 'command/run', seq: 3, time: 300, data: { commandId: 'c1', name: 'goal', args: 42, source: { kind: 'user' } } }
  assert.deepEqual(extractUserInputs([noData, emptyName, nonStringArgs]), [{ text: '/goal', at: 300 }])
})

test('历史输入提取:普通输入与命令混合按事件序全部产出', () => {
  const events = [
    userEvent(null, '先看看日志', 100),
    { type: 'command/run', seq: 2, time: 200, data: { commandId: 'c1', name: 'goal', args: ' 收尾', source: { kind: 'user' } } },
  ]
  assert.deepEqual(extractUserInputs(events), [
    { text: '先看看日志', at: 100 },
    { text: '/goal 收尾', at: 200 },
  ])
})

// ── 历史输入:聚合(G4-G5)──

test('历史输入聚合:同文本去重保留最新时间,按时间倒序', () => {
  const merged = aggregateInputs([
    { text: 'a', at: 1 },
    { text: 'b', at: 5 },
    { text: 'a', at: 9 },
  ], { limit: 10, maxChars: 100 })
  assert.deepEqual(merged, [{ text: 'a', at: 9 }, { text: 'b', at: 5 }])
})

test('历史输入聚合:limit 裁剪与单条截断', () => {
  const merged = aggregateInputs([
    { text: 'abcdef', at: 1 },
    { text: 'xy', at: 2 },
  ], { limit: 1, maxChars: 3 })
  assert.deepEqual(merged, [{ text: 'xy', at: 2 }])
})

// ── 历史输入:每会话首条保护(挤出不做永久丢弃)──

test('历史输入聚合:超 limit 挤出时每个会话最早条目仍保留', () => {
  const merged = aggregateInputs([
    { text: '开场提示词', at: 1, sid: 's-old' },
    { text: '继续', at: 2, sid: 's-old' },
    { text: '新会话开场', at: 3, sid: 's-new' },
    { text: '收尾', at: 4, sid: 's-new' },
  ], { limit: 2, maxChars: 100 })
  assert.deepEqual(merged, [
    { text: '收尾', at: 4, sid: 's-new' },
    { text: '新会话开场', at: 3, sid: 's-new' },
    { text: '开场提示词', at: 1, sid: 's-old' },
  ])
})

test('历史输入聚合:首条已在 limit 内不多余追加,结果仍为时间倒序', () => {
  const merged = aggregateInputs([
    { text: 'a', at: 1, sid: 's1' },
    { text: 'b', at: 2, sid: 's2' },
  ], { limit: 10, maxChars: 100 })
  assert.deepEqual(merged, [{ text: 'b', at: 2, sid: 's2' }, { text: 'a', at: 1, sid: 's1' }])
})

test('历史输入聚合:首条保护在去重后集合上计算,与 limit 内文本重复不产生双条目', () => {
  // s-old 的首条文本与 s-new 的某条相同:去重保留最新,归属 s-new,不再重复追加
  const merged = aggregateInputs([
    { text: '继续', at: 1, sid: 's-old' },
    { text: '继续', at: 9, sid: 's-new' },
    { text: '其他', at: 5, sid: 's-new' },
  ], { limit: 1, maxChars: 100 })
  assert.deepEqual(merged, [{ text: '继续', at: 9, sid: 's-new' }, { text: '其他', at: 5, sid: 's-new' }])
})

test('历史输入聚合:无 sid 条目不触发首条保护', () => {
  const merged = aggregateInputs([
    { text: 'old', at: 1 },
    { text: 'new', at: 2 },
  ], { limit: 1, maxChars: 100 })
  assert.deepEqual(merged, [{ text: 'new', at: 2 }])
})

test('历史输入聚合:首条保护同样受 maxChars 截断', () => {
  const merged = aggregateInputs([
    { text: 'abcdef', at: 1, sid: 's1' },
    { text: 'xy', at: 2, sid: 's2' },
  ], { limit: 1, maxChars: 3 })
  assert.deepEqual(merged, [{ text: 'xy', at: 2, sid: 's2' }, { text: 'abc', at: 1, sid: 's1' }])
})

// ── 搜索过滤(与 client.js 镜像,行为逐条对齐)──

test('历史搜索:空查询原样返回全量,非数组入参按空处理', () => {
  const entries = [{ text: 'abc' }, { text: 'def' }]
  assert.deepEqual(filterHistoryInputs(entries, ''), entries)
  assert.deepEqual(filterHistoryInputs(entries, '   '), entries)
  assert.deepEqual(filterHistoryInputs(undefined, 'a'), [])
  assert.deepEqual(filterHistoryInputs(null, 'a'), [])
})

test('历史搜索:大小写不敏感子串匹配,保留原序', () => {
  const entries = [{ text: 'Fix ARCHIVE bug' }, { text: '归档面板' }, { text: 'unrelated' }]
  assert.deepEqual(filterHistoryInputs(entries, 'archive'), [entries[0]])
  assert.deepEqual(filterHistoryInputs(entries, '归档'), [entries[1]])
  assert.deepEqual(filterHistoryInputs(entries, 'un'), [entries[2]])
})

test('历史搜索:查询词去首尾空白后匹配,无命中返回空数组', () => {
  const entries = [{ text: 'abc' }]
  assert.deepEqual(filterHistoryInputs(entries, ' abc '), entries)
  assert.deepEqual(filterHistoryInputs(entries, 'zzz'), [])
})

test('历史搜索:条目缺 text 按空串参与匹配,仅命中空查询', () => {
  const entries = [{ at: 1 }, { text: 'abc' }]
  assert.deepEqual(filterHistoryInputs(entries, ''), entries)
  assert.deepEqual(filterHistoryInputs(entries, 'abc'), [entries[1]])
  assert.deepEqual(filterHistoryInputs(entries, 'a'), [entries[1]])
})

// ── fork 错误文案 ──

test('fork 错误文案:未完成轮/挂载失败/未知码分通道', () => {
  assert.equal(forkFailureText('session/fork-unavailable'), '该轮尚未完成,不可分叉')
  assert.equal(forkFailureText('session/workspace-attach-failed'), '分叉成功,但挂载到工作区失败')
  assert.equal(forkFailureText('gateway/internal'), '分叉失败: gateway/internal')
  assert.equal(forkFailureText(undefined), '分叉失败: 未知错误')
})

// ── fork 重试文本提取 ──

test('Given 用户本人多文本块消息, When forkRetryText, Then 文本块按行拼接', () => {
  const data = {
    source: { kind: 'user' },
    content: [{ type: 'text', text: '第一行' }, { type: 'image', attachment: {} }, { type: 'text', text: '第二行' }],
  }
  assert.equal(forkRetryText(data), '第一行\n第二行')
})

test('Given 插件注入/空白/纯图片消息, When forkRetryText, Then 返回 null 不提供重试', () => {
  assert.equal(forkRetryText({ source: { kind: 'plugin', plugin: 'x' }, content: [{ type: 'text', text: '注入' }] }), null)
  assert.equal(forkRetryText({ source: { kind: 'user' }, content: [] }), null)
  assert.equal(forkRetryText({ source: { kind: 'user' }, content: [{ type: 'text', text: '   ' }] }), null)
  assert.equal(forkRetryText({ source: { kind: 'user' }, content: [{ type: 'image', attachment: {} }] }), null)
})

test('Given 非对象或畸形 data, When forkRetryText, Then 返回 null 不抛错', () => {
  assert.equal(forkRetryText(undefined), null)
  assert.equal(forkRetryText({}), null)
  assert.equal(forkRetryText({ source: { kind: 'user' } }), null)
})

// ── 常用提示词:超限裁剪(一次删净)──

test('收藏裁剪:未超限不改动,超限一次删到上限并保留原序', () => {
  const small = [{ text: 'A', at: 1 }, { text: 'B', at: 2 }]
  assert.equal(trimPrompts(small, 2), small, '未超限返回同一引用')
  const items = [
    { text: '最新', at: 50 },
    { text: '最旧', at: 1 },
    { text: '居中', at: 30 },
    { text: '次旧', at: 2 },
  ]
  const trimmed = trimPrompts(items, 2)
  assert.deepEqual(trimmed.map((item) => item.text), ['最新', '居中'], '只保留 at 最大的两条,其余按原序')
  assert.deepEqual(items.map((item) => item.text), ['最新', '最旧', '居中', '次旧'], '不得改动入参')
})

test('收藏裁剪:时间戳相同时从尾部删(尾部是更早的收藏),畸形 at 按 0 处理', () => {
  const items = [
    { text: 'A', at: 5 },
    { text: 'B', at: 5 },
    { text: 'C', at: 5 },
    { text: 'D' },
    null,
  ]
  assert.deepEqual(trimPrompts(items, 2).map((item) => item.text), ['A', 'B'], '同 at 保留靠前的,缺 at 视为最旧')
  assert.deepEqual(trimPrompts(undefined, 3), [])
})

// ── 常用提示词:重命名(原位替换,不置顶)──

test('收藏重命名:原位替换文本,位置与收藏时间不变', () => {
  const items = [{ text: 'A', at: 1 }, { text: 'B', at: 2 }, { text: 'C', at: 3 }]
  const renamed = renamePromptItem(items, 'B', 'B2')
  assert.equal(renamed.result, 'renamed')
  assert.deepEqual(renamed.items, [{ text: 'A', at: 1 }, { text: 'B2', at: 2 }, { text: 'C', at: 3 }])
  assert.deepEqual(items, [{ text: 'A', at: 1 }, { text: 'B', at: 2 }, { text: 'C', at: 3 }], '不得改动入参')
})

test('收藏重命名:清空即删除,目标已存在则合并到既有条目', () => {
  const items = [{ text: 'A', at: 1 }, { text: 'B', at: 2 }, { text: 'C', at: 3 }]
  const removed = renamePromptItem(items, 'B', '')
  assert.equal(removed.result, 'removed')
  assert.deepEqual(removed.items.map((item) => item.text), ['A', 'C'])
  const merged = renamePromptItem(items, 'A', 'C')
  assert.equal(merged.result, 'merged')
  assert.deepEqual(merged.items, [{ text: 'B', at: 2 }, { text: 'C', at: 3 }], '合并保留既有条目位置')
})

test('收藏重命名:同文本不变更,源不存在返回 missing,非数组入参安全', () => {
  const items = [{ text: 'A', at: 1 }]
  const same = renamePromptItem(items, 'A', 'A')
  assert.equal(same.result, 'unchanged')
  assert.equal(same.items, items, '不变更时返回同一引用')
  const missing = renamePromptItem(items, '不存在', 'X')
  assert.equal(missing.result, 'missing')
  assert.deepEqual(renamePromptItem(undefined, 'A', 'B').items, [])
})

// ── 常用提示词:自定义顺序(拖动排序的持久化语义)──

test('收藏排序:按给定文本顺序重排,条目对象与时间原样保留', () => {
  const items = [{ text: 'A', at: 1 }, { text: 'B', at: 2 }, { text: 'C', at: 3 }]
  assert.deepEqual(reorderPrompts(items, ['C', 'A', 'B']), [
    { text: 'C', at: 3 },
    { text: 'A', at: 1 },
    { text: 'B', at: 2 },
  ])
})

test('收藏排序:未提及条目按原相对序保留在尾部(陈旧顺序不丢数据)', () => {
  const items = [{ text: 'A', at: 1 }, { text: 'B', at: 2 }, { text: 'C', at: 3 }]
  // 另一窗口在此期间新增了 C 并已落盘:提交方不知道 C,不得把它丢掉
  assert.deepEqual(reorderPrompts(items, ['B', 'A']).map((item) => item.text), ['B', 'A', 'C'])
})

test('收藏排序:未知文本忽略,空顺序与全未知顺序退化为原序', () => {
  const items = [{ text: 'A', at: 1 }, { text: 'B', at: 2 }]
  assert.deepEqual(reorderPrompts(items, ['X', 'B', 'A', 'Y']).map((item) => item.text), ['B', 'A'])
  assert.deepEqual(reorderPrompts(items, []).map((item) => item.text), ['A', 'B'])
  assert.deepEqual(reorderPrompts(items, ['X']).map((item) => item.text), ['A', 'B'])
})

test('收藏排序:重复文本只取首个位置,幂等(同顺序重放不变)', () => {
  const items = [{ text: 'A', at: 1 }, { text: 'B', at: 2 }]
  const once = reorderPrompts(items, ['B', 'A', 'B'])
  assert.deepEqual(once.map((item) => item.text), ['B', 'A'])
  assert.deepEqual(reorderPrompts(once, once.map((item) => item.text)), once)
})

test('收藏排序:文件里同一文本出现多次时不丢条目(后续重复项保尾)', () => {
  // 正常 UI 的收藏查重不会产生重复,只有旧数据/手改文件才有;排序不得把它们吃掉
  const items = [{ text: 'A', at: 1 }, { text: 'A', at: 2 }, { text: 'B', at: 3 }]
  const reordered = reorderPrompts(items, ['A', 'B'])
  assert.equal(reordered.length, items.length, '排序不得丢条目')
  assert.deepEqual(reordered.map((item) => item.text), ['A', 'B', 'A'])
  assert.deepEqual(reordered.map((item) => item.at), [1, 3, 2])
})

test('收藏排序:非数组入参与畸形条目安全(返回可用数组,不抛错)', () => {
  assert.deepEqual(reorderPrompts(undefined, ['A']), [])
  assert.deepEqual(reorderPrompts([], ['A']), [])
  const items = [{ text: 'A', at: 1 }, { at: 2 }, null]
  assert.deepEqual(reorderPrompts(items, 'A'), items, '非数组 texts 按空顺序处理,退化为原序')
})

test('收藏投影:保持文件顺序(不按收藏时间重排),超长条目截断到上限', () => {
  const items = [
    { text: '后收藏但排第一', at: 9 },
    { text: '先收藏但排第二', at: 1 },
  ]
  assert.deepEqual(promptsToInputs(items, { maxChars: 100 }).map((item) => item.text), ['后收藏但排第一', '先收藏但排第二'])
  assert.deepEqual(promptsToInputs([{ text: 'abcdef', at: 1 }], { maxChars: 3 }), [{ text: 'abc', at: 1 }])
})

test('收藏投影:非数组与超过上限的畸形文件安全裁剪', () => {
  assert.deepEqual(promptsToInputs(undefined, { maxChars: 10 }), [])
  const items = Array.from({ length: HISTORY_PROMPTS_MAX + 5 }, (_, index) => ({ text: 'x' + index, at: index }))
  assert.equal(promptsToInputs(items, { maxChars: 10 }).length, HISTORY_PROMPTS_MAX)
})

// ── 巨产物跳过线:宿主版本黑名单 ──

test('巨产物跳过线:0.1.1 与 0.1.2 系列(含 prerelease)按旧线', () => {
  for (const version of ['0.1.1', '0.1.1-rc.2', '0.1.2', '0.1.2-rc.1', '0.1.2-alpha.2']) {
    assert.equal(maxArtifactBytesForHost(version), HISTORY_ALIGN_LEGACY_MAX_ARTIFACT_BYTES, version)
  }
})

test('巨产物跳过线:0.1.3 起与未知未来版本按新线', () => {
  for (const version of ['0.1.3', '0.1.5', '0.1.5-rc.1', '0.2.0', '1.0.0']) {
    assert.equal(maxArtifactBytesForHost(version), HISTORY_ALIGN_MODERN_MAX_ARTIFACT_BYTES, version)
  }
})

test('巨产物跳过线:版本缺失或非法保守回退旧线', () => {
  for (const version of [null, undefined, '', 'garbage', '0.1']) {
    assert.equal(maxArtifactBytesForHost(version), HISTORY_ALIGN_LEGACY_MAX_ARTIFACT_BYTES, String(version))
  }
})

// ── 常量自检 ──

test('历史范围常量:四范围固定序,默认落点为当前会话', () => {
  assert.deepEqual(HISTORY_SCOPES, ['prompts', 'session', 'workspace', 'global'])
})

test('历史容量常量:输入 200 条/单条 2 万字符/收藏 100 条', () => {
  assert.equal(HISTORY_INPUT_LIMIT, 200)
  assert.equal(HISTORY_INPUT_MAX_CHARS, 20 * 1000)
  assert.equal(HISTORY_PROMPTS_MAX, 100)
})
