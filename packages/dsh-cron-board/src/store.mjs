// store:envs/jobs/runs 三份 JSON 的原子读写。读走内存缓存,写经进程内互斥链串行化,
// 单次写 = 临时文件 + 改名(原子替换);坏文件备份 .bak 后拒绝该集合写入,防空 store 覆盖。

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const BAK_SUFFIX = '.bak'
const TMP_SUFFIX = '.tmp'

// Windows 下对刚写入目标的替换 rename 会报瞬态 EACCES/EBUSY/EPERM(Defender/索引器短暂锁定),
// 有界重试消解;节奏镜像官方 dsh-atomic-write 的同名处理
const RETRY_INITIAL_MS = 20
const RETRY_MAX_MS = 200
const RETRY_LIMIT = 8

function isTransientRenameError(error) {
  return process.platform === 'win32' && ['EACCES', 'EBUSY', 'EPERM'].includes(error && error.code)
}

async function renameWithRetry(temp, file) {
  let delay = RETRY_INITIAL_MS
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(temp, file)
      return
    } catch (error) {
      if (!isTransientRenameError(error) || attempt >= RETRY_LIMIT) throw error
    }
    await new Promise((resolve) => setTimeout(resolve, delay))
    delay = Math.min(delay * 2, RETRY_MAX_MS)
  }
}

// 每任务运行记录元数据保留上限:超限裁最旧,防 runs.json 无界增长
export const RUNS_KEEP_PER_JOB = 200

function isMissing(error) {
  return Boolean(error) && error.code === 'ENOENT'
}

// 单集合持久化:加载/读缓存/互斥链写。所有集合共享一条写链,保证跨文件写序与进程内串行;
// 损坏标记集合级隔离:单文件损坏只禁该集合写,其余集合不受连坐
function createCollection({ file, chain, idKey }) {
  let rows = []
  let loaded = false
  let broken = false

  function assertUsable() {
    if (broken) throw new Error('数据文件已损坏已备份,已暂停写入以防数据丢失: ' + file)
  }

  async function persistLocked() {
    await mkdir(dirname(file), { recursive: true })
    const tmp = file + TMP_SUFFIX
    await writeFile(tmp, JSON.stringify(rows), 'utf8')
    await renameWithRetry(tmp, file)
  }

  return {
    get rows() {
      return rows
    },
    async load() {
      if (loaded) return
      loaded = true
      try {
        const text = await readFile(file, 'utf8')
        const parsed = JSON.parse(text)
        if (Array.isArray(parsed)) rows = parsed
      } catch (error) {
        if (!isMissing(error)) {
          broken = true
          await rename(file, file + BAK_SUFFIX).catch(() => {})
        }
      }
    },
    list(filter) {
      const source = filter ? rows.filter(filter) : rows
      // 对外浅拷贝:防调用方原地修改污染内存态(mutate 以 Object.assign 原地生效)
      return source.map((row) => ({ ...row }))
    },
    get(id) {
      const row = rows.find((item) => item[idKey] === id)
      return row ? { ...row } : undefined
    },
    // 读改写经共享互斥链串行化;链上失败不传播到后续写,调用方 await 本次结果感知单次失败
    mutate(fn) {
      assertUsable()
      const result = chain.then(async () => {
        const outcome = await fn(rows)
        if (outcome !== false) await persistLocked()
        return outcome
      })
      chain = result.catch(() => {})
      return result
    },
    async create(data) {
      const now = Date.now()
      const row = {
        ...data,
        [idKey]: data[idKey] || randomUUID(),
        createdAt: now,
        updatedAt: now,
      }
      await this.mutate((list) => {
        list.push(row)
      })
      return row
    },
    async update(id, patch) {
      let updated
      await this.mutate((list) => {
        const row = list.find((item) => item[idKey] === id)
        if (row === undefined) return false
        Object.assign(row, patch, { updatedAt: Date.now() })
        updated = row
      })
      return updated
    },
    async remove(id) {
      let removed = false
      await this.mutate((list) => {
        const index = list.findIndex((item) => item[idKey] === id)
        if (index < 0) return false
        list.splice(index, 1)
        removed = true
      })
      return removed
    },
  }
}

export async function createStore({ dir }) {
  const chain = Promise.resolve()
  const makeFile = (name) => join(dir, name)

  const envs = createCollection({ file: makeFile('envs.json'), chain, idKey: 'id' })
  const jobsBase = createCollection({ file: makeFile('jobs.json'), chain, idKey: 'id' })
  const runs = createCollection({ file: makeFile('runs.json'), chain, idKey: 'runId' })
  await Promise.all([envs.load(), jobsBase.load(), runs.load()])

  // 任务删除连带清除其运行记录(日志目录由调用方连带清理)
  const jobs = {
    get rows() {
      return jobsBase.rows
    },
    load: () => jobsBase.load(),
    list: (filter) => jobsBase.list(filter),
    get: (id) => jobsBase.get(id),
    mutate: (fn) => jobsBase.mutate(fn),
    create: (data) => jobsBase.create(data),
    update: (id, patch) => jobsBase.update(id, patch),
    async remove(id) {
      const removed = await jobsBase.remove(id)
      if (!removed) return false
      await runs.mutate((list) => {
        const keep = list.filter((row) => row.jobId !== id)
        list.length = 0
        list.push(...keep)
      })
      return true
    },
  }

  // 运行记录创建:同一任务超出保留上限时裁掉最旧(数组头部新,尾部旧)
  async function createRun(data) {
    const row = await runs.create(data)
    await runs.mutate((list) => {
      const mine = list.filter((item) => item.jobId === row.jobId)
      const excess = mine.length - RUNS_KEEP_PER_JOB
      if (excess <= 0) return false
      const staleIds = new Set(mine.slice(0, excess).map((item) => item.runId))
      const keep = list.filter((item) => !(item.jobId === row.jobId && staleIds.has(item.runId)))
      list.length = 0
      list.push(...keep)
    })
    return row
  }

  return {
    envs,
    jobs,
    runs: {
      get rows() {
        return runs.rows
      },
      list: (jobId) => (jobId ? runs.list((row) => row.jobId === jobId) : runs.list()),
      get: (runId) => runs.get(runId),
      create: createRun,
      update: (runId, patch) => runs.update(runId, patch),
      remove: (runId) => runs.remove(runId),
    },
  }
}
