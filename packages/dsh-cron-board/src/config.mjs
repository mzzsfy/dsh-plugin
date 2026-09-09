// 全局默认常量:宿主 settings 未就绪/未覆盖时的兜底值(计算表达式,禁魔法值)

export const DEFAULT_TIMEOUT_MS = 60 * 60 * 1000
// 同名多值组合数全局上限:超限截断防打爆机器(设计 §4.2)
export const DEFAULT_MAX_EXPANSION = 20
// 全局并发上限:同时运行的执行单元数(设计 §4.1)
export const DEFAULT_MAX_CONCURRENT = 2
// 调度 tick 周期与下限(设计 §4.1)
export const DEFAULT_TICK_MS = 30 * 1000
export const MIN_TICK_MS = 5 * 1000
