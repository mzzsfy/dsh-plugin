// 环境变量同名多值展开:某名称 N 个启用值贡献 N 次,组合数 = 各多值名称值的笛卡尔积;
// 超全局上限截断(防误导入海量变量打爆机器),截断以 truncated 标志交由调用方告警。

export function expandEnvMatrix({ envs, maxExpansion }) {
  const enabled = envs.filter((row) => row.enabled)
  const byName = new Map()
  for (const row of enabled) {
    const values = byName.get(row.name) || []
    values.push(row.value)
    byName.set(row.name, values)
  }

  // 单值名称直接并入每组;多值名称逐层扩展笛卡尔积
  let combinations = [{}]
  for (const [name, values] of byName) {
    const expanded = []
    for (const base of combinations) {
      for (const value of values) {
        expanded.push({ ...base, [name]: value })
      }
    }
    combinations = expanded
  }

  const truncated = combinations.length > maxExpansion
  return {
    combinations: truncated ? combinations.slice(0, maxExpansion) : combinations,
    truncated,
  }
}
