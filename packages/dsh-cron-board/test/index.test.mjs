// 装配测试:数据目录解析 + webServer prefix 注册 + 装配后请求可用。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { homedir } from 'node:os'
import { join } from 'node:path'

const { apply, resolveDataDir } = await import('../src/index.js')

test('index:数据目录默认 ~/.dsh/cron-board,env 可覆盖', () => {
  assert.equal(resolveDataDir({}), join(homedir(), '.dsh', 'cron-board'))
  assert.equal(resolveDataDir({ DSH_CRON_BOARD_DATA_DIR: 'X:\\tmp\\cb' }), 'X:\\tmp\\cb')
  // 空白覆盖不生效,回默认
  assert.equal(resolveDataDir({ DSH_CRON_BOARD_DATA_DIR: '   ' }), join(homedir(), '.dsh', 'cron-board'))
})

test('index:apply 注册 prefix 路由且请求走通(列表接口)', async () => {
  // Given webServer 桩:收集注册路由
  const routes = new Map()
  const ctx = {
    effect(fn) {
      fn()
    },
    webServer: {
      register(route) {
        routes.set(route.path, route.handler)
        return () => {}
      },
    },
  }
  // When apply(装配)
  apply(ctx)
  // Then prefix 路由已注册
  const handler = routes.get('/api/cron-board')
  assert.ok(handler)
  // When 调用未匹配的子路径(数据目录未初始化也可得到 404 JSON)
  const res = { status: null, payload: null }
  res.writeHead = (status) => { res.status = status }
  res.end = (text) => { res.payload = JSON.parse(text) }
  const req = { method: 'GET', url: 'http://localhost/api/cron-board/__nope__' }
  await handler(req, res)
  assert.equal(res.status, 404)
  assert.ok(res.payload.error)
})
