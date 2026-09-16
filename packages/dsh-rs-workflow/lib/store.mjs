// run-store(v5):每 run 全量 JSON + index.json 索引;LRU 容量收敛;零截断
// namespace 子目录 v5/(与 v4 旧数据物理隔离,零兼容);record 增 plan/warnings/controls[].by(见 data-design.md)
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

export const KEEP_RUNS = 200
export const ACTIVE_STATES = new Set(['running', 'paused', 'waiting_approval'])
const RUN_ID_RE = /^[a-z0-9-]+$/
const REQUEST_PREVIEW = 120
const CONTROL_EVENTS = new Set(['control'])

let seq = 0
const genRunId = () => `r-${Date.now().toString(36)}-${++seq}`

// v5 namespace:dataDir(dsh-rs-workflow 根)下的 v5/ 子目录;DSH_RS_WORKFLOW_DATA_DIR 覆写根
export function defaultDataDir() {
  if (process.env.DSH_RS_WORKFLOW_DATA_DIR) return join(process.env.DSH_RS_WORKFLOW_DATA_DIR, 'v5')
  return join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'dsh-rs-workflow', 'v5')
}

const emptyState = () => ({ status: 'running', steps: {}, approvals: {}, escalations: 0, queued: [], batchSeq: 0, slotCursor: {}, controlSeq: 0, redoInfo: {} })

