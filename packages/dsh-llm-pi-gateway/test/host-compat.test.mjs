// 宿主兼容探测 BDD:0.1.2 引入的 dsh-llm 导出缺失时插件禁用,不注册任何服务;
// 齐全时正常注册。纯函数三态直测,apply 胶水由 smoke-load 回归兜底。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as realDshLlm from '@deepseek-ai/dsh-llm'
import { missingHostExports } from '../src/index.js'

test('探测清单:宿主导出齐全返回空表', () => {
  assert.deepEqual(missingHostExports(realDshLlm), [])
})

test('探测清单:缺失任一必备导出即报告其名,双缺报告两名', () => {
  const partial = { ...realDshLlm, offloadedImageText: undefined }
  assert.deepEqual(missingHostExports(partial), ['offloadedImageText'])
  const bare = {}
  assert.deepEqual(missingHostExports(bare), ['resolveImageAttachmentAccess', 'offloadedImageText'])
})
