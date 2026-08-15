const { EventEmitter } = require('events')
const actions = require('./actions')
const observations = require('./observations')

class SkillExecutor extends EventEmitter {
  constructor (bot, opts = {}) {
    super()
    this.bot = bot
    this.pathfinderOwner = opts.pathfinderOwner || null
    this.skillTimeoutMs = opts.skillTimeoutMs ?? 120000
    this.resumeDebounceMs = opts.resumeDebounceMs ?? 1000
    this.resumeGateTimeoutMs = opts.resumeGateTimeoutMs ?? 30000
    this.queue = []
    this.currentCall = null
    this.paused = false
    this._runPromise = null
    this._running = false
    this._abortRequested = false
  }

  get busy () {
    return this._running || this.queue.length > 0 || this.currentCall !== null
  }

  enqueue (calls) {
    const list = Array.isArray(calls) ? calls : [calls]
    if (list.length === 0) return
    for (const call of list) {
      this.queue.push({ name: call.name, args: call.args || {}, _state: {} })
    }
    this.emit('queue:enqueue', { count: list.length, queueLength: this.queue.length })
    this.start()
  }

  clear () {
    this.queue.length = 0
    this.emit('queue:clear', {})
  }

  requestCurrentSkillAbort (reason = 'external abort') {
    this._abortRequested = true
    this.emit('skill:abort-requested', { reason })
    return { ok: true }
  }

  start () {
    if (this._running) return this._runPromise
    this._running = true
    this._runPromise = this._run().finally(() => {
      this._running = false
      this.currentCall = null
    })
    return this._runPromise
  }

  async _run () {
    while (this.queue.length > 0) {
      const call = this.queue[0]
      this.currentCall = call
      const controller = new AbortController()
      this.pathfinderOwner?.bindSkillSignal(controller)
      this.emit('skill:start', { call, queueLeft: this.queue.length - 1 })

      let result
      try {
        result = await this._withTimeout(
          actions.executeStructured(this.bot, call, { signal: controller.signal }),
          this.skillTimeoutMs,
          controller
        )
      } catch (err) {
        result = { ok: false, reason: `skill threw: ${err.message || err}`, state: observations.build(this.bot) }
      } finally {
        this.pathfinderOwner?.unbindSkillSignal()
      }

      if (result && result.preempted) {
        this.emit('skill:preempted', { call, result })
        const resumed = await this._waitForResume()
        if (!resumed) {
          this.emit('queue:failure', { call, result: { ok: false, reason: 'resume gate timeout after reactive preempt' } })
          this.queue.length = 0
          break
        }
        continue
      }

      this.queue.shift()
      this.currentCall = null
      this.emit('skill:result', { call, result })
      if (!result.ok) {
        this.emit('queue:failure', { call, result })
        this.queue.length = 0
        break
      }
    }

    if (this.queue.length === 0 && !this.currentCall) this.emit('queue:empty', {})
  }

  async _withTimeout (promise, timeoutMs, controller) {
    let timer
    const timeout = new Promise(resolve => {
      timer = setTimeout(() => {
        controller.abort('skill timed out')
        resolve({ ok: false, reason: 'skill timed out', state: observations.build(this.bot) })
      }, timeoutMs)
    })
    try {
      return await Promise.race([promise, timeout])
    } finally {
      clearTimeout(timer)
    }
  }

  async _waitForResume () {
    const start = Date.now()
    while (true) {
      const owner = this.pathfinderOwner
      const ownerIdle = owner ? owner.isIdle() : true
      const releasedAt = owner ? (owner.lastReleasedAt || 0) : Date.now()
      if (!this.paused && ownerIdle && Date.now() - releasedAt >= this.resumeDebounceMs) return true
      if (Date.now() - start > this.resumeGateTimeoutMs) return false
      await new Promise(resolve => setTimeout(resolve, 50))
    }
  }
}

module.exports = SkillExecutor