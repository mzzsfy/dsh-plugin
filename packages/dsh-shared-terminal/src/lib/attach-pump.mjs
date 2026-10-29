const ACK = 'ack'
const WRITE = 'write'
const READ_ONLY = 'read-only'
const RELEASE_IDLE_MS = 10 * 1000
const disposedError = () => Object.assign(new Error('Terminal pump disposed'), { code: 'terminal/disposed' })
const refusalError = (refusal, epoch) => Object.assign(new Error(`terminal 写入被拒绝: ${refusal}`), { code: 'terminal/write-refused', refusal, epoch })

export class AttachPump {
  #controller
  #agent
  #id
  #ac
  #epoch = 0
  #seq = 0
  #push
  #pending = new Map()
  #reading = false
  #idleTimer
  #disposed = false

  constructor(controller, agent, id) {
    this.#controller = controller
    this.#agent = agent
    this.#id = id
  }

  #ensure() {
    if (this.#disposed) throw disposedError()
    // 即使复用 warm 附着也必须经过宿主 closed identity 校验。
    const attachment = this.#controller.terminal(this.#agent, this.#id)
    clearTimeout(this.#idleTimer)
    if (this.#reading) return
    const ac = new AbortController()
    this.#ac = ac
    this.#seq = 0
    const epoch = ++this.#epoch
    const queue = []
    let wake
    let closed = false
    const close = () => {
      closed = true
      queue.length = 0
      wake?.()
      wake = undefined
    }
    ac.signal.addEventListener('abort', close, { once: true })
    const iterator = {
      next: async () => {
        while (!closed && queue.length === 0) await new Promise((resolve) => { wake = resolve })
        return closed ? { value: undefined, done: true } : { value: queue.shift(), done: false }
      },
      return: async () => { close(); return { value: undefined, done: true } },
    }
    const input = { [Symbol.asyncIterator]: () => iterator }
    this.#push = (frame) => {
      if (closed) return
      queue.push(frame)
      wake?.()
      wake = undefined
    }
    const reader = attachment.attach(input, this.#controller.config, ac.signal)
    this.#reading = true
    void (async () => {
      try {
        for await (const frame of reader) {
          if (this.#epoch !== epoch) return
          if (frame?.type !== ACK) continue
          this.#pending.get(frame.sequence)?.(frame.refusal === undefined ? undefined : refusalError(frame.refusal, epoch))
        }
      } catch {
        // 附着结束统一交由当前世代的 pending 处理。
      } finally {
        close()
        ac.signal.removeEventListener('abort', close)
        if (this.#epoch === epoch) this.#halt(refusalError('detached', epoch))
      }
    })()
  }

  async write(text, signal) {
    signal?.throwIfAborted()
    if (this.#disposed) throw disposedError()
    try {
      return await this.#attemptWrite(text, signal)
    } catch (error) {
      signal?.throwIfAborted()
      if (this.#disposed) throw disposedError()
      if (error.refusal !== READ_ONLY && error.refusal !== 'detached') throw error
      // 并发写若已重建世代,直接挂靠新世代,禁止互杀。
      if (this.#epoch === error.epoch) this.#halt(refusalError('detached', error.epoch))
      return await this.#attemptWrite(text, signal)
    }
  }

  #attemptWrite(text, signal) {
    signal?.throwIfAborted()
    this.#ensure()
    const epoch = this.#epoch
    const sequence = ++this.#seq
    return new Promise((resolve, reject) => {
      const settle = (error) => {
        this.#pending.delete(sequence)
        signal?.removeEventListener('abort', cancel)
        error === undefined ? resolve() : reject(error)
      }
      const cancel = () => {
        settle(signal.reason)
        // 不能删除单个已编号帧:终止旧代以保持宿主连续 sequence 契约。
        if (this.#epoch === epoch) this.#halt(Object.assign(new Error('Terminal attachment cancelled; write outcome unknown'), { code: 'terminal/write-unknown' }))
      }
      this.#pending.set(sequence, settle)
      signal?.addEventListener('abort', cancel, { once: true })
      this.#push({ sequence, type: WRITE, data: text })
    }).finally(() => this.#releaseWhenIdle(epoch))
  }

  #releaseWhenIdle(epoch) {
    if (this.#epoch !== epoch || this.#pending.size > 0 || !this.#reading) return
    clearTimeout(this.#idleTimer)
    this.#idleTimer = setTimeout(() => {
      this.#idleTimer = undefined
      if (this.#epoch === epoch && this.#pending.size === 0) this.stop()
    }, RELEASE_IDLE_MS)
  }

  #halt(error) {
    clearTimeout(this.#idleTimer)
    this.#idleTimer = undefined
    ++this.#epoch
    this.#reading = false
    this.#ac?.abort()
    for (const pending of this.#pending.values()) pending(error)
    this.#pending.clear()
  }

  stop() {
    this.#halt(Object.assign(new Error('Terminal pump stopped'), { code: 'terminal/stopped' }))
  }

  dispose() {
    this.#disposed = true
    this.#halt(disposedError())
  }
}

export function createPumpFactory(controller) {
  const pumps = new Map()
  let disposed = false
  const key = (agent, id) => `${agent.id}:${id}`
  return {
    for(agent, id) {
      if (disposed) throw disposedError()
      let pump = pumps.get(key(agent, id))
      if (pump === undefined) {
        pump = new AttachPump(controller, agent, id)
        pumps.set(key(agent, id), pump)
      }
      return pump
    },
    evict(agent, id) {
      pumps.get(key(agent, id))?.dispose()
      pumps.delete(key(agent, id))
    },
    dispose() {
      disposed = true
      for (const pump of pumps.values()) pump.dispose()
      pumps.clear()
    },
  }
}
