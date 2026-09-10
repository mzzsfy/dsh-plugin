// 环境变量同名多值展开:某名称 N 个启用值贡献 N 次,组合数 = 各多值名称值的笛卡尔积;
// DFS 按需产出前 maxExpansion 个完整组合(绝不物化指数级全量,每个产出组含全部变量),
// 截断以 truncated 标志交由调用方告警。

// 多值行(行级 multi 标志,value 为换行拼接)与同名多行两条来源路径归一到值序列;
// multi 行拆分后为空(勾选多值但未填值)回退单空值,与非 multi 空值行语义一致
// (否则该名下 0 值导致整体 0 组合,静默不执行)
function valuesOf(row) {
  if (row.multi === true) {
    const values = String(row.value ?? '').split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '')
    return values.length > 0 ? values : ['']
  }
  return [row.value]
}

export function expandEnvMatrix({ envs, maxExpansion }) {
  const enabled = envs.filter((row) => row.enabled)
  const byName = new Map()
  for (const row of enabled) {
    const values = byName.get(row.name) || []
    values.push(...valuesOf(row))
    byName.set(row.name, values)
  }
  const names = [...byName.keys()]

  // 深度优先按字典序产出;count 达上限即整枝剪断
  const combinations = []
  let truncated = false
  function walk(index, current) {
    if (combinations.length >= maxExpansion) {
      truncated = true
      return
    }
    if (index === names.length) {
      combinations.push({ ...current })
      return
    }
    for (const value of byName.get(names[index])) {
      if (combinations.length >= maxExpansion) {
        truncated = true
        return
      }
      current[names[index]] = value
      walk(index + 1, current)
      delete current[names[index]]
    }
  }
  walk(0, {})

  return { combinations, truncated }
}
