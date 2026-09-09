// 存档读取适配层:宿主 sessionPersistence 服务 API 按代演化(inspect 一次
// 整读 → open(read) 句柄式分片),本层把各代形状折叠为内部统一契约,collector
// 只面向契约编程,宿主再变只增适配器。旧格式会话存档文件(v0 起)由宿主
// 迁移链在读路径统一转换为当前事件词汇,适配层与文件格式代际解耦。
// 分页读与 close 吞错语义对齐竞品 dsh-usage-statistics-panel 0.1.12 的
// backfill 双路径实现;V3 专有事件由折叠层默认忽略,测试钉住。
//
// 统一契约(ArchiveReader):
//   list(signal)             → Promise<readonly { id }[]>            枚举全部已存会话
//   readLog(id, signal)      → Promise<{ inheritedEventCount, events }> 整读单会话全部事件

import { listSessionIdsDirect, readSessionLogDirect } from './direct-log-reader.js'

const READER_HINT = 'sessionPersistence API 未识别(宿主再次升级?),请反馈补充适配器'
const HANDLE_READ_PAGE = 500

// 宿主 fail-closed 拒读的原因词型:descriptor 元数据校验、格式代际校验、
// seq 完整性校验。命中即降级文件直读(档案数据本身完好,只是校验不放行);
// 词型必须精确,任意读失败(网络/权限/不存在)不得误判
const HOST_REFUSAL_PATTERN = /unsupported descriptor version|stored log is corrupt|SessionFormatError|format v\d|unexpected member|seq gap/i

function isHostRefusal(error) {
  return HOST_REFUSAL_PATTERN.test(error instanceof Error ? error.message : String(error))
}

// 现役宿主:list 返回 snapshot(id 在 .header),整读走 read 句柄分页循环。
// 信号包裹为 options 对象;read 失败仍保证 close。close 失败吞掉:句柄
// 关闭失败不代表已读数据无效,数据可用性优先。有意不附加
// interruptedTurnClosers:crash 中断的 turn 不计 turn/end,与两代既有
// 统计口径一致,不为统计引入宿主模块依赖。
class HandleArchiveReader {
  constructor(persistence) {
    this.persistence = persistence
  }

  async list(signal) {
    const snapshots = await this.persistence.list(signal === undefined ? undefined : { signal })
    // 畸形行(无有效 header.id)丢弃不炸,单个坏行不放大为整轮失败;
    // 宿主 list 不枚举的磁盘档案(旧宿主不见新代文件名)由直读侧补齐
    const ids = new Set(
      snapshots
        .filter((snapshot) => typeof snapshot?.header?.id === 'string' && snapshot.header.id !== '')
        .map((snapshot) => snapshot.header.id),
    )
    for (const id of listSessionIdsDirect()) ids.add(id)
    return [...ids].map((id) => ({ id }))
  }

  async readLog(id, signal) {
    const options = signal === undefined ? undefined : { signal }
    // descriptor 元数据校验在 open 阶段拒读,open 必须同在降级范围内
    let handle
    try {
      handle = await this.persistence.open(id, 'read', options)
      const inherited = handle.inheritedEventCount
      const inheritedEventCount = typeof inherited === 'number' && Number.isSafeInteger(inherited) && inherited >= 0 ? inherited : 0
      const events = []
      let offset = 0
      for (;;) {
        if (signal?.aborted) return { inheritedEventCount, events }
        const slice = await handle.read(offset, HANDLE_READ_PAGE, options)
        const page = slice?.events ?? []
        if (page.length === 0) break
        for (const event of page) events.push(event)
        offset += page.length
      }
      return { inheritedEventCount, events }
    } catch (error) {
      // 宿主校验拒读而档案数据完好:降级文件直读恢复统计;直读失败
      // (档案缺失等)回抛原拒读错误,降级是尽力而为,不掩盖原状态
      if (isHostRefusal(error)) {
        try {
          return { inheritedEventCount: 0, events: readSessionLogDirect(id) }
        } catch {
          throw error
        }
      }
      throw error
    } finally {
      await handle?.close().catch(() => {})
    }
  }
}

// 旧代宿主:list 直接返回 header 数组,inspect 一次整读;两处 signal 均直传。
class InspectArchiveReader {
  constructor(persistence) {
    this.persistence = persistence
  }

  async list(signal) {
    const headers = await this.persistence.list(signal)
    const ids = new Set(
      headers
        .filter((header) => typeof header?.id === 'string' && header.id !== '')
        .map((header) => header.id),
    )
    for (const id of listSessionIdsDirect()) ids.add(id)
    return [...ids].map((id) => ({ id }))
  }

  async readLog(id, signal) {
    try {
      const inspection = await this.persistence.inspect(id, signal)
      const inherited = inspection.inheritedEventCount
      const inheritedEventCount = typeof inherited === 'number' && Number.isSafeInteger(inherited) && inherited >= 0 ? inherited : 0
      return { inheritedEventCount, events: inspection.events ?? [] }
    } catch (error) {
      // 宿主校验拒读而档案数据完好:降级文件直读恢复统计;直读失败回抛原错
      if (isHostRefusal(error)) {
        try {
          return { inheritedEventCount: 0, events: readSessionLogDirect(id) }
        } catch {
          throw error
        }
      }
      throw error
    }
  }
}

// 形状都不匹配:恒抛错,失败经回扫入口与启动兜底日志可见,提示补新适配器。
class UnknownArchiveReader {
  async list() {
    throw new Error(READER_HINT)
  }

  async readLog() {
    throw new Error(READER_HINT)
  }
}

// 特性检测分派:能力优先于版本号探测。
export function createArchiveReader(persistence) {
  if (typeof persistence?.open === 'function') return new HandleArchiveReader(persistence)
  if (typeof persistence?.inspect === 'function') return new InspectArchiveReader(persistence)
  return new UnknownArchiveReader()
}
