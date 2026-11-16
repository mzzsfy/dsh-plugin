// 历史文件持久化守卫:读取/解析失败时把坏文件备份为 .bak(覆盖旧备份)并拒绝写入,
// 防止空 store 覆盖 history.json 造成数据丢失;恢复成功读取后解除损坏标记。
// IO 以参数注入,host 半区传真实 fs,单测传临时目录。

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { granularityOf } from './history.mjs'

const BAK_SUFFIX = '.bak'
export const HISTORY_BROKEN_MESSAGE = '历史文件已损坏已备份,已暂停写入以防数据丢失'
const DISPOSED_MESSAGE = '历史存储已停止'

function isMissing(error) {
  return Boolean(error) && error.code === 'ENOENT'
}

// 形状校验:整表必须是 { sequences: { <账号id:档位>: { granularity, points:[{t,v}] } } };
// 合法 JSON 但形状不符与解析失败同样按损坏处理,否则首次 persist 会用空表覆盖旧历史。
// 档位由键后缀唯一决定(history.mjs granularityOf),声明值与后缀不一致同样按损坏:
// 逐点修剪/去重按 granularity 计算留存,声明漂移会让旧点被误删或无限增长。
function isPoint(point) {
  return point !== null && typeof point === 'object' && !Array.isArray(point) &&
    Number.isFinite(point.t) && Number.isFinite(point.v)
}

function keyTier(key) {
  const at = key.indexOf(':')
  return at < 0 ? null : key.slice(at + 1)
}

function isSequenceStore(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  for (const [key, sequence] of Object.entries(value)) {
    if (sequence === null || typeof sequence !== 'object' || Array.isArray(sequence)) return false
    const tier = keyTier(key)
    const expected = tier === null ? null : granularityOf(tier)
    if (expected === null || sequence.granularity !== expected) return false
    if (!Array.isArray(sequence.points)) return false
    if (!sequence.points.every(isPoint)) return false
  }
  return true
}

export function createHistoryStore({ file, io }) {
  const fs = io || { mkdir, readFile, rename, writeFile }
  // 同文件可能被多个实例(HMR 换插件的短窗口)同时持有:临时名按实例唯一,
  // 避免互相 rename 抢同一路径
  const tempFile = `${file}.tmp.${Math.random().toString(36).slice(2, 10)}`
  let sequences = {}
  let loaded = false
  let broken = false
  let stopped = false
  let chain = Promise.resolve()
  // 在途读盘:并发 ensure 共享同一次读,否则第二个调用会拿到 loaded 前一刻的空表
  // 并把它 persist 出去(32MB 历史被空表覆盖,且覆盖前没有 .bak 可回退)
  let loadPromise = null
  const load = () => fs
    .readFile(file, 'utf8')
    .then((text) => {
      const parsed = JSON.parse(text)
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed) || !isSequenceStore(parsed.sequences)) {
        throw new Error('历史文件形状无效')
      }
      sequences = parsed.sequences
      broken = false
      loaded = true
    })
    .catch((error) => {
      if (isMissing(error)) {
        broken = false
        loaded = true
        return undefined
      }
      broken = true
      // 备份失败不阻断损坏标记,写入仍被拒绝
      return fs.rename(file, file + BAK_SUFFIX).catch(() => {})
    })
    .then(() => sequences)
    .finally(() => {
      loadPromise = null
    })
  return {
    get sequences() {
      return sequences
    },
    get broken() {
      return broken
    },
    // 销毁:排队中的写入在真正执行前丢弃,dispose 后不再落盘
    stop() {
      stopped = true
    },
    // 损坏状态下不短路,重读以支持恢复(坏文件已备份移走,重读得到 ENOENT 即解除)
    ensure() {
      if (stopped) return Promise.resolve(sequences)
      if (loaded && !broken) return Promise.resolve(sequences)
      if (loadPromise !== null) return loadPromise
      loadPromise = load()
      return loadPromise
    },
    persist() {
      if (stopped) return Promise.reject(new Error(DISPOSED_MESSAGE))
      if (broken) return Promise.reject(new Error(HISTORY_BROKEN_MESSAGE))
      // 写链毒化防护:链上失败不传播到后续写入(调用方 await 本次结果感知单次失败)
      const result = chain.then(async () => {
        if (stopped) throw new Error(DISPOSED_MESSAGE)
        await fs.mkdir(dirname(file), { recursive: true })
        // mkdir 可能让出事件循环,写文件前再复查,避免 dispose 落在缝隙里
        if (stopped) throw new Error(DISPOSED_MESSAGE)
        // 临时文件 + rename:写满/中断时旧文件保持完整,不留半截 history.json
        await fs.writeFile(tempFile, JSON.stringify({ sequences }), 'utf8')
        await fs.rename(tempFile, file)
      })
      chain = result.catch(() => {})
      return result
    },
  }
}
