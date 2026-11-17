// status-meta:运行状态展示元数据的单一事实源(列表与日志 Tab 同源)。
// client.js LOGIC 段镜像此表,parity 测试锁定(双实现同源规约)。

// 落库运行状态的唯一名单:store/executor/scheduler/shell-runner 的写入点全集,
// parity 测试以此为准断言「展示元数据无遗漏、无多余」
export const RUN_STATUSES = [
  'queued',
  'running',
  'success',
  'fail',
  'timeout',
  'skipped',
  'interrupted',
  'cancelled',
]

export const STATUS_META = {
  queued: { label: '排队中', tone: 'mute' },
  running: { label: '运行中', tone: 'run' },
  success: { label: '成功', tone: 'ok' },
  fail: { label: '失败', tone: 'bad' },
  timeout: { label: '超时', tone: 'bad' },
  skipped: { label: '跳过', tone: 'mute' },
  interrupted: { label: '中断', tone: 'mute' },
  cancelled: { label: '已取消', tone: 'mute' },
}

export const TRIGGER_META = {
  cron: { label: '定时' },
  manual: { label: '手动' },
}
