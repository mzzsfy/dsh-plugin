// 成本控制四模块的独立开关:装上插件后默认全关,零行为改变;
// 用户逐项开启后才挂拦截器、跑检测、显示常驻读数。
// 各模块自身的额度 / 阈值配置与开关分开存放,避免同一概念两处布尔。

export const FEATURE_KEYS = ['whatif', 'guard', 'sentinel', 'dock']

export const DEFAULT_FEATURES = Object.fromEntries(FEATURE_KEYS.map((key) => [key, false]))

export function normalizeFeatures(raw) {
  const source = raw && typeof raw === 'object' ? raw : {}
  return Object.fromEntries(FEATURE_KEYS.map((key) => [key, source[key] === true]))
}

export const featureOn = (features, key) => features?.[key] === true
