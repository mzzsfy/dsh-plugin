// 升级进度:宿主安装阶段时间线与 npm 输出尾部。

export const UPGRADE_PHASE_LABELS = Object.freeze({
  accepted: '准备升级',
  'pre-switch': '最终核验',
  preparing: '准备安装目录',
  installing: '安装依赖',
  validating: '验证候选版本',
  'ready-to-switch': '切换安装链接',
  'awaiting-restart': '等待宿主重启',
  failed: '升级失败',
  indeterminate: '状态不确定',
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
  }
}

export function updateProgressPhase(progress, phase, at) {
  return { ...progress, phase, phaseStartedAt: at }
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
  return {
    phase,
    phaseLabel: UPGRADE_PHASE_LABELS[phase] ?? phase,
    startedAt,
    phaseStartedAt,
    elapsedMs: Math.max(0, now - startedAt),
    phaseElapsedMs: Math.max(0, now - phaseStartedAt),
    outputTail: progress?.outputTail ?? '',
    outputUpdatedAt: progress?.outputUpdatedAt ?? null,
  }
}
