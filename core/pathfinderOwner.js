// PathfinderOwner: all pathfinder writes go through here.
// Reactive always outranks skills. Skills acquire a token; if reactive holds it,
// acquire('skill') returns null and the action reports preempted.
class PathfinderOwner {
  constructor (bot) {
    this.bot = bot
    this._owner = null
    this._reason = null
    this._token = null
    this._skillController = null
    this._goalActive = false
    this._idleSince = Date.now()
    this.lastReleasedAt = 0

    this._bindBotEvent('goal_reached', () => this._markIdle('goal_reached'))
    this._bindBotEvent('path_update', (r) => {
      if (r && (r.status === 'noPath' || r.status === 'timeout')) this._markIdle('path_' + r.status)
    })
    this._bindBotEvent('path_stop', () => this._markIdle('path_stop'))
    this._bindBotEvent('goal_updated', () => {})
  }

  _bindBotEvent (eventName, listener) {
    try {
      this.bot.on(eventName, listener)
      return true
    } catch {
      return false
    }
  }

  _markIdle (why) {
    if (!this._goalActive) return
    this._goalActive = false
    this._idleSince = Date.now()
    this.bot.emit('pathfinderOwner:idle', { why })
  }

  bindSkillSignal (controller) {
    this._skillController = controller
  }

  unbindSkillSignal () {
    this._skillController = null
  }

  acquire (owner, { reason } = {}) {
    if (owner === 'reactive') {
      if (this._owner === 'reactive') return this._grantHandle()
      if (this._owner === 'skill') {
        if (this._skillController && !this._skillController.signal.aborted) {
          try { this._skillController.abort('reactive-preempt') } catch {}
        }
        this._stopPathfinder('preempt-stop')
        this.bot.emit('pathfinderOwner:preempted', reason || 'reactive')
      } else {
        this.bot.emit('pathfinderOwner:preempted', reason || 'reactive')
      }
      this._owner = 'reactive'
      this._reason = reason || 'reactive'
      this._token = { kind: 'reactive' }
      return this._grantHandle()
    }

    if (owner === 'skill') {
      if (this._owner === 'reactive') return null
      this._owner = 'skill'
      this._reason = reason || 'skill'
      this._token = { kind: 'skill' }
      return this._grantHandle()
    }

    throw new Error(`PathfinderOwner.acquire: invalid owner "${owner}"`)
  }

  _grantHandle () {
    const myToken = this._token
    return {
      token: myToken,
      signal: this._owner === 'skill' ? (this._skillController?.signal || null) : null,
      release: () => this._release(myToken)
    }
  }

  _release (token) {
    if (this._token !== token) return
    const wasOwner = this._owner
    const wasReason = this._reason
    this._owner = null
    this._reason = null
    this._token = null
    if (wasOwner === 'reactive') {
      this.lastReleasedAt = Date.now()
      this.bot.emit('pathfinderOwner:released', wasReason)
    }
  }

  setGoal (token, goal, { movements, dynamic = false } = {}) {
    if (this._token !== token) {
      this.bot.emit('pathfinderOwner:badToken', { currentOwner: this._owner, callerKind: token?.kind })
      return false
    }
    try {
      if (movements) this.bot.pathfinder.setMovements(movements)
      this.bot.pathfinder.setGoal(goal, dynamic === true)
      this._goalActive = true
      this._idleSince = 0
      return true
    } catch {
      return false
    }
  }

  stop (token) {
    if (this._token !== token) return false
    return this._stopPathfinder('owner-stop')
  }

  _stopPathfinder (idleReason) {
    try {
      this.bot.pathfinder.stop()
    } catch {
      return false
    }
    this._markIdle(idleReason)
    return true
  }

  isIdle () {
    return !this._goalActive
  }

  async waitForIdle (debounceMs, timeoutMs = 30000) {
    const start = Date.now()
    while (true) {
      if (this.isIdle() && Date.now() - this._idleSince >= debounceMs) return true
      if (Date.now() - start > timeoutMs) return false
      await new Promise(resolve => setTimeout(resolve, 50))
    }
  }

  currentOwner () {
    return this._owner
  }
}

module.exports = PathfinderOwner