// 0.2.1-rc.2 attach 泵:自持附着写通道,命令帧 sequence 按附着世代严格递增,ack 按 sequence 匹配
const ACK = 'ack'
const WRITE = 'write'
const READ_ONLY = 'read-only'

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

  constructor(controller, agent, id) {
    this.#controller = controller
    this.#agent = agent
    this.#id = id
  }

  #ensure() {
    if (this.#reading) return
    this.#ac = new AbortController()
    this.#seq = 0
    const epoch = ++this.#epoch
    // 队列与唤醒按世代局部化:旧附着残留帧随旧队列一并作废,不污染新附着
    const queue = []
    let wake
    const input = {
      [Symbol.asyncIterator]: () => ({
        next: async () => {
          while (queue.length === 0) {
            if (this.#ac.signal.aborted) return { value: undefined, done: true }
            await new Promise((resolve) => { wake = resolve })
          }
          return { value: queue.shift(), done: false }
        },
        return: async () => ({ value: undefined, done: true })
      })
    }
    this.#push = (frame) => {
      queue.push(frame)
      wake?.()
      wake = undefined
    }
    const attachment = this.#controller.terminal(this.#agent, this.#id)
    const reader = attachment.attach(input, this.#controller.config, this.#ac.signal)
    this.#reading = true
    void (async () => {
      try {
        for await (const frame of reader) {
          // 旧附着的迟到帧不得命中新附着的同号 pending
          if (this.#epoch !== epoch) return
          if (frame?.type !== ACK) continue
          const pending = this.#pending.get(frame.sequence)
          this.#pending.delete(frame.sequence)
          pending?.(frame)
        }
      } catch {
        // 附着取消或终端消失:静默结束,后续 write 由调用方错误路径处理
      } finally {
        // 仅清理属于本次附着的 pending;重抢后的新附着 pending 不受旧循环退出影响
        if (this.#epoch === epoch) {
          this.#reading = false
          for (const pending of this.#pending.values()) {
            pending({ type: ACK, sequence: -1, refusal: 'detached' })
          }
          this.#pending.clear()
        }
      }
    })()
  }

  async write(text) {
    try {
      return await this.#attemptWrite(text)
    } catch (error) {
      // 控制权被接管或附着流断:重抢一次,sequence 随新附着重置
      if (error.refusal !== READ_ONLY && error.refusal !== 'detached') throw error
      // 并发下被拒世代可能已被其他 write 重建,此时直接挂靠活世代,禁止互杀
      if (this.#epoch === error.epoch) this.stop()
      return await this.#attemptWrite(text)
    }
  }

  #attemptWrite(text) {
    this.#ensure()
    const epoch = this.#epoch
    const sequence = ++this.#seq
    return new Promise((resolve, reject) => {
      this.#pending.set(sequence, (frame) => {
        if (frame.refusal !== undefined) {
          reject(Object.assign(new Error(`terminal 写入被拒绝: ${frame.refusal}`), { code: 'terminal/write-refused', refusal: frame.refusal, epoch }))
        } else {
          resolve()
        }
      })
      this.#push({ sequence, type: WRITE, data: text })
    }).finally(() => this.#releaseWhenIdle(epoch))
  }

  // 空闲即释放附着:宿主 detach 会广播 state,UI 恢复 writable 触发官方 fit 重算几何
  // 持续附着会让 UI 长期只读,官方 fit 不跑,插件写入推高的 PTY 行数把底部推出可视区
  #releaseWhenIdle(epoch) {
    if (this.#epoch !== epoch || this.#pending.size > 0) return
    this.stop()
  }

  stop() {
    this.#ac?.abort()
    this.#reading = false
  }
}

export function createPumpFactory(controller) {
  const pumps = new Map()
  const key = (agent, id) => `${agent.id}:${id}`
  return {
    for(agent, id) {
      let pump = pumps.get(key(agent, id))
      if (pump === undefined) {
        pump = new AttachPump(controller, agent, id)
        pumps.set(key(agent, id), pump)
      }
      return pump
    },
    // 终端关闭后实例销毁,泵随行驱逐
    evict(agent, id) {
      pumps.get(key(agent, id))?.stop()
      pumps.delete(key(agent, id))
    },
    dispose() {
      for (const pump of pumps.values()) pump.stop()
      pumps.clear()
    }
  }
}
