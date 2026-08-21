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
    this.currentStartedAt = 0
    this.currentController = null
    this._watchdogTimer = setInterval(() => this._watchdog(), Math.min(5000, this.skillTimeoutMs || 5000))
    this._watchdogTimer.unref?.()
  }

  _watchdog () {
    if (!this.currentCall || !this.currentController) return
    const elapsed = Date.now() - this.currentStartedAt
    const limit = Number(this.currentCall?.timeoutMs) > 0 ? Number(this.currentCall.timeoutMs) : (this.skillTimeoutMs || 120000)
    if (elapsed <= limit + 10000) return
    this.emit('skill:stuck', { call: this.currentCall, elapsedMs: elapsed })
    try { this.currentController.abort('executor-watchdog') } catch {}
  }

  destroy () {
    if (this._watchdogTimer) clearInterval(this._watchdogTimer)
    this._watchdogTimer = null
  }

  get busy () {
    return this._running || this.queue.length > 0 || this.currentCall !== null
  }

  enqueue (calls) {
    const list = Array.isArray(calls) ? calls : [calls]
    if (list.length === 0) return
    for (const call of list) {
      this.queue.push({
        name: call.name,
        args: call.args || {},
        timeoutMs: call.timeoutMs || call.args?.timeoutMs || undefined,
        announce: call.announce === true,
        requester: call.requester || null,
        _state: {}
      })
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
    if (this.currentController) {
      try { this.currentController.abort(reason) } catch {}
    }
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
      this.currentStartedAt = Date.now()
      const controller = new AbortController()
      this.currentController = controller
      this.pathfinderOwner?.bindSkillSignal(controller)
      this.emit('skill:start', { call, queueLeft: this.queue.length - 1 })

      let result
      try {
        result = await this._withTimeout(
          actions.executeStructured(this.bot, call, { signal: controller.signal }),
          Number(call.timeoutMs) > 0 ? Number(call.timeoutMs) : this.skillTimeoutMs,
          controller
        )
      } catch (err) {
        result = { ok: false, reason: `skill threw: ${err.message || err}`, state: this._safeState() }
      } finally {
        this.pathfinderOwner?.unbindSkillSignal()
        this.currentController = null
        this.currentStartedAt = 0
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

  _safeState () {
    try {
      return observations.build(this.bot, this.bot && this.bot.chatBuffer ? this.bot.chatBuffer : [])
    } catch {
      return { connected: false, bot: null, players: [], entities: [], nearbyHostiles: [], nearbyDrops: [], chat: [], inventory: null }
    }
  }

  async _withTimeout (promise, timeoutMs, controller) {
    let timer
    let timedOut = false
    const timeout = new Promise(resolve => {
      timer = setTimeout(() => {
        timedOut = true
        controller.abort('skill timed out')
        resolve({ ok: false, reason: 'skill timed out', state: this._safeState() })
      }, timeoutMs)
    })
    try {
      const result = await Promise.race([promise, timeout])
      if (timedOut) {
        // Let the aborted bot action settle briefly so the next skill does not
        // interleave with a still-running craft/dig/pathfinder operation.
        await Promise.race([
          Promise.resolve(promise).catch(() => {}),
          new Promise(resolve => setTimeout(resolve, 750))
        ])
      }
      return result
    } finally {
      clearTimeout(timer)
    }
  }

  async _waitForResume () {
    const start = Date.now()
    const debounce = Math.max(50, Number(this.resumeDebounceMs) || 1000)
    const gate = Math.max(1000, Number(this.resumeGateTimeoutMs) || 30000)
    while (true) {
      const owner = this.pathfinderOwner
      if (!owner) return true
      // Reactive still owns the pathfinder: wait for it to release instead of
      // spinning the same preempted skill every event-loop turn.
      if (owner.currentOwner() === 'reactive') {
        if (Date.now() - start > gate) return false
        await new Promise(resolve => setTimeout(resolve, 50))
        continue
      }
      const releasedAt = Number(owner.lastReleasedAt) || 0
      if (!this.paused && owner.isIdle() && releasedAt > 0 && Date.now() - releasedAt >= debounce) return true
      if (Date.now() - start > gate) return false
      await new Promise(resolve => setTimeout(resolve, 50))
    }
  }
}

module.exports = SkillExecutor