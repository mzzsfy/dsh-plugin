import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fixture, until } from './_ws-fixture.mjs'
import { PROTOCOL, SUPPORTED_PROTOCOLS } from '../src/protocol.mjs'
import { PROTOCOLS, setupCommonTools } from '../src/host.js'

const CLIENT = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')
const HOST = readFileSync(new URL('../src/host.js', import.meta.url), 'utf8')
// 声明按整行形态识别:注释里出现的字面量不构成声明;容忍行尾注释与 CRLF 检出
const DECLARATION = /^[ \t]*const PROTOCOL = (\d+)[ \t]*(?:\/\/[^\n]*)?\r?$/gm
const declarations = [...CLIENT.matchAll(DECLARATION)]

test('Given client 半区字面量 When 与共享协议模块对表 Then 声明唯一且同值', () => {
  assert.equal(declarations.length, 1, 'src/client.js 必须恰有一处 PROTOCOL 字面量:多写一处即多一个事实源')
  assert.equal(
    Number(declarations[0][1]),
    PROTOCOL,
    `src/client.js 的 PROTOCOL=${declarations[0][1]} 与 src/protocol.mjs 的 ${PROTOCOL} 不一致:`
      + '单边抬版会让 hello 协商无交集,client 静默停用总线',
  )
})

test('Given host 半区 When 读其协议声明 Then 只 import 共享模块且不本地重复定义', () => {
  assert.match(HOST, /import \{ PROTOCOL, SUPPORTED_PROTOCOLS \} from '\.\/protocol\.mjs'/)
  assert.equal(/^[ \t]*const PROTOCOL = /m.test(HOST), false, 'src/host.js 不得本地再声明 PROTOCOL,必须走 protocol.mjs')
})

test('Given 共享协议模块 When 取 host 回报的支持集 Then 与导出同源且含本端协议', () => {
  assert.equal(Object.isFrozen(SUPPORTED_PROTOCOLS), true, '支持集须只读:运行时改写会让 host 回报与常量分叉')
  assert.ok(SUPPORTED_PROTOCOLS.includes(PROTOCOL))
  assert.deepEqual([...PROTOCOLS], [...SUPPORTED_PROTOCOLS], 'host 导出的 PROTOCOLS 必须就是共享支持集')
})

test('Given 两端当前常量 When 真实握手 Then 协商为 ok 且订阅对账到达', async t => {
  const f = await fixture(t)
  setupCommonTools(f.context())
  const client = f.load().setupCommonTools(f.context())
  const resets = []
  client.subscribe(() => {}, { onReset: () => resets.push(true) })
  await until(() => f.state()?.hello === 'ok', 'hello 协商未达成:两端 PROTOCOL 不同值会让 client 停用总线')
  await until(() => resets.length === 1)
})
