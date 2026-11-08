// 开关形态守卫:布尔偏好一律 switch(track+thumb),原生 checkbox 视觉隐藏保语义与
// 可访问性,状态选择器以 input[type="checkbox"] 锚定,防止组合进含其他 input 的 label 时误伤。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const CLIENT_SOURCE = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'client.js'), 'utf8')

test('开关结构:label 包原生 checkbox + track + thumb', () => {
  assert.match(CLIENT_SOURCE, /className: 'sm-switch'/, '开关 label 存在')
  assert.match(CLIENT_SOURCE, /type: 'checkbox'/, '原生 checkbox 保语义')
  assert.match(CLIENT_SOURCE, /className: 'sm-switch__track'/, 'track 存在')
  assert.match(CLIENT_SOURCE, /className: 'sm-switch__thumb'/, 'thumb 存在')
})

test('原生 input 被视觉隐藏,不以裸 checkbox 呈现', () => {
  assert.match(CLIENT_SOURCE, /\.sm-switch input\[type="checkbox"\] \{ position:absolute; opacity:0;/, 'input 视觉隐藏')
})

test('开关状态选择器以 input[type="checkbox"] 锚定', () => {
  for (const state of [':checked', ':focus-visible', ':disabled']) {
    const pattern = new RegExp('\\.sm-switch[^{]*\\' + state + '[^{]*\\{', 'g')
    const matches = [...CLIENT_SOURCE.matchAll(pattern)].map((match) => match[0])
    assert.ok(matches.length > 0, state + ' 选择器存在')
    for (const selector of matches) {
      assert.match(selector, /input\[type="checkbox"\]/, state + ' 必须以 input[type="checkbox"] 锚定: ' + selector)
    }
  }
})

test('开关样式的 :hover 锚定 label 而非隐藏的 input', () => {
  assert.match(CLIENT_SOURCE, /\.sm-switch:hover \.sm-switch__track/, 'hover 锚定 label')
})

test('开关带悬停说明与无障碍标签', () => {
  assert.match(CLIENT_SOURCE, /className: 'sm-switch', title: LIST_SLIM_TITLE/, 'label 带 title 悬停说明')
  assert.match(CLIENT_SOURCE, /'aria-label': '会话列表瘦身'/, 'input 带 aria-label')
  const matched = CLIENT_SOURCE.match(/const LIST_SLIM_TITLE = '([^']+)'/)
  assert.ok(matched, '说明文案常量存在')
  assert.ok(matched[1].length >= 40, '说明文案须讲清用途,不少于 40 字')
})

test('样式类名带本包前缀 sm-', () => {
  for (const selector of ['.sm-switch {', '.sm-switch__track', '.sm-switch__thumb']) {
    assert.ok(CLIENT_SOURCE.includes(selector), selector + ' 存在')
  }
})
