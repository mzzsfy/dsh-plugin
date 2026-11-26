// store:envs/jobs/runs 三份 JSON 的原子读写。读走内存缓存,写经进程内互斥链串行化,
// 单次写 = 临时文件 + 改名(原子替换);坏文件备份 .bak 后拒绝该集合写入,防空 store 覆盖。
// 任务行把「配置版本」与「运行时状态」分开:只有配置写推进 updatedAt(客户端乐观锁基线),
// 调度/执行回填走 updateRuntime 只记 runtimeUpdatedAt,活跃任务不会因运行态变化而编辑 409。

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

// 配置版本严格单调:同一毫秒内连续写也推进,避免并发 PATCH 的比较基线与新写入相同
function nextConfigVersion(previous) {
  const floor = Number.isFinite(previous) ? previous + 1 : 0
  return Math.max(Date.now(), floor)
}

function applyPatch(row, patch) {
  // undefined 值 = 显式清空(删键):JSON 落盘本就丢弃 undefined,原地保留会留下幽灵键
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete row[key]
    else row[key] = value
  }
}

// 单集合持久化:加载/读缓存/互斥链写。所有集合经 link 容器共享一条写链(link.chain 重绑),
// 保证跨文件写序与进程内串行;损坏标记集合级隔离:单文件损坏只禁该集合写,其余集合不受连坐
function createCollection({ file, link, idKey }) {
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
    get broken() {
      return broken
    },
    async load() {
      if (loaded) return
      loaded = true
      try {
        const text = await readFile(file, 'utf8')
        const parsed = JSON.parse(text)
        if (Array.isArray(parsed)) {
          rows = parsed
        } else {
          // 合法 JSON 但不是数组同属损坏:不备份就继续写会把原数据整体覆盖丢失
          broken = true
          await rename(file, file + BAK_SUFFIX).catch(() => {})
        }
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
      const result = link.chain.then(async () => {
        const outcome = await fn(rows)
        if (outcome !== false) await persistLocked()
        return outcome
      })
      link.chain = result.catch(() => {})
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
        applyPatch(row, patch)
        row.updatedAt = nextConfigVersion(row.updatedAt)
        updated = { ...row }
      })
      return updated
    },
    // 运行时回填:不推进配置版本(updatedAt),只记 runtimeUpdatedAt。
    // patch 可以是函数:读改写发生在同一临界区内,避免「先读后写」把并发改动的字段覆盖回旧值
    async updateRuntime(id, patch) {
      let updated
      await this.mutate((list) => {
        const row = list.find((item) => item[idKey] === id)
        if (row === undefined) return false
        applyPatch(row, typeof patch === 'function' ? patch(row) ?? {} : patch)
        row.runtimeUpdatedAt = Date.now()
        updated = { ...row }
      })
      return updated
    },
    // 乐观锁 CAS:比较 expectedUpdatedAt 与写入在同一临界区内完成,
    // 两个并发 PATCH 携带同一基线只有一个能成功;expected 缺省 = 不做版本校验
    async updateIf(id, expectedUpdatedAt, patch) {
      const outcome = { ok: false, reason: 'missing', row: undefined }
      await this.mutate((list) => {
        const row = list.find((item) => item[idKey] === id)
        if (row === undefined) return false
        if (expectedUpdatedAt !== undefined && row.updatedAt !== expectedUpdatedAt) {
          outcome.reason = 'conflict'
          return false
        }
        if (Object.keys(patch).length === 0) {
          outcome.ok = true
          outcome.reason = null
          outcome.row = { ...row }
          return false
        }
        applyPatch(row, patch)
        row.updatedAt = nextConfigVersion(row.updatedAt)
        outcome.ok = true
        outcome.reason = null
        outcome.row = { ...row }
      })
      return outcome
    },
    async remove(id, expectedUpdatedAt) {
      let removed = false
      await this.mutate((list) => {
        const index = list.findIndex((item) => item[idKey] === id)
        if (index < 0) return false
        if (expectedUpdatedAt !== undefined && list[index].updatedAt !== expectedUpdatedAt) return false
        list.splice(index, 1)
        removed = true
      })
      return removed
    },
  }
}