export function createStore({ dir = defaultDataDir(), logger = console, keepRuns = KEEP_RUNS } = {}) {
  const runsDir = join(dir, 'runs')
  const indexPath = join(dir, 'index.json')
  const records = new Map()
  const index = []
  let loaded = false

  const warn = (message) => logger.warn?.(`[rsww-store] ${message}`)

  const writeAtomic = (path, text) => {
    const tmp = join(tmpdir(), `rsww-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    writeFileSync(tmp, text, 'utf8')
    renameSync(tmp, path)
  }

  const persistRun = (record) => writeAtomic(join(runsDir, `${record.runId}.json`), JSON.stringify(record, null, 2))
  const persistIndex = () => writeAtomic(indexPath, JSON.stringify({ runs: index }, null, 2))

  const indexEntryOf = (record) => ({
    runId: record.runId, sessionId: record.sessionId, workspace: record.workspace,
    templateId: record.templateId, status: record.status, createdAt: record.createdAt,
    finishedAt: record.finishedAt, summary: record.summary,
    request: typeof record.request === 'string' ? record.request.slice(0, REQUEST_PREVIEW) : record.request,
  })

  const loadFileRecord = (path, collectIndex) => {
    const record = JSON.parse(readFileSync(path, 'utf8'))
    records.set(record.runId, record)
    if (collectIndex) index.push(indexEntryOf(record))
    if (ACTIVE_STATES.has(record.status)) {
      const at = new Date().toISOString()
      record.status = 'cancelled'
      record.finishedAt = at
      if (!record.summary) record.summary = '进程重启,运行中断,可在会话页签断点续跑'
      record.controls = [...(record.controls ?? []), { at, kind: 'cancel', text: '进程重启,自动收敛' }]
      persistRun(record)
      const entry = index.find((e) => e.runId === record.runId)
      if (entry) Object.assign(entry, indexEntryOf(record))
    }
  }

  const removeInternal = (runId) => {
    records.delete(runId)
    const at = index.findIndex((e) => e.runId === runId)
    if (at >= 0) index.splice(at, 1)
    rmSync(join(runsDir, `${runId}.json`), { force: true })
  }

  const ensureLoaded = () => {
    if (loaded) return
    loaded = true
    mkdirSync(runsDir, { recursive: true })
    let indexValid = false
    if (existsSync(indexPath)) {
      try {
        const parsed = JSON.parse(readFileSync(indexPath, 'utf8'))
        if (Array.isArray(parsed.runs)) {
          for (const entry of parsed.runs) index.push(entry)
          indexValid = true
        }
      } catch {
        index.length = 0
      }
    }
    const files = []
    try {
      for (const name of readdirSync(runsDir)) if (name.endsWith('.json')) files.push(name)
    } catch (e) {
      warn(`runs 目录扫描失败:${e.message}`)
    }
    for (const name of files) {
      try {
        loadFileRecord(join(runsDir, name), !indexValid)
      } catch (e) {
        warn(`运行记录 ${name} 读取失败,跳过:${e.message}`)
      }
    }
    // 对账:runs/ 文件集合为权威修齐 index(缺行补、幽灵行删),仅内存修正
    let repaired = false
    const fileIds = new Set(records.keys())
    for (const record of records.values()) {
      if (!index.some((e) => e.runId === record.runId)) {
        index.push(indexEntryOf(record))
        repaired = true
      }
    }
    for (let i = index.length - 1; i >= 0; i--) {
      if (!fileIds.has(index[i].runId)) {
        index.splice(i, 1)
        repaired = true
      }
    }
    if (!indexValid || repaired) {
      index.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      persistIndex()
    }
  }

  const assertRunId = (runId) => {
    if (typeof runId !== 'string' || !RUN_ID_RE.test(runId)) throw new Error(`runId 非法:${runId}`)
  }

  const evictOverCapacity = () => {
    const finished = index.filter((e) => !ACTIVE_STATES.has(e.status)).sort((a, b) => String(a.finishedAt || a.createdAt).localeCompare(String(b.finishedAt || b.createdAt)))
    let excess = finished.length - keepRuns
    let evicted = false
    for (const entry of finished) {
      if (excess <= 0) break
      excess--
      removeInternal(entry.runId)
      evicted = true
    }
    if (evicted) persistIndex()
  }

  const store = {
    start({ runId, sessionId, workspace, request, templateId, inputs, plan, warnings, state }) {
      ensureLoaded()
      const id = runId === undefined || runId === null || runId === '' ? genRunId() : runId
      assertRunId(id)
      if (records.has(id)) throw new Error(`runId 已存在:${id}`)
      const at = new Date().toISOString()
      const record = {
        runId: id, templateId: templateId ?? '', sessionId: sessionId ?? '', workspace: workspace ?? '',
        request: request ?? '', inputs: inputs ?? {}, status: 'running', createdAt: at, finishedAt: undefined,
        summary: undefined, plan: plan ?? null, warnings: warnings ?? [],
        state: state ?? emptyState(), controls: [], stepsTrace: {}, queued: [],
      }
      records.set(id, record)
      index.unshift(indexEntryOf(record))
      persistRun(record)
      persistIndex()
      evictOverCapacity()
      return record
    },

    step({ runId, stepId, instance, event, body }) {
      ensureLoaded()
      assertRunId(runId)
      const record = records.get(runId)
      if (!record) throw new Error(`运行记录不存在:${runId}`)
      const at = new Date().toISOString()
      if (CONTROL_EVENTS.has(event)) {
        // controls 裁决/控制记账:v5 增 by(裁决来源)与 reason(代审必填)
        record.controls.push({ at, kind: body?.kind, by: body?.by, reason: body?.reason, text: body?.text, inject: body?.inject })
      } else {
        const key = instance ?? '-'
        const stepEvents = (record.stepsTrace[stepId] ??= {})
        ;(stepEvents[key] ??= []).push({ event, at, ...body })
      }
      persistRun(record)
      return record
    },

    update({ runId, state, status, summary, finishedAt, queued }) {
      ensureLoaded()
      assertRunId(runId)
      const record = records.get(runId)
      // 记录已被移除(run-remove)时丢弃 dangling 写,保 driver 收尾链走完注销
      if (!record) return undefined
      if (state !== undefined) record.state = state
      if (status !== undefined) record.status = status
      if (summary !== undefined) record.summary = summary
      if (finishedAt !== undefined) record.finishedAt = finishedAt
      if (queued !== undefined) record.queued = queued
      persistRun(record)
      return record
    },

    finish({ runId, status, summary }) {
      ensureLoaded()
      assertRunId(runId)
      const record = records.get(runId)
      // 同 update:记录缺失即收尾目标已达成,幂等无害丢弃
      if (!record) return undefined
      record.status = status
      record.finishedAt = new Date().toISOString()
      record.summary = summary ?? ''
      persistRun(record)
      const entry = index.find((e) => e.runId === runId)
      if (entry) Object.assign(entry, indexEntryOf(record))
      persistIndex()
      evictOverCapacity()
      return record
    },

    get(runId) {
      ensureLoaded()
      assertRunId(runId)
      const record = records.get(runId)
      if (!record) throw new Error(`运行记录不存在:${runId}`)
      return record
    },

    has(runId) {
      ensureLoaded()
      return records.has(runId)
    },

    list({ sessionId, workspace } = {}) {
      ensureLoaded()
      return index
        .filter((e) => (sessionId === undefined || e.sessionId === sessionId) && (workspace === undefined || e.workspace === workspace))
        .map((e) => ({ ...e }))
    },

    remove(runId) {
      ensureLoaded()
      assertRunId(runId)
      removeInternal(runId)
      persistIndex()
    },
  }
  return store
}

let singleton = null
export function reportStore() {
  singleton ??= createStore()
  return singleton
}
