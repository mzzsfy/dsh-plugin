// common-tools host 桩(经 --import 预载,先于被测模块实例化拦截 ESM):
// publish 记入 busStub.published(断言点零改);onPresence 注册即报 0,
// busStub.presence 供测试手动驱动连接计数
import { mock } from 'node:test'

export const busStub = { published: [], presence: new Set() }
export function resetBusStub() {
  busStub.published = []
  busStub.presence = new Set()
}

mock.module('@mzzsfy/dsh-common-tools/host', {
  namedExports: {
    createChangeNotifier: refresh => ({ refresh, dispose() {} }),
    setupCommonTools: () => ({
      publish: (payload = null) => busStub.published.push(payload),
      onPresence(fn) { busStub.presence.add(fn); fn(0); return () => busStub.presence.delete(fn) },
    }),
  },
})
