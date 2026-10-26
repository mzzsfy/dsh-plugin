import test from 'node:test'
import assert from 'node:assert/strict'

// 0.2.1 attachment mock:refuseAttempts 内的附着对每帧回 read-only 拒绝并结束流(模拟被抢)
function makeEra({ refuseAttempts = 0, recordSignals = false } = {}) {
  const frames = []
  const signals = []
  let attempt = 0
  const attachment = {
    attach: async function* (input, limits, signal) {
      attempt += 1
      const myAttempt = attempt
      if (recordSignals) signals.push(signal)
      yield { type: 'snapshot', sequence: 0, screen: '', info: { state: 'running' }, writable: false }
      for await (const cmd of input) {
        frames.push({ attempt: myAttempt, type: cmd.type, sequence: cmd.sequence, data: cmd.data })
        if (myAttempt <= refuseAttempts) {
          yield { type: 'ack', sequence: cmd.sequence, refusal: 'read-only' }
          return
        }
        yield { type: 'ack', sequence: cmd.sequence }
      }
    }
  }
  return { attachment, frames, signals }
}

const makeController = (attachment) => ({
  config: { maxInputBytes: 10 * 1024, maxCols: 500, maxRows: 200 },
  terminal: () => attachment
})

// Given 0.2.1 TerminalAttachment,When 泵 write,Then 命令帧按 sequence 推入且 ack 后成功
test('attach泵_write_主路径_命令帧与ack', async () => {
  const { createPumpFactory } = await import('../src/lib/attach-pump.mjs')
  const agent = { id: 'agent-1' }
  const { attachment, frames } = makeEra()
  const factory = createPumpFactory(makeController(attachment))
  const pump = factory.for(agent, 'term-a')
  await pump.write('echo hi')
  assert.deepEqual(frames, [{ attempt: 1, type: 'write', sequence: 1, data: 'echo hi' }])
  factory.dispose()
})

// Given UI 已接管(首附着 read-only),When 泵 write,Then 自动重 attach 抢回并重发同帧成功
test('attach泵_控制权竞争_自动重抢成功', async () => {
  const { createPumpFactory } = await import('../src/lib/attach-pump.mjs')
  const agent = { id: 'agent-1' }
  const { attachment, frames } = makeEra({ refuseAttempts: 1 })
  const factory = createPumpFactory(makeController(attachment))
  const pump = factory.for(agent, 'term-a')
  await pump.write('echo takeover')
  const writes = frames.filter(f => f.type === 'write')
  assert.deepEqual(writes, [
    { attempt: 1, type: 'write', sequence: 1, data: 'echo takeover' },
    { attempt: 2, type: 'write', sequence: 1, data: 'echo takeover' }
  ])
  factory.dispose()
})

// Given 用户持续接管(重抢后仍 refusal),When 泵 write,Then 抛拒绝错误且不无限死斗
test('attach泵_控制权竞争_重试耗尽抛错', async () => {
  const { createPumpFactory } = await import('../src/lib/attach-pump.mjs')
  const agent = { id: 'agent-1' }
  const { attachment } = makeEra({ refuseAttempts: 99 })
  const factory = createPumpFactory(makeController(attachment))
  const pump = factory.for(agent, 'term-a')
  await assert.rejects(pump.write('echo x'), (error) => error.code === 'terminal/write-refused' && error.refusal === 'read-only')
  factory.dispose()
})

// Given 同一泵连续多次 write,When 依次提交,Then 逐次新世代附着,数据按序送达且各世代 sequence 合规
test('attach泵_序列递增_连续写', async () => {
  const { createPumpFactory } = await import('../src/lib/attach-pump.mjs')
  const agent = { id: 'agent-1' }
  const { attachment, frames } = makeEra()
  const factory = createPumpFactory(makeController(attachment))
  const pump = factory.for(agent, 'term-a')
  await pump.write('one')
  await pump.write('two')
  await pump.write('three')
  // 空闲释放后每次写入各自建立附着,sequence 按世代从 1 起
  assert.deepEqual(frames.map(f => `${f.attempt}:${f.sequence}:${f.data}`), ['1:1:one', '2:1:two', '3:1:three'])
  factory.dispose()
})

