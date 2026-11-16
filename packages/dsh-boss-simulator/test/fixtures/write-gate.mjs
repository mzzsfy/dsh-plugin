// 测试辅助:按生产接线(control.mjs 的 webServer.register)包装写路由处理器。
// 直调 handler 的用例只覆盖业务;跨源/JSON content-type 闸门必须在 withRouteGate 这一层验证。
import { withRouteGate } from '../../lib/route-gate.mjs'

export const gatedWrite = (handler, ctx = { get: () => undefined }) => withRouteGate(ctx, handler)
