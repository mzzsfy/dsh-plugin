// 升级进度:阶段时间线、插件级步骤与 npm 输出尾部,纯函数便于 host/client 文案对拍与单测。

export const UPGRADE_PHASE_LABELS = Object.freeze({
  accepted: '准备升级',
  'pre-switch': '提交前准备(插件升级与最终核验)',
  preparing: '准备安装目录',
  installing: '安装依赖',
  validating: '验证候选版本',
  'ready-to-switch': '切换安装链接',
  'awaiting-restart': '等待宿主重启',
  failed: '升级失败',
  indeterminate: '状态不确定',
})

// 宿主 plugin-manager/update-state 的步骤标签:升级是有 HMR 时的移除+安装,
// 对用户即"禁用旧版本、启用新版本";restoring 是安装失败后回装旧版本
export const PLUGIN_STEP_LABELS = Object.freeze({
  checking: '正在检查插件',
  removing: '正在禁用插件',
  installing: '正在启用插件',
  restoring: '正在恢复插件',
})

// npm 输出尾部上限:面板只展示最近一段,避免长安装把内存与渲染拖垮
export const OUTPUT_TAIL_LIMIT = 16 * 1024

const ANSI_PATTERN = /\u001b\[[0-9;]*[A-Za-z]/g

function normalizeOutput(chunk) {
  return String(chunk ?? '').replace(ANSI_PATTERN, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n')
}

export function createProgress(startedAt) {
  return {
    startedAt,
    phase: 'accepted',
    phaseStartedAt: startedAt,
    outputTail: '',
    outputUpdatedAt: null,
    plugin: null,
    items: [],
  }
}

export function updateProgressPhase(progress, phase, at) {
  return { ...progress, phase, phaseStartedAt: at }
}

// 当前插件:name/index/total 由编排层给出,step 由宿主事件推进
export function updateProgressPlugin(progress, plugin) {
  return { ...progress, plugin }
}

// 逐插件终态快照:面板按此列出等待/升级中/已更新/失败/跳过
export function updateProgressItems(progress, items) {
  return { ...progress, items: Array.isArray(items) ? items.map((item) => ({ ...item })) : [] }
}

export function appendProgressOutput(progress, chunk, at) {
  const text = normalizeOutput(chunk)
  if (text.length === 0) return progress
  const combined = progress.outputTail + text
  return { ...progress, outputTail: combined.slice(-OUTPUT_TAIL_LIMIT), outputUpdatedAt: at }
}

export function progressSnapshot(progress, now) {
  const startedAt = Number(progress?.startedAt) || now
  const phaseStartedAt = Number(progress?.phaseStartedAt) || startedAt
  const phase = progress?.phase || 'accepted'
  const plugin = progress?.plugin ?? null
  const phaseLabel = plugin
    ? (PLUGIN_STEP_LABELS[plugin.step] ?? '正在升级插件') + ' ' + plugin.name + '(' + plugin.index + '/' + plugin.total + ')'
    : (UPGRADE_PHASE_LABELS[phase] ?? phase)
  return {
    phase,
    phaseLabel,
    startedAt,
    phaseStartedAt,
    elapsedMs: Math.max(0, now - startedAt),
    phaseElapsedMs: Math.max(0, now - phaseStartedAt),
    outputTail: progress?.outputTail ?? '',
    outputUpdatedAt: progress?.outputUpdatedAt ?? null,
    plugin,
    items: Array.isArray(progress?.items) ? progress.items : [],
  }
}