// Given 多个 write 并发在途,When 同时提交,Then sequence 互不重复且全部收到 ack
test('attach泵_并发写_sequence互异', async () => {
  const { createPumpFactory } = await import('../src/lib/attach-pump.mjs')
  const agent = { id: 'agent-1' }
  const { attachment, frames } = makeEra()
  const factory = createPumpFactory(makeController(attachment))
  const pump = factory.for(agent, 'term-a')
  await Promise.all([pump.write('a'), pump.write('b'), pump.write('c')])
  assert.deepEqual(frames.map(f => f.sequence).sort((a, b) => a - b), [1, 2, 3])
  factory.dispose()
})

// Given 附着流在帧被宿主消费前断开,When 重抢附着,Then 残留帧被丢弃且重发帧 sequence 合规不双发
test('attach泵_残留帧_重抢不双发', async () => {
  const { createPumpFactory } = await import('../src/lib/attach-pump.mjs')
  const agent = { id: 'agent-1' }
  const writes = []
  let attempt = 0
  const attachment = {
    attach: async function* (input, limits, signal) {
      attempt += 1
      const mine = attempt
      yield { type: 'snapshot', sequence: 0, screen: '', info: { state: 'running' }, writable: false }
      for await (const cmd of input) {
        if (mine === 1) {
          // 帧入队后宿主流即刻断开:不消费、不回 ack,模拟附着被抢断于消费前
          writes.push({ attempt: mine, sequence: cmd.sequence, data: cmd.data })
          return
        }
        writes.push({ attempt: mine, sequence: cmd.sequence, data: cmd.data })
        yield { type: 'ack', sequence: cmd.sequence }
      }
    }
  }
  const factory = createPumpFactory(makeController(attachment))
  const pump = factory.for(agent, 'term-a')
  await pump.write('only-once')
  assert.deepEqual(writes, [
    { attempt: 1, sequence: 1, data: 'only-once' },
    { attempt: 2, sequence: 1, data: 'only-once' }
  ])
  factory.dispose()
})

// Given 并发双写遇上附着流断,When 两个 write 都收到 detached,Then 仅重建一次附着且双写都成功不互杀
test('attach泵_并发重抢_不互杀', async () => {
  const { createPumpFactory } = await import('../src/lib/attach-pump.mjs')
  const agent = { id: 'agent-1' }
  const writes = []
  let attempt = 0
  const attachment = {
    attach: async function* (input, limits, signal) {
      attempt += 1
      const mine = attempt
      yield { type: 'snapshot', sequence: 0, screen: '', info: { state: 'running' }, writable: false }
      for await (const cmd of input) {
        writes.push({ attempt: mine, sequence: cmd.sequence, data: cmd.data })
        if (mine === 1) return
        yield { type: 'ack', sequence: cmd.sequence }
      }
    }
  }
  const factory = createPumpFactory(makeController(attachment))
  const pump = factory.for(agent, 'term-a')
  await Promise.all([pump.write('first'), pump.write('second')])
  // 旧实现互杀会重建到 attempt 3 且毁掉先到写;世代比较后仅一次重建
  assert.equal(attempt, 2, `应仅重建一次附着,实际 ${attempt}`)
  const delivered = writes.filter(f => f.attempt === 2).map(f => f.data).sort()
  assert.deepEqual(delivered, ['first', 'second'], '两条写入都应在重建世代送达')
  factory.dispose()
})

// Given terminal 已不存在(terminal() 抛),When 泵 write,Then 异常原样传播不吞
test('attach泵_终端消失_异常传播', async () => {
  const { createPumpFactory } = await import('../src/lib/attach-pump.mjs')
  const agent = { id: 'agent-1' }
  const gone = Object.assign(new Error('Terminal no longer exists in this Session'), { code: 'terminal/unavailable' })
  const controller = {
    config: { maxInputBytes: 10 * 1024, maxCols: 500, maxRows: 200 },
    terminal: () => { throw gone }
  }
  const factory = createPumpFactory(controller)
  const pump = factory.for(agent, 'term-a')
  await assert.rejects(pump.write('echo x'), (error) => error.code === 'terminal/unavailable')
  factory.dispose()
})

