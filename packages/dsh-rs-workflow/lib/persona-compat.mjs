/**
 * persona 键名版本兼容 — dsh 0.1.5-rc.1 起 dsh-persona 的 config 从
 * { text } 改为 { prefix, suffix }(prefix required),旧键 text 在新宿主
 * 直接报 "$.prefix missing required value",preset 选择即 broken。
 *
 * 仓库内 agent.cordis.yml 恒为新版形态;释放到用户预设根时由 preset-sync
 * 按目标宿主版本回退改写为 text 形态。判定规则:
 *   - 宿主版本可解析(语义化 x.y.z[-后缀])且 < 0.1.5(含全部预发布)→ text
 *   - 其余(版本缺失/无法解析/≥0.1.5)→ 保持 prefix 原文(安全侧:新宿主
 *     schema 只认 prefix,原文即正确;未知版本按最新处理)
 */

/** 解析 "x.y.z[-pre][+build]" 主版本三元组;不可解析返回 null */
export function parseVersion(version) {
  if (typeof version !== 'string') return null
  const core = version.trim().split('-')[0].split('+')[0]
  const parts = core.split('.')
  if (parts.length !== 3) return null
  const nums = parts.map((part) => (/^\d+$/.test(part) ? Number(part) : NaN))
  if (nums.some((n) => Number.isNaN(n))) return null
  return nums
}

/** 主版本比较:a<b → -1,a>b → 1,相等 → 0 */
export function compareVersions(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1
  }
  return 0
}

/** 宿主是否需要旧版 text 键:版本可解析且 < 0.1.5 */
export function wantsLegacyText(version) {
  const parsed = parseVersion(version)
  if (parsed === null) return false
  return compareVersions(parsed, [0, 1, 5]) < 0
}

/** 把 prefix/suffix 双键形态的 persona 行改写为单 text 键;text 值取
 *  prefix 与 suffix 非空拼接(空行折叠),与旧宿主单段 persona 语义等价。
 *  无 prefix 键或已是 text 形态时原文返回。 */
export function prefixToText(raw) {
  const lines = raw.split('\n')
  const prefixIdx = lines.findIndex((line) => /^[ \t]*prefix:[ \t]*\|/.test(line))
  if (prefixIdx === -1) return raw
  const indent = lines[prefixIdx].match(/^[ \t]*/)[0]
  // 块内容行:缩进比 prefix 键更深的连续行(空行按内容缩进判定归属)
  const contentIndent = (() => {
    for (let i = prefixIdx + 1; i < lines.length; i++) {
      if (lines[i].trim() === '') continue
      return lines[i].match(/^[ \t]*/)[0].length
    }
    return indent.length + 2
  })()
  let blockEnd = prefixIdx + 1
  while (blockEnd < lines.length) {
    const line = lines[blockEnd]
    if (line.trim() === '' || line.match(/^[ \t]*/)[0].length >= contentIndent) blockEnd++
    else break
  }
  const block = lines.slice(prefixIdx + 1, blockEnd)
    .filter((line) => line.trim() !== '')
    .map((line) => line.slice(contentIndent))
    .join('\n')
  if (block === '') return raw
  // suffix 键若在块后紧邻,取其值合并;suffix 行从输出中移除
  const suffixIdx = lines.findIndex((line) => /^[ \t]*suffix:/.test(line))
  let suffixText = ''
  let suffixLineCount = 0
  if (suffixIdx === blockEnd) {
    suffixText = lines[suffixIdx].replace(/^[ \t]*suffix:[ \t]*/, '').trim()
    suffixLineCount = 1
  }
  const textValue = suffixText !== '' ? `${block}\n\n${suffixText}` : block
  const body = textValue.split('\n')
    .map((line) => (line === '' ? '' : `${indent}      ${line}`))
    .filter((line, idx, all) => !(idx === all.length - 1 && line === ''))
  const replacement = [`${indent}text: |-`, ...body]
  lines.splice(prefixIdx, (blockEnd - prefixIdx) + suffixLineCount, ...replacement)
  return lines.join('\n')
}

/** 版本 → 释放产物:旧版本回退 text,其余原文返回 */
export function personaKeysFor(version, raw) {
  return wantsLegacyText(version) ? prefixToText(raw) : raw
}
