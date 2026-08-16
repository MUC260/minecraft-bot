const fs = require('fs')
const path = require('path')

const DEFAULT_MAX_MESSAGES = 40
const DEFAULT_MAX_CHARS = 32000

function emptyData (file) {
  return {
    version: 1,
    file,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    goal: '',
    plan: null,
    history: [],
    facts: {},
    stats: {
      goalsSet: 0,
      actionsRun: 0,
      actionsOk: 0,
      actionsFailed: 0,
      lastActionResult: null,
      lastPosition: null,
      lastInventory: null
    }
  }
}

class BrainMemory {
  constructor (file, options = {}) {
    this.file = file ? path.resolve(String(file)) : null
    this.maxMessages = Math.max(1, Number(options.maxMessages || DEFAULT_MAX_MESSAGES))
    this.maxChars = Math.max(1000, Number(options.maxChars || DEFAULT_MAX_CHARS))
    this.dirty = false
    this._saveTimer = null
    this.data = emptyData(this.file)
    this._load()
  }

  _load () {
    if (!this.file || !fs.existsSync(this.file)) return
    try {
      const raw = fs.readFileSync(this.file, 'utf8').replace(/^\uFEFF/, '')
      const parsed = JSON.parse(raw)
      if (!parsed || typeof parsed !== 'object') return
      this.data = { ...emptyData(this.file), ...parsed }
      this.data.file = this.file
      this.data.version = 1
      if (!Array.isArray(this.data.history)) this.data.history = []
      if (!this.data.stats || typeof this.data.stats !== 'object') this.data.stats = emptyData(this.file).stats
      if (!this.data.facts || typeof this.data.facts !== 'object') this.data.facts = {}
      this._trim()
    } catch (err) {
      // A corrupted memory file should never take down the bot.
      this.data = emptyData(this.file)
      this.data.facts.loadError = String(err.message || err)
    }
  }

  _trim () {
    while (this.data.history.length > this.maxMessages) this.data.history.shift()
    let chars = this.data.history.reduce((sum, m) => sum + (m && m.content ? m.content.length : 0), 0)
    while (chars > this.maxChars && this.data.history.length > 1) {
      const removed = this.data.history.shift()
      chars -= removed && removed.content ? removed.content.length : 0
    }
  }

  save () {
    if (!this.file) return false
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      const tmp = this.file + '.tmp'
      this.data.updatedAt = Date.now()
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2) + '\n', 'utf8')
      fs.renameSync(tmp, this.file)
      this.dirty = false
      return true
    } catch {
      return false
    }
  }

  scheduleSave (ms = 800) {
    this.dirty = true
    if (!this.file) return
    if (this._saveTimer) clearTimeout(this._saveTimer)
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null
      if (this.dirty) this.save()
    }, ms)
    this._saveTimer.unref && this._saveTimer.unref()
  }

  recordMessage (role, content) {
    const text = String(content || '').trim()
    if (!text) return
    this.data.history.push({ role, content: text.slice(0, 3000), at: Date.now() })
    this._trim()
    this.scheduleSave()
  }

  recordActionResult (name, ok, reason) {
    const stats = this.data.stats
    stats.actionsRun++
    if (ok) stats.actionsOk++
    else stats.actionsFailed++
    stats.lastActionResult = {
      name: String(name || ''),
      ok: !!ok,
      reason: String(reason || ''),
      at: Date.now()
    }
    this.scheduleSave()
  }

  learn (key, value) {
    const k = String(key || '').trim()
    if (!k) return
    this.data.facts[k] = value
    this.scheduleSave()
  }

  setGoal (goal, plan) {
    this.data.goal = String(goal || '')
    this.data.plan = plan || null
    if (this.data.goal) this.data.stats.goalsSet++
    this.scheduleSave()
  }

  setPlan (plan) {
    this.data.plan = plan || null
    this.scheduleSave()
  }

  setPosition (pos) {
    if (!pos) return
    this.data.stats.lastPosition = pos
    this.scheduleSave()
  }

  setInventory (items) {
    this.data.stats.lastInventory = items
    this.scheduleSave()
  }

  snapshot () {
    this._trim()
    return {
      file: this.file,
      goal: this.data.goal,
      plan: this.data.plan,
      historyCount: this.data.history.length,
      facts: this.data.facts,
      stats: this.data.stats,
      updatedAt: this.data.updatedAt
    }
  }

  reset () {
    const file = this.file
    this.data = emptyData(file)
    this.dirty = true
    this.scheduleSave(0)
    return this.snapshot()
  }

  destroy () {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer)
      this._saveTimer = null
    }
    if (this.dirty) this.save()
  }
}

module.exports = BrainMemory