// Given 泵已活动,When factory.dispose,Then 附着 signal 置 abort 且同 terminal 再 for 得到全新泵
test('attach泵_dispose_停止附着并重置缓存', async () => {
  const { createPumpFactory } = await import('../src/lib/attach-pump.mjs')
  const agent = { id: 'agent-1' }
  const { attachment, signals } = makeEra({ recordSignals: true })
  const factory = createPumpFactory(makeController(attachment))
  await factory.for(agent, 'term-a').write('warmup')
  factory.dispose()
  assert.equal(signals[0].aborted, true, 'dispose 后首个附着 signal 应 abort')
  const fresh = factory.for(agent, 'term-a')
  await fresh.write('after-dispose')
  assert.equal(signals.length, 2, 'dispose 后 for 返回全新泵(新附着)')
  fresh.stop()
})

// Given 写入全部 ack,When 泵空闲,Then 主动释放附着(UI 恢复可写,官方 fit 自愈几何)
test('attach泵_空闲释放_写完即detach', async () => {
  const { createPumpFactory } = await import('../src/lib/attach-pump.mjs')
  const agent = { id: 'agent-1' }
  const { attachment, signals } = makeEra({ recordSignals: true })
  const factory = createPumpFactory(makeController(attachment))
  await factory.for(agent, 'term-a').write('echo hi')
  assert.equal(signals.length, 1, '本次写入应建立一次附着')
  assert.equal(signals[0].aborted, true, '写完空闲后附着应立即释放')
  factory.dispose()
})

// Given 并发多写在途,When 部分仍 pending,Then 不释放;全部 ack 后才释放
test('attach泵_空闲释放_并发等全部ack', async () => {
  const { createPumpFactory } = await import('../src/lib/attach-pump.mjs')
  const agent = { id: 'agent-1' }
  const gates = []
  let releaseSlowAck
  const attachment = {
    attach: async function* (input, limits, signal) {
      gates.push(signal)
      yield { type: 'snapshot', sequence: 0, screen: '', info: { state: 'running' }, writable: false }
      for await (const cmd of input) {
        if (cmd.data === 'slow') {
          // 挂起 ack,由测试手动放行
          await new Promise((resolve) => { releaseSlowAck = resolve })
        }
        yield { type: 'ack', sequence: cmd.sequence }
      }
    }
  }
  const factory = createPumpFactory(makeController(attachment))
  const pump = factory.for(agent, 'term-a')
  const slow = pump.write('slow')
  let settled = false
  slow.then(() => { settled = true }, () => { settled = true })
  await new Promise((resolve) => setTimeout(resolve, 20))
  try {
    assert.equal(gates[0].aborted, false, '仍有 pending 时附着必须保持')
    releaseSlowAck()
    await slow
    assert.equal(gates[0].aborted, true, '全部 ack 后附着应释放')
    assert.equal(settled, true)
  } finally {
    releaseSlowAck?.()
  }
  factory.dispose()
})

// Given 空闲释放后再次 write,When 重建附着,Then 新世代 sequence 从 1 起且写入成功
test('attach泵_空闲释放_再写重建附着', async () => {
  const { createPumpFactory } = await import('../src/lib/attach-pump.mjs')
  const agent = { id: 'agent-1' }
  const { attachment, frames, signals } = makeEra({ recordSignals: true })
  const factory = createPumpFactory(makeController(attachment))
  const pump = factory.for(agent, 'term-a')
  await pump.write('first')
  await pump.write('second')
  assert.equal(signals.length, 2, '两次写入应各自建立一次附着')
  assert.deepEqual(frames.map(f => `${f.attempt}:${f.sequence}`), ['1:1', '2:1'], '每世代 sequence 从 1 起')
  factory.dispose()
})