export async function createStore({ dir }) {
  const link = { chain: Promise.resolve() }
  const makeFile = (name) => join(dir, name)

  const envsBase = createCollection({ file: makeFile('envs.json'), link, idKey: 'id' })
  const jobsBase = createCollection({ file: makeFile('jobs.json'), link, idKey: 'id' })
  const runs = createCollection({ file: makeFile('runs.json'), link, idKey: 'runId' })
  await Promise.all([envsBase.load(), jobsBase.load(), runs.load()])
  // 孤儿运行记录回收:任务删除与运行清理跨两个集合文件,进程在中间退出会留下
  // jobId 指向不存在任务的 run;加载时统一收敛,避免看板出现无主历史
  const prunedOrphans = await pruneOrphanRuns()

  // 文本导入:清空与批量追加在同一次 mutate 内完成(单次落盘,半导入不可回滚的场景不存在)
  const envs = {
    get rows() {
      return envsBase.rows
    },
    get broken() {
      return envsBase.broken
    },
    load: () => envsBase.load(),
    list: (filter) => envsBase.list(filter),
    get: (id) => envsBase.get(id),
    mutate: (fn) => envsBase.mutate(fn),
    create: (data) => envsBase.create(data),
    update: (id, patch) => envsBase.update(id, patch),
    remove: (id) => envsBase.remove(id),
    importRows(rows, { overwrite = false } = {}) {
      return envsBase.mutate((list) => {
        const now = Date.now()
        if (overwrite) list.length = 0
        for (const row of rows) {
          list.push({
            id: randomUUID(),
            name: row.name,
            value: row.value,
            // multi 必须随导入一起落库:只存换行文本会丢失多值语义
            multi: row.multi === true || (typeof row.value === 'string' && row.value.includes('\n')),
            remarks: row.remarks,
            enabled: true,
            createdAt: now,
            updatedAt: now,
          })
        }
        return rows.length
      })
    },
  }

  // 任务删除连带清除其运行记录(日志目录由调用方连带清理)
  const jobs = {
    get rows() {
      return jobsBase.rows
    },
    get broken() {
      return jobsBase.broken
    },
    load: () => jobsBase.load(),
    list: (filter) => jobsBase.list(filter),
    get: (id) => jobsBase.get(id),
    mutate: (fn) => jobsBase.mutate(fn),
    create: (data) => jobsBase.create(data),
    update: (id, patch) => jobsBase.update(id, patch),
    updateRuntime: (id, patch) => jobsBase.updateRuntime(id, patch),
    updateIf: (id, expectedUpdatedAt, patch) => jobsBase.updateIf(id, expectedUpdatedAt, patch),
    async remove(id, expectedUpdatedAt) {
      const removed = await jobsBase.remove(id, expectedUpdatedAt)
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

  // 无主运行记录:任务已不存在则整行丢弃(集合损坏时不动,避免误删唯一现场)。
  // 卫生工作:任何失败都只留痕,不让整个装配失败;任务集合为空而运行记录非空视为可疑
  // (典型是 jobs.json 缺失),此时跳过,防止一次误判清空全部历史
  async function pruneOrphanRuns() {
    if (jobsBase.broken || runs.broken) return 0
    if (jobsBase.rows.length === 0 && runs.rows.length > 0) {
      process.stderr.write('[cron-board] 任务集合为空但存在运行记录,跳过孤儿回收(疑似任务文件缺失)\n')
      return 0
    }
    try {
      const alive = new Set(jobsBase.rows.map((row) => row.id))
      const orphans = runs.rows.filter((row) => !alive.has(row.jobId))
      if (orphans.length === 0) return 0
      const ids = new Set(orphans.map((row) => row.runId))
      await runs.mutate((list) => {
        const keep = list.filter((row) => !ids.has(row.runId))
        list.length = 0
        list.push(...keep)
      })
      return orphans.length
    } catch (error) {
      process.stderr.write('[cron-board] 孤儿运行记录回收失败: ' + String(error && error.message ? error.message : error) + '\n')
      return 0
    }
  }

  return {
    envs,
    jobs,
    // 写链排空:等待已提交 mutate 全部结束(不报告写失败);卸载与测试清理前调用,缩小与删除的竞态面
    flush: () => link.chain.catch(() => {}),
    // 启动期回收结果:供插件在装配后留痕(孤儿运行记录数)
    get orphanRunsPruned() {
      return prunedOrphans
    },
    runs: {
      get rows() {
        return runs.rows
      },
      get broken() {
        return runs.broken
      },
      list: (jobId) => (jobId ? runs.list((row) => row.jobId === jobId) : runs.list()),
      get: (runId) => runs.get(runId),
      create: createRun,
      update: (runId, patch) => runs.update(runId, patch),
      remove: (runId) => runs.remove(runId),
    },
  }
}
