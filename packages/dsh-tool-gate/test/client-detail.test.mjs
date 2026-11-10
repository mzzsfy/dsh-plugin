import test from 'node:test'
import assert from 'node:assert/strict'
import { renderToolGateCard } from './client-render.mjs'

const STATE = {
  enabled: true,
  collapse: true,
  allowlist: ['read'],
  unknownAllowlisted: [],
  tools: [
    {
      name: 'read_image',
      layers: 1,
      deferredLayers: 1,
      layerLabels: ['global'],
      inAllowlist: false,
      implicit: false,
      description: '读取图片。',
      params: [{ name: 'file_path', type: 'string', required: true, description: '图片路径' }],
    },
    {
      name: 'read',
      layers: 2,
      deferredLayers: 0,
      layerLabels: ['global', 'agent#1'],
      inAllowlist: true,
      implicit: false,
      description: '读取文件内容。\n支持按行偏移与行数限制。',
      params: [
        { name: 'file_path', type: 'string', required: true, description: '目标文件路径' },
        { name: 'offset', type: 'number', required: false, description: '起始行' },
      ],
    },
    {
      name: 'tool_search',
      layers: 1,
      deferredLayers: 0,
      layerLabels: ['global'],
      inAllowlist: false,
      implicit: true,
      description: '按正则检索工具定义。',
      params: [{ name: 'pattern', type: 'string', required: true, description: '检索正则' }],
    },
    {
      name: 'web_fetch',
      layers: 1,
      deferredLayers: 1,
      layerLabels: ['global'],
      inAllowlist: false,
      implicit: false,
      description: '抓取网页内容。',
      params: [{ name: 'url', type: 'string', required: true, description: '目标地址' }],
    },
  ],
}

const inputOf = (ui, name) => ui.all()
  .find((node) => node.tag === 'input' && node.props['aria-label'] === `白名单 ${name}`)

test('卡片渲染:行头带描述悬停与展开状态,点击后才出现详情(SC-15)', async () => {
  const ui = await renderToolGateCard(STATE)
  assert.equal(ui.byClass('tg-tool__head').length, STATE.tools.length)

  const head = ui.findHead('web_fetch')
  assert.equal(head.props.title, '抓取网页内容。')
  // 名称按完整匹配定位:read 与 read_image 前缀不串行
  assert.equal(ui.findHead('read').props.title, '读取文件内容。\n支持按行偏移与行数限制。')
  assert.equal(ui.findHead('read_image').props.title, '读取图片。')
  assert.equal(head.props['aria-expanded'], false)
  assert.equal(ui.byClass('tg-tool__detail').length, 0)

  ui.click(head)
  const opened = ui.findHead('web_fetch')
  assert.equal(opened.props['aria-expanded'], true)
  const details = ui.byClass('tg-tool__detail')
  assert.equal(details.length, 1)
  assert.match(ui.text(details[0]), /抓取网页内容。/)
  assert.match(ui.text(details[0]), /defer 1\/1/)
  assert.match(ui.text(details[0]), /global/)
  assert.match(ui.text(details[0]), /白名单外/)

  ui.click(opened)
  assert.equal(ui.byClass('tg-tool__detail').length, 0)
})

test('卡片渲染:详情含参数名/类型/必填/参数说明(SC-15)', async () => {
  const ui = await renderToolGateCard(STATE)
  ui.click(ui.findHead('read'))
  const detailText = ui.text(ui.byClass('tg-tool__detail')[0])
  assert.match(detailText, /file_path/)
  assert.match(detailText, /string/)
  assert.match(detailText, /必填/)
  assert.match(detailText, /目标文件路径/)
  assert.match(detailText, /读取文件内容。/)
  assert.match(detailText, /global \/ agent#1/)
})

test('卡片渲染:开关回显白名单,隐式折叠入口锁定(SC-15/SC-22)', async () => {
  const ui = await renderToolGateCard(STATE)
  assert.equal(inputOf(ui, 'read').props.checked, true)
  assert.equal(inputOf(ui, 'read').props.disabled, false)
  assert.equal(inputOf(ui, 'web_fetch').props.checked, false)
  assert.equal(inputOf(ui, 'tool_search').props.disabled, true)
  assert.match(ui.text(ui.findHead('tool_search')), /折叠入口 · 常驻/)
})

test('卡片渲染:无描述工具给出占位文案,不渲染空 title', async () => {
  const state = {
    ...STATE,
    tools: [{ name: 'ghost', layers: 1, deferredLayers: 1, layerLabels: ['global'], inAllowlist: false, implicit: false, description: '', params: [] }],
  }
  const ui = await renderToolGateCard(state)
  const head = ui.findHead('ghost')
  assert.equal(head.props.title, undefined)
  ui.click(head)
  assert.match(ui.text(ui.byClass('tg-tool__detail')[0]), /该工具未提供描述/)
  assert.match(ui.text(ui.byClass('tg-tool__detail')[0]), /无参数/)
})
