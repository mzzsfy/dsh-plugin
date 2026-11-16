// undo journal:definition → 首次改变前原状 { hadField, value }。
// 键为 definition 弱引用:定义仍被宿主层表持有时照常还原(含层换代后同对象
// 重建),离开注册表且无人持有的定义可被回收,记录随 sweep 释放——强引用
// Map 会把每个历史 definition(含 schema/description)钉到本行退场为止,同名
// 换对象后旧条目常驻即此因。
//
// 记录身份用 WeakMap(definition → record)保证同一定义只有一条记录,sweep
// 只清理已回收定义,不改还原语义。

const weakRefOf = (definition) => new WeakRef(definition)

/**
 * 建一个 undo journal。
 * @param {(definition: object) => { deref: () => object|undefined }} [makeRef]
 *   记录原状的引用工厂;测试注入可控 ref 以模拟已回收定义。
 */
export function createUndoJournal(makeRef = weakRefOf) {
  let byDefinition = new WeakMap()
  const records = new Set()

  return {
    /** 存活记录数(已回收定义的记录由 sweep 释放)。 */
    get size() {
      return records.size
    },

    /** 取该 definition 的原状记录(只记首次改变时的现场)。 */
    record(definition) {
      const known = byDefinition.get(definition)
      if (known !== undefined) {
        // sweep 释放后同一定义再被打标时重新纳入(幂等)
        records.add(known)
        return known
      }
      const fresh = {
        ref: makeRef(definition),
        hadField: 'deferLoading' in definition,
        value: definition.deferLoading,
      }
      byDefinition.set(definition, fresh)
      records.add(fresh)
      return fresh
    },

    /** 释放已回收定义的记录:定义已无观察者,原状无须留存。 */
    sweep() {
      for (const record of records) {
        if (record.ref.deref() === undefined) records.delete(record)
      }
    },

    /** 逐条还原并清空(行退场 / enabled=false)。 */
    restoreAll() {
      for (const record of records) {
        const definition = record.ref.deref()
        if (definition === undefined) continue
        if (record.hadField) definition.deferLoading = record.value
        else delete definition.deferLoading
      }
      records.clear()
      byDefinition = new WeakMap()
    },
  }
}
