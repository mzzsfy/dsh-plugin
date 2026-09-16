import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const CLIENT_SRC = readFileSync(fileURLToPath(new URL('../src/client.js', import.meta.url)), 'utf8')

// 设置项悬停说明契约:说明常量必须存在且逐项挂到对应控件(title 属性)。
// 开关行断言以常量为锚回看相邻的行文本,配置行断言以展示文案为锚——
// 防常量互换挂载或挂错行仍通过(纯存在性匹配检不出错挂)
test('源码契约:五项设置的悬停说明齐备且挂到对应控件', () => {
  const TITLES = {
    HISTORY_SWITCH_TITLE: '历史输入浮层开关',
    STEER_SWITCH_TITLE: '插话撤回开关',
    FOLD_SWITCH_TITLE: '文件夹运行标记开关',
    ARCHIVE_OVERVIEW_TITLE: '自动归档行',
    ARCHIVE_DAYS_TITLE: '阈值字段',
    ARCHIVE_INTERVAL_TITLE: '检查周期字段',
  }
  for (const [name, label] of Object.entries(TITLES)) {
    assert.ok(CLIENT_SRC.includes('const ' + name + ' ='), '缺悬停说明常量 ' + name)
  }
  // 三个开关行 DOM 形态相同,以「常量挂载点向前找最近的行文本」判归属:
  // title 常量与其行文本必须出现在同一段组件返回里(行文本先于 title 出现)
  const rowAnchors = [
    { constant: 'HISTORY_SWITCH_TITLE', text: "'历史输入浮层(Alt+↑)'", label: TITLES.HISTORY_SWITCH_TITLE },
    { constant: 'STEER_SWITCH_TITLE', text: "'插话撤回图标'", label: TITLES.STEER_SWITCH_TITLE },
    { constant: 'FOLD_SWITCH_TITLE', text: "'工作区文件夹运行标记'", label: TITLES.FOLD_SWITCH_TITLE },
  ]
  for (const { constant, text, label } of rowAnchors) {
    const mounted = new RegExp("title: " + constant + "[\\s\\S]{0,400}" + text.replace(/[+↑()]/g, '\\$&')).test(CLIENT_SRC)
    assert.ok(mounted, label + ' 未挂对应悬停说明(常量与行文本不在同一组件返回段)')
  }
  const configAnchors = [
    { constant: 'ARCHIVE_OVERVIEW_TITLE', text: "'自动归档'", label: TITLES.ARCHIVE_OVERVIEW_TITLE },
    { constant: 'ARCHIVE_DAYS_TITLE', text: "'阈值', numberInput('days')", label: TITLES.ARCHIVE_DAYS_TITLE },
    { constant: 'ARCHIVE_INTERVAL_TITLE', text: "'检查周期', numberInput('intervalHours')", label: TITLES.ARCHIVE_INTERVAL_TITLE },
  ]
  for (const { constant, text, label } of configAnchors) {
    const mounted = new RegExp('title: ' + constant + '[\\s\\S]{0,120}' + text.replace(/[()']/g, '\\$&')).test(CLIENT_SRC)
    assert.ok(mounted, label + ' 未挂对应悬停说明(常量与字段不在同一配置行)')
  }
})

// 说明文案与行为同源的抽样锁定:核心语义缺失即为文案回归
test('源码契约:悬停说明覆盖各设置的关键行为语义', () => {
  assert.ok(CLIENT_SRC.includes('空白(无消息)会话不参与归档'), '阈值说明缺空白会话例外(core.mjs selectArchiveCandidates 过滤 blank)')
  assert.ok(CLIENT_SRC.includes('0 = 关闭自动归档'), '阈值说明缺 0 关闭语义')
  assert.ok(CLIENT_SRC.includes('0 = 关闭周期检查'), '周期说明缺 0 关闭语义')
  assert.ok(CLIENT_SRC.includes('刷新页面生效'), '开关说明缺刷新生效提示')
  assert.ok(CLIENT_SRC.includes('含附件的插话不可撤回'), '撤回说明缺附件限制')
  assert.ok(CLIENT_SRC.includes('文件夹折叠与展开同样生效'), '运行标记说明缺折叠生效声明')
})
