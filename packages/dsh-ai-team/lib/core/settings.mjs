// 设置契约:显式保存/取消,expectedConfigRevision 乐观锁;冲突保留草稿不覆盖(DATA-06)。
// null 语义=跟随宿主默认/未设置。
import { fail, pass } from './command.mjs'

export function createSettings(now) {
  return { configRevision: 1, values: { concurrencyReference: null }, updatedAt: now() }
}

const FIELD_VALIDATORS = {
  concurrencyReference: (v) => v === null || (Number.isInteger(v) && v >= 1 && v <= 16) ? null : 'concurrencyReference 须为 null 或 1..16 整数',
}

export function validateSettingsValues(values) {
  const bad = Object.entries(values ?? {}).map(([k, v]) => (FIELD_VALIDATORS[k] ? FIELD_VALIDATORS[k](v) : `未知设置字段: ${k}`)).filter(Boolean)
  return bad.length === 0 ? pass(values) : fail('INVALID_ARGUMENT', bad.join('; '))
}

// settings.save:revision 不符返回 CONFIG_CONFLICT;成功递增 revision
export function saveSettings(settings, { expectedConfigRevision, values }) {
  if (expectedConfigRevision !== settings.configRevision) {
    return fail('CONFIG_CONFLICT', `设置已被其他保存更新(当前 revision ${settings.configRevision},请求基于 ${expectedConfigRevision})`)
  }
  const checked = validateSettingsValues(values)
  if (!checked.ok) return checked
  return pass({ ...settings, values: { ...settings.values, ...values }, configRevision: settings.configRevision + 1 })
}
