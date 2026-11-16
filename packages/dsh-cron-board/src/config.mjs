// 全局默认常量:宿主 settings 未就绪/未覆盖时的兜底值(计算表达式,禁魔法值)

export const DEFAULT_TIMEOUT_MS = 60 * 60 * 1000
// 同名多值组合数全局上限:超限截断防打爆机器(设计 §4.2)
export const DEFAULT_MAX_EXPANSION = 20
// 全局并发上限:同时运行的执行单元数(设计 §4.1)
export const DEFAULT_MAX_CONCURRENT = 2
// 调度 tick 周期与下限(设计 §4.1)
export const DEFAULT_TICK_MS = 30 * 1000
export const MIN_TICK_MS = 5 * 1000
// 日志读取缺省窗口行数:全文只经显式导出(tail=all),面板默认不载整份日志
export const DEFAULT_LOG_TAIL_LINES = 1000
// 会话任务通道不可用的唯一文案来源(stderr 告警与 400 响应同源)
export const SESSION_UNAVAILABLE_REASON = '宿主会话服务 sessionController 不可用,会话任务通道不可用,脚本任务不受影响'
// 删除窗口拒绝新运行的唯一文案来源(执行链准入与路由 409 响应同源)
export const JOB_DELETING_REASON = '任务删除中,拒绝新运行'
