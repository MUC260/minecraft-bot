const fs = require('fs')
const path = require('path')
const logger = require('../lib/logger')
const { chatCompletion, parseActions } = require('./provider')
const { TOOLS, TOOL_NAMES } = require('./tools')
const BrainMemory = require('./memory')

const MAX_HISTORY_MESSAGES = 24
const MAX_HISTORY_CHARS = 16000
const SURVIVAL_COOLDOWN_MS = 4000
const TERMINAL_BUILD_STEPS = new Set(['buildHouse', 'buildTower', 'buildBridge', 'buildWall', 'buildShelter'])

class Brain {
  constructor (agent, config) {
    this.agent = agent
    this.config = config || {}
    this.executor = agent.executor
    this.running = false
    this.timer = null
    this.ticking = false
    this.lastError = null
    this.goal = '自由行动：观察环境，合理互动。'
    this.lastPlan = []
    this.lastResults = []
    this._lastPlanKey = ''
    this._repeatStreak = 0
    this._forceVary = false
    this.holdPosition = false
    this.followTarget = null
    this.aiErrorStreak = 0
    this.aiBackoffMs = 0
    this._offlineStep = 0
    this._lastSurvivalEatAt = 0
    this._lastSurvivalArmorAt = 0
    this._lastSurvivalAttackAt = 0
    this.history = []
    this._pendingAssistant = null
    this._followRetryTimer = null
    this.plan = this._emptyPlan(this.goal)
    this._completionReported = false
    this._completionReportedAt = 0
    this.systemPrompt = this._loadPrompt()
    this.memory = new BrainMemory(this.config.memoryFile || null, {
      maxMessages: this.config.memoryMaxMessages || MAX_HISTORY_MESSAGES,
      maxChars: this.config.memoryMaxChars || MAX_HISTORY_CHARS
    })
    this._restoreMemory()

    // A fresh process start should not re-announce a stale completed/failed plan
    // restored from disk; resume in free-play mode instead.
    if (this.plan && (this.plan.status === 'complete' || this.plan.status === 'failed')) {
      this.goal = '\u81ea\u7531\u884c\u52a8\uff1a\u89c2\u5bdf\u73af\u5883\uff0c\u5408\u7406\u4e92\u52a8\u3002'
      this.plan = this._emptyPlan(this.goal)
      this._completionReported = true
      this._lastPlanKey = ''
      this._repeatStreak = 0
      this._forceVary = false
      if (this.memory) this.memory.setGoal(this.goal, this.plan)
    }

    this._onQueueEmpty = () => {
      this._recordBatchEnd()
      this._kick(150)
    }
    this._onQueueFailure = ({ call, result }) => {
      this._recordBatchEnd()
      if (call && call.name === 'follow' && this.followTarget && !this.holdPosition) {
        this._scheduleRefollow(2000)
      }
      this._kick(300)
    }
    this._onSkillResult = ({ call, result }) => {
      this.recordResult(call && call.name, result)
      this._recordToolResult(call, result)
      this._advancePlan(call, result)
      if (call && call.name === 'follow' && this.followTarget && !this.holdPosition) {
        this._scheduleRefollow(1500)
      }
    }

    if (this.executor) this._bindExecutor(this.executor)
  }

  _bindExecutor (executor) {
    executor.on('queue:empty', this._onQueueEmpty)
    executor.on('queue:failure', this._onQueueFailure)
    executor.on('skill:result', this._onSkillResult)
  }

  _unbindExecutor (executor) {
    executor.removeListener('queue:empty', this._onQueueEmpty)
    executor.removeListener('queue:failure', this._onQueueFailure)
    executor.removeListener('skill:result', this._onSkillResult)
  }

  setExecutor (executor) {
    if (this.executor === executor) return this.executor
    if (this.executor) this._unbindExecutor(this.executor)
    this.executor = executor
    if (executor) {
      this._bindExecutor(executor)
      if (this.followTarget && !this.holdPosition) this._scheduleRefollow(500)
    }
    return this.executor
  }

  _loadPrompt () {
    try {
      return fs.readFileSync(path.join(__dirname, 'prompts', 'system.md'), 'utf8')
    } catch {
      return 'You control a Minecraft character. Respond with function calls or chat.'
    }
  }

  getMemory () {
    return this.memory ? this.memory.snapshot() : null
  }

  resetMemory () {
    if (!this.memory) return null
    this.history = []
    this.plan = this._emptyPlan(this.goal)
    return this.memory.reset()
  }

  _restoreMemory () {
    const mem = this.memory && this.memory.data
    if (!mem) return
    if (Array.isArray(mem.history) && mem.history.length) {
      this.history = mem.history.slice(-MAX_HISTORY_MESSAGES)
      this._trimHistory()
    }
    if (mem.goal && mem.goal !== this.goal) {
      this.goal = mem.goal
      this.plan = (mem.plan && Array.isArray(mem.plan.steps)) ? mem.plan : this._buildPlan(mem.goal)
    } else if (mem.plan && Array.isArray(mem.plan.steps)) {
      this.plan = mem.plan
    }
    if (this.plan && this.plan.goal !== this.goal) this.plan.goal = this.goal
    if (this.plan && !this.plan.updatedAt) this.plan.updatedAt = Date.now()
  }

  _persistSnapshot (snapshot) {
    if (!this.memory || !snapshot) return
    const bot = snapshot.bot || {}
    if (bot.x !== undefined || bot.z !== undefined) {
      this.memory.setPosition({
        x: bot.x,
        y: bot.y,
        z: bot.z,
        dimension: bot.dimension || 'overworld'
      })
    }
    const inv = snapshot.inventory
    if (inv && Array.isArray(inv.items)) {
      this.memory.setInventory(inv.items.slice(0, 120).map(i => ({
        name: i && i.name,
        count: i && i.count
      })))
    }
  }

  _emptyPlan (goal) {
    return {
      goal: String(goal || ''),
      steps: [],
      activeStep: 0,
      status: 'idle',
      loop: false,
      note: '',
      updatedAt: Date.now()
    }
  }

  setGoal (goal) {
    const text = String(goal || '').trim()
    if (!text) return this.goal
    const changed = text !== this.goal
    this.goal = text
    if (changed) {
      this._lastPlanKey = ''
      this._repeatStreak = 0
      this._forceVary = false
      this._pendingAssistant = null
      this._completionReported = false
      this.plan = this.config.planAhead === false ? this._emptyPlan(text) : this._buildPlan(text)
      this._pushHistory('user', '【主人新任务】' + text)
      this._pushHistory('user', '【任务拆解】' + JSON.stringify(this.plan))
      if (this.memory) this.memory.setGoal(this.goal, this.plan)
      this.agent.emit('aiPlan', { plan: this.plan, at: Date.now() })
    }
    return this.goal
  }
  setAiGoal (goal) {
    return this.setGoal(goal)
  }

  setAiPlan (todos) {
    const steps = this._normalizeAiTodos(todos)
    this.plan = {
      goal: this.goal,
      steps,
      activeStep: 0,
      status: steps.length ? 'running' : 'idle',
      loop: false,
      note: 'AI 制定计划',
      updatedAt: Date.now()
    }
    this._lastPlanKey = ''
    this._repeatStreak = 0
    this._forceVary = false
    this._pendingAssistant = null
    this._completionReported = false
    this._pushHistory('user', '【AI 计划】' + JSON.stringify(this.plan))
    if (this.memory) this.memory.setGoal(this.goal, this.plan)
    this.agent.emit('aiPlan', { plan: this.plan, at: Date.now() })
    return steps
  }

  _normalizeAiTodos (todos) {
    const list = Array.isArray(todos) ? todos : []
    const steps = []
    for (const t of list) {
      if (!t) continue
      if (typeof t === 'string') {
        steps.push({ name: this._inferStepName(t), args: {}, note: t, done: false })
        continue
      }
      if (typeof t !== 'object') continue
      steps.push({
        name: String(t.name || this._inferStepName(t.note) || 'explore'),
        args: t.args && typeof t.args === 'object' ? t.args : {},
        note: String(t.note || t.name || '步骤'),
        done: !!t.done
      })
    }
    return steps
  }

  _inferStepName (note) {
    const g = String(note || '').toLowerCase()
    const map = [
      [/木|房|屋|建造|build|house|tower|bridge|wall|shelter/, 'buildHouse'],
      [/挖|矿|铁|金|钻石|mine|ore|iron|gold|diamond/, 'mineOreVein'],
      [/砍|树|chop|tree|log|wood/, 'chopTree'],
      [/捡|拾|收集|collect|pickup|drop/, 'collect'],
      [/跟随|跟|follow/, 'follow'],
      [/保护|守卫|protect|guard|defend/, 'protect'],
      [/探|explore/, 'explore']
    ]
    for (const [re, name] of map) {
      if (re.test(g)) return name
    }
    return 'explore'
  }

  pauseAiGoal () {
    this.holdPosition = true
    this.followTarget = null
    this._clearFollowRetry()
    if (this.plan && this.plan.status === 'running') this.plan.status = 'paused'
    if (this.plan) this.plan.updatedAt = Date.now()
    if (this.memory && this.plan) this.memory.setPlan(this.plan)
    if (this.plan) this.agent.emit('aiPlan', { plan: this.plan, at: Date.now() })
  }

  resumeAiGoal () {
    this.holdPosition = false
    if (this.plan && this.plan.status === 'paused') this.plan.status = 'running'
    if (this.plan) this.plan.updatedAt = Date.now()
    if (this.memory && this.plan) this.memory.setPlan(this.plan)
    if (this.plan) this.agent.emit('aiPlan', { plan: this.plan, at: Date.now() })
  }

  cancelAiGoal () {
    this.holdPosition = false
    this.followTarget = null
    this._clearFollowRetry()
    this.goal = '自由行动：观察环境，合理互动。'
    this.plan = this._emptyPlan(this.goal)
    this._lastPlanKey = ''
    this._repeatStreak = 0
    this._forceVary = false
    this._pendingAssistant = null
    this._pushHistory('user', '【任务取消】回到自由行动')
    if (this.memory) this.memory.setGoal(this.goal, this.plan)
    this.agent.emit('aiPlan', { plan: this.plan, at: Date.now() })
  }


  setHold (hold = true) {
    this.holdPosition = !!hold
    if (hold) {
      this.followTarget = null
      this._clearFollowRetry()
    }
    if (hold && this.plan.status === 'running') this.plan.status = 'paused'
    return this.holdPosition
  }

  alignPlanToAction (action) {
    const plan = this.plan
    if (!plan || !Array.isArray(plan.steps) || !action || !action.name) return false
    const idx = plan.steps.findIndex(step => step && step.name === action.name)
    if (idx < 0) return false
    for (let i = 0; i < idx; i++) {
      const step = plan.steps[i]
      if (!step) continue
      if (!step.done) {
        step.done = true
        step.note = (step.note || '') + '（主人直接指定动作，自动跳过）'
      }
    }
    plan.activeStep = idx
    plan.status = 'running'
    plan.updatedAt = Date.now()
    if (this.memory) this.memory.setPlan(plan)
    this.agent.emit('aiPlan', { plan, at: Date.now() })
    return true
  }

  setFollow (username, distance = 2) {
    const name = String(username || '').trim()
    if (!name) {
      this.followTarget = null
      this.holdPosition = false
      return null
    }
    this.followTarget = { username: name, distance: Math.max(1, Math.min(8, Number(distance) || 2)) }
    this.holdPosition = false
    this._clearFollowRetry()
    return this.followTarget
  }

  clearFollow () {
    this.followTarget = null
    this._clearFollowRetry()
  }

  _clearFollowRetry () {
    if (this._followRetryTimer) {
      clearTimeout(this._followRetryTimer)
      this._followRetryTimer = null
    }
  }

  _scheduleRefollow (ms = 1500) {
    if (this._followRetryTimer) return
    this._followRetryTimer = setTimeout(() => {
      this._followRetryTimer = null
      this._reFollow()
    }, ms)
  }

  _reFollow () {
    if (!this.followTarget || this.holdPosition || !this.executor) return
    const alreadyQueued = this.executor.currentCall?.name === 'follow' ||
      (Array.isArray(this.executor.queue) && this.executor.queue.some(call => call && call.name === 'follow'))
    if (alreadyQueued) return
    const call = { name: 'follow', args: { username: this.followTarget.username, distance: this.followTarget.distance }, timeoutMs: 86400000 }
    this.executor.enqueue(call)
  }

  start () {
    if (this.running) return
    this.running = true
    this.lastError = null
    logger.info('自主决策循环启动')
    this._kick(50)
  }

  stop () {
    this.running = false
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    logger.info('自主决策循环停止')
  }

  nudge (ms = 0) {
    this._kick(ms)
  }

  _kick (ms = 0) {
    if (!this.running) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => this.tick(), ms)
  }

  _scheduleNext () {
    const intervalMs = Math.max(1000, Number(this.config.intervalMs) || 4000)
    this._kick(Math.max(intervalMs, this.aiBackoffMs || 0))
  }

  _setAiBackoff (error) {
    const message = String(error && error.message ? error.message : error || '')
    const isRateLimited = /\b429\b|rate limit|限流/i.test(message)
    const isTimeout = /timeout|timed out|aborted|超时/i.test(message)
    const baseMs = isRateLimited ? 30000 : (isTimeout ? 10000 : 5000)
    const multiplier = Math.min(Math.max(this.aiErrorStreak - 1, 0), 3)
    this.aiBackoffMs = Math.min(baseMs * (2 ** multiplier), 120000)
    return this.aiBackoffMs
  }

  _hasValidApiKey () {
    const key = String(this.config.apiKey || '').trim()
    if (!key) return false
    if (/^sk-xxx$/i.test(key)) return false
    if (/^(your|placeholder|changeme|xxxx+|xxx|none|null|undefined|api[_-]?key)$/i.test(key)) return false
    return true
  }

  _timeoutFor (name, args = {}) {
    if (name === 'follow') return 86400000
    if (name === 'mineOreVein' && Number(args.targetCount || args.count) > 0) return 600000
    if (['buildHouse', 'buildTower', 'buildBridge', 'buildWall', 'buildShelter', 'craft', 'craftGear'].includes(name)) return 240000
    return undefined
  }

  _dispatchPlan (actions, snapshot) {
    this._persistSnapshot(snapshot)
    let plan = Array.isArray(actions)
      ? actions.filter(a => a && TOOL_NAMES.has(a.name)).map(a => ({ name: a.name, args: a.args || {} }))
      : []
    if (!plan.length) plan = [{ name: 'explore', args: {} }]
    if (plan.length === 1 && plan[0].name === 'wait' && this._repeatStreak >= 2) {
      plan = [{ name: 'explore', args: {} }]
    }

    // 掉落物会消失，优先捡。AI/离线计划没选 collect 时，强制插到最前。
    if (snapshot && Array.isArray(snapshot.nearbyDrops) && snapshot.nearbyDrops.length) {
      if (!plan.some(a => a.name === 'collect')) {
        plan.unshift({ name: 'collect', args: { radius: 8 } })
      }
    }

    this.lastPlan = plan
    const planKey = JSON.stringify(plan.map(a => [a.name, a.args || {}]))
    if (planKey === this._lastPlanKey) {
      this._repeatStreak++
    } else {
      this._repeatStreak = 0
      this._forceVary = false
    }
    this._lastPlanKey = planKey
    if (this._repeatStreak >= 3) this._forceVary = true

    this._recordAssistantActions(plan)
    this.agent.emit('aiPlan', { actions: plan, at: Date.now() })

    const calls = plan.map(a => ({ name: a.name, args: a.args || {}, timeoutMs: this._timeoutFor(a.name, a.args || {}) }))
    this.executor && this.executor.enqueue(calls)
  }

  recordAction (action) {
    if (!action) return
    this._recordAssistantActions([{ name: action.name, args: action.args || {} }], true)
  }

  _recordAssistantActions (actions, fromOwner = false) {
    const list = (Array.isArray(actions) ? actions : []).filter(a => a && a.name)
    if (!list.length) return
    this._pendingAssistant = { actions: list.map(a => ({ name: a.name, args: a.args || {} })) }
    this._pushHistory('assistant', JSON.stringify({
      source: fromOwner ? '主人指令直连' : 'AI 决策',
      actions: list.map(a => ({ name: a.name, args: a.args || {} }))
    }))
  }

  _recordToolResult (call, result) {
    if (!call) return
    const name = call.name
    const ok = !!(result && result.ok)
    const reason = (result && result.reason) || (ok ? 'done' : 'failed')
    this._pushHistory('user', '【执行结果】' + name + ': ' + JSON.stringify({
      ok,
      reason
    }))
    if (this.memory) this.memory.recordActionResult(name, ok, reason)
  }

  _recordBatchEnd () {
    this._pendingAssistant = null
  }

  _pushHistory (role, content) {
    const text = String(content || '').trim()
    if (!text) return
    this.history.push({ role, content: text.slice(0, 2000) })
    this._trimHistory()
    if (this.memory) this.memory.recordMessage(role, content)
  }

  _trimHistory () {
    while (this.history.length > MAX_HISTORY_MESSAGES) this.history.shift()
    let chars = this.history.reduce((sum, m) => sum + (m.content ? m.content.length : 0), 0)
    while (chars > MAX_HISTORY_CHARS && this.history.length > 1) {
      const removed = this.history.shift()
      chars -= removed.content ? removed.content.length : 0
    }
  }

  _buildPlan (goal) {
    const g = String(goal || '').toLowerCase()
    const S = (name, args, note) => ({ name, args: args || {}, note, done: false })
    const inventory = S('inventory', {}, '检查背包和手持装备')
    const collect = S('collect', { radius: 12 }, '采集附近可采集方块并拾取掉落物')
    const craftPlanks = S('craftPlanks', {}, '砍树并合成足够木板')
    const craftTable = S('craft', { name: 'crafting_table' }, '制作并放置工作台')
    const gear = S('craftGear', {}, '自动制作木制工具、武器和基础装备并装备')

    let plan
    if (/(盖房|建房子|造房|搭房|盖屋|建屋|房子|修房|house)/.test(g)) {
      plan = {
        steps: [inventory, collect, craftPlanks, craftTable, gear, S('buildHouse', {}, '按设计盖一座带门和屋顶的房子'), collect, inventory],
        loop: false
      }
    } else if (/(建塔|造塔|盖塔|搭塔|高塔|瞭望塔|tower)/.test(g)) {
      plan = {
        steps: [inventory, collect, craftPlanks, craftTable, gear, S('buildTower', {}, '按设计建造塔楼'), inventory],
        loop: false
      }
    } else if (/(搭桥|造桥|建桥|架桥|修桥|bridge)/.test(g)) {
      plan = {
        steps: [inventory, collect, craftPlanks, S('buildBridge', {}, '向前铺设桥面'), inventory],
        loop: false
      }
    } else if (/(造墙|建墙|砌墙|搭墙|围墙|修墙|wall)/.test(g)) {
      plan = {
        steps: [inventory, collect, craftPlanks, S('buildWall', {}, '在面前建造一面墙'), inventory],
        loop: false
      }
    } else if (/(矿|开采|挖矿|下矿|ore|mine)/.test(g)) {
      plan = {
        steps: [inventory, gear, S('mineOreVein', {}, '寻找并开采附近的矿脉'), collect, inventory],
        loop: true
      }
    } else if (/(树|木|砍树|伐木|木头|chop|wood|log)/.test(g)) {
      plan = {
        steps: [inventory, S('chopTree', {}, '寻找并砍伐最近的树木'), collect, craftPlanks, inventory],
        loop: true
      }
    } else if (/(捡|拾取|收集|拾起|collect|pickup)/.test(g)) {
      plan = {
        steps: [S('collect', { radius: 12 }, '拾取掉落物并采集附近可采集方块'), inventory],
        loop: true
      }
    } else if (/(工作台|craftingtable|crafttable|crafting_table)/.test(g)) {
      plan = {
        steps: [inventory, collect, craftPlanks, craftTable, inventory],
        loop: false
      }
    } else if (/(装备|工具|武器|制作|合成|打造|craftgear|gear|craft|equip|armor|weapon)/.test(g)) {
      plan = {
        steps: [inventory, collect, craftPlanks, craftTable, gear, inventory],
        loop: false
      }
    } else if (/(跟随|跟我|跟着|跟住|跟紧|过来|来这|follow|come)/.test(g)) {
      plan = {
        steps: [S('follow', {}, '持续跟随主人，直到主人说停止')],
        loop: false
      }
    } else if (/(保护|protect|guard|defend)/.test(g)) {
      plan = {
        steps: [inventory, gear, S('protect', {}, '守卫主人并攻击附近威胁')],
        loop: true
      }
    } else {
      plan = {
        steps: [inventory, collect, S('explore', { distance: 8 }, '探索以发现新的资源和目标'), inventory],
        loop: true
      }
    }

    plan.goal = this.goal || goal
    plan.activeStep = 0
    plan.status = 'running'
    plan.note = '任务已拆解，按步骤持续推进。'
    plan.updatedAt = Date.now()
    return plan
  }

  _autoCompletePrepSteps (snapshot) {
    const plan = this.plan
    if (!plan || !Array.isArray(plan.steps) || plan.steps.length === 0) return
    if (plan.status === 'complete' || plan.status === 'paused') return
    const state = snapshot || {}
    const inventory = state.inventory
    const items = (inventory && Array.isArray(inventory.items)) ? inventory.items : []
    const has = (name) => items.some(i => String(i && i.name || '').toLowerCase() === name)
    const countPlanks = items
      .filter(i => String(i && i.name || '').toLowerCase().endsWith('_planks'))
      .reduce((sum, i) => sum + Number(i.count || 0), 0)
    const hasPickaxe = items.some(i => String(i && i.name || '').toLowerCase().endsWith('_pickaxe'))
    const hasSword = items.some(i => String(i && i.name || '').toLowerCase().endsWith('_sword'))

    for (let guard = 0; guard < plan.steps.length; guard++) {
      const idx = Math.min(plan.activeStep || 0, plan.steps.length - 1)
      const step = plan.steps[idx]
      if (!step || step.done) break
      let ready = false
      if (step.name === 'inventory') {
        ready = true
      } else if (step.name === 'craftPlanks') {
        ready = countPlanks >= 16
      } else if (step.name === 'craft' && step.args && step.args.name === 'crafting_table') {
        ready = has('crafting_table')
      } else if (step.name === 'craftGear') {
        ready = hasPickaxe && hasSword
      } else {
        break
      }
      if (!ready) break
      step.done = true
      step.note = (step.note || '') + '已检查，自动跳过'
      plan.updatedAt = Date.now()
      this._advanceStep(plan, idx, 'auto')
      if (this.memory) this.memory.setPlan(plan)
      this.agent.emit('aiPlan', { plan, at: Date.now() })
    }
  }

  _advanceStep (plan, idx, reason) {
    if (plan.loop) {
      plan.activeStep = (idx + 1) % plan.steps.length
      plan.note = '第 ' + (idx + 1) + ' 步完成' + (reason === 'auto' ? '（自动确认）' : '') + '；继续循环推进。'
    } else {
      plan.activeStep = idx + 1
      if (plan.activeStep >= plan.steps.length) {
        const hasSkippedFailure = plan.steps.some(x => x && x.done && /连续失败/.test(String(x.note || '')))
        if (hasSkippedFailure) {
          plan.status = 'failed'
          plan.note = '部分步骤因连续失败被跳过，任务未真正完成。'
        } else {
          plan.status = 'complete'
          plan.note = '任务步骤全部完成。'
        }
      } else {
        plan.note = '第 ' + (idx + 1) + ' 步完成；继续下一步。'
      }
    }
    plan.updatedAt = Date.now()
    return plan
  }

  _advancePlan (call, result) {
    const plan = this.plan
    if (!plan || !Array.isArray(plan.steps) || plan.steps.length === 0) return
    if (plan.status === 'complete') return
    const idx = Math.min(plan.activeStep || 0, plan.steps.length - 1)
    const step = plan.steps[idx]
    if (!step) return

    // 失败也要记录：step.failures 累计失败次数，连续失败超过阈值则自动跳过换方案，
    // 避免任务永远卡在同一动作上。
    if (!result || !result.ok) {
      step.failures = Number(step.failures || 0) + 1
      step.lastFailReason = (result && result.reason) || (call ? ('动作 ' + call.name + ' 执行失败') : '执行失败')
      step.updatedAt = Date.now()
      const failLimit = Number(this.config.stepFailLimit) || 2
      if (step.failures >= failLimit) {
        if (TERMINAL_BUILD_STEPS.has(step.name)) {
          logger.warn(`步骤 ${step.name} 连续失败，回退到准备材料步骤，不标记任务完成: ${step.lastFailReason}`)
          this.agent.emit('log', { level: 'warn', message: `步骤 ${step.name} 连续失败，回退到准备材料步骤，继续准备建材` })
          step.failures = 0
          step.lastFailReason = (result && result.reason) || '执行失败'
          step.updatedAt = Date.now()
          const PREP = new Set(['inventory', 'collect', 'craftPlanks', 'craft', 'craftGear'])
          let prepIndex = -1
          for (let i = 0; i < idx; i++) {
            const before = plan.steps[i]
            if (before && PREP.has(before.name)) {
              if (prepIndex < 0) prepIndex = i
              before.done = false
              before.failures = 0
              before.lastFailReason = ''
            }
          }
          plan.activeStep = prepIndex >= 0 ? prepIndex : 0
          plan.status = 'running'
          plan.note = '建材不足，已回退重新准备材料。'
          this._completionReported = false
          plan.updatedAt = Date.now()
          if (this.memory) this.memory.setPlan(plan)
          this.agent.emit('aiPlan', { plan, at: Date.now() })
          return true
        }
        logger.warn(`步骤 ${step.name} 连续失败 ${step.failures} 次，自动跳过换方案: ${step.lastFailReason}`)
        this.agent.emit('log', { level: 'warn', message: `步骤 ${step.name} 连续失败，自动换方案` })
        step.done = true
        step.note = (step.note || '') + `连续失败 ${step.failures} 次（${step.lastFailReason}），自动跳过`
        const advanced = this._advanceStep(plan, idx, 'fail')
        plan.updatedAt = Date.now()
        if (this.memory) this.memory.setPlan(plan)
        this.agent.emit('aiPlan', { plan, at: Date.now() })
        // 返回 true 提示上层本轮改走本地兜底，避免再次提交同一失败动作
        return true
      }
      plan.updatedAt = Date.now()
      if (this.memory) this.memory.setPlan(plan)
      return false
    }

    let target = -1
    if (step.name === call.name && !step.done) {
      target = idx
    } else {
      for (let i = idx + 1; i < plan.steps.length; i++) {
        const cand = plan.steps[i]
        if (cand && cand.name === call.name && !cand.done) {
          target = i
          break
        }
      }
      if (target < 0 && plan.loop) {
        for (let i = 0; i < idx; i++) {
          const cand = plan.steps[i]
          if (cand && cand.name === call.name && !cand.done) {
            target = i
            break
          }
        }
      }
    }
    if (target < 0) return false

    for (let i = idx; i < target; i++) {
      const before = plan.steps[i]
      if (!before || before.done) continue
      if (TERMINAL_BUILD_STEPS.has(before.name)) {
        plan.activeStep = i
        plan.updatedAt = Date.now()
        if (this.memory) this.memory.setPlan(plan)
        this.agent.emit('aiPlan', { plan, at: Date.now() })
        return false
      }
      before.done = true
      before.note = (before.note || '') + '已由后续动作直接完成，自动跳过'
    }
    const targetStep = plan.steps[target]
    if (targetStep && !targetStep.done) {
      targetStep.done = true
      targetStep.note = (targetStep.note || '') + '已执行'
      targetStep.failures = 0
      targetStep.lastFailReason = ''
    }
    plan.activeStep = target
    this._advanceStep(plan, target, 'done')
    if (this.memory) this.memory.setPlan(plan)
    this.agent.emit('aiPlan', { plan, at: Date.now() })
    return true
  }

  _offlineBuildPlan (snapshot) {
    if (!this._offlineStep || this._offlineStep % 6 !== 0) return null
    const state = snapshot || {}
    const inventory = state.inventory
    const items = inventory && Array.isArray(inventory.items) ? inventory.items : []
    if (!items.length) return null
    const BUILD_BLOCK_EXACT = new Set(['cobblestone', 'stone', 'dirt', 'sandstone', 'bricks', 'stone_bricks', 'netherrack', 'end_stone', 'mossy_cobblestone'])
    let count = 0
    for (const item of items) {
      if (!item) continue
      const n = String(item.name || '').toLowerCase()
      if (BUILD_BLOCK_EXACT.has(n) || n.endsWith('_planks') || n.endsWith('_log') || n.endsWith('_stem') || n.endsWith('_hyphae') || n === 'mushroom_stem') {
        count += Number(item.count || 0)
      }
    }
    if (count < 20) return null
    if (count >= 64) return [{ name: 'buildHouse', args: {} }]
    return [{ name: 'buildShelter', args: {} }]
  }

  _shouldCraftGear (snapshot) {
    const state = snapshot || {}
    const inventory = state.inventory
    const items = (inventory && Array.isArray(inventory.items)) ? inventory.items : []
    if (!items.length) return false
    const has = name => items.some(i => String(i && i.name || '').toLowerCase() === name)
    const countPlanks = items
      .filter(i => String(i && i.name || '').toLowerCase().endsWith('_planks'))
      .reduce((sum, i) => sum + Number(i.count || 0), 0)
    if (has('wooden_pickaxe') || has('stone_pickaxe') || has('iron_pickaxe')) {
      if (has('wooden_sword') || has('stone_sword') || has('iron_sword')) return false
    }
    const targets = Array.isArray(state.nearbyTargets) ? state.nearbyTargets : []
    const treeNearby = targets.some(i => {
      const n = String(i && i.name || '').toLowerCase()
      return n.endsWith('_log') || n.endsWith('_stem') || n === 'mushroom_stem'
    })
    const logInBag = items.some(i => {
      const n = String(i && i.name || '').toLowerCase()
      return n.endsWith('_log') || n.endsWith('_stem') || n.endsWith('_hyphae') || n === 'mushroom_stem'
    })
    return logInBag || countPlanks >= 3 || treeNearby
  }

  _offlineActions (snapshot) {
    this._offlineStep++
    const state = snapshot || {}
    const bot = state.bot || {}
    const food = Number(bot.food)
    if (Number.isFinite(food) && food < 10) return [{ name: 'eat', args: {} }]

    const hostiles = Array.isArray(state.nearbyHostiles) ? state.nearbyHostiles : []
    if (hostiles.length && this._offlineStep % 4 === 0) return [{ name: 'armor', args: {} }]

    const drops = Array.isArray(state.nearbyDrops) ? state.nearbyDrops : []
    if (drops.length) return [{ name: 'collect', args: { radius: 8 } }]

    // 工具保养：每 8 步检查一次低耐久工具，有则先丢弃
    const invItems = (state.inventory && Array.isArray(state.inventory.items)) ? state.inventory.items : []
    const wornTool = invItems.find(i => {
      const pct = Number(i.durabilityPct)
      return Number.isFinite(pct) && pct < 30
    })
    if (wornTool && this._offlineStep % 8 === 0) return [{ name: 'checkTools', args: { threshold: 30 } }]

    const build = this._offlineBuildPlan(state)
    if (build) return build

    if (this._offlineStep % 2 === 0 && this._shouldCraftGear(state)) {
      return [{ name: 'craftGear', args: {} }]
    }

    const targets = Array.isArray(state.nearbyTargets) ? state.nearbyTargets : []
    if (targets.length) {
      const name = String(targets[0].name || '').toLowerCase()
      if (name.includes('_log') || name.includes('_stem') || name === 'mushroom_stem') {
        return [{ name: 'chopTree', args: {} }]
      }
      if (name.includes('_ore') || name === 'ancient_debris') {
        return [{ name: 'mineOreVein', args: {} }]
      }
      return [{ name: 'collect', args: { radius: 12 } }]
    }

    if (this._offlineStep % 6 === 0) return [{ name: 'collect', args: { radius: 16 } }]
    return [{ name: 'explore', args: { distance: 8 } }]
  }

  // 生存优先级：低血/低食/无装备时强制补给，避免 AI 在危险状态下自由行动。
  // 返回动作数组或 null（无紧急需求）。
  _survivalPriority (snapshot) {
    const state = snapshot || {}
    const bot = state.bot || {}
    const health = Number(bot.health)
    const food = Number(bot.food)
    const now = Date.now()

    // ???/????????????????????? LLM ??
    if ((Number.isFinite(health) && health < 6) || (Number.isFinite(food) && food < 6)) {
      if (now - this._lastSurvivalEatAt >= SURVIVAL_COOLDOWN_MS) {
        this._lastSurvivalEatAt = now
        this.agent.emit('log', { level: 'warn', message: `??/????? (health=${health}, food=${food})?????` })
        return [{ name: 'eat', args: {} }]
      }
      return null
    }

    // ??????????????/????????????????? LLM
    const hostiles = Array.isArray(state.nearbyHostiles) ? state.nearbyHostiles : []
    const inventory = state.inventory
    const items = (inventory && Array.isArray(inventory.items)) ? inventory.items : []
    const hasWeapon = items.some(i => String(i && i.name || '').toLowerCase().includes('sword') || String(i && i.name || '').toLowerCase().includes('axe'))
    const hasArmor = items.some(i => {
      const n = String(i && i.name || '').toLowerCase()
      return n.includes('helmet') || n.includes('chestplate') || n.includes('leggings') || n.includes('boots')
    })

    if (hostiles.length && !hasWeapon) {
      if (hasArmor && now - this._lastSurvivalArmorAt >= SURVIVAL_COOLDOWN_MS) {
        this._lastSurvivalArmorAt = now
        this.agent.emit('log', { level: 'warn', message: `?????????????????????` })
        return [{ name: 'armor', args: {} }]
      }
      if (!hasArmor && now - this._lastSurvivalAttackAt >= SURVIVAL_COOLDOWN_MS) {
        this._lastSurvivalAttackAt = now
        const hostile = hostiles[0]
        const targetName = hostile && (hostile.name || hostile.type)
        if (targetName) {
          this.agent.emit('log', { level: 'warn', message: `?????????????? ${targetName}` })
          return [{ name: 'attack', args: { name: targetName } }]
        }
        this.agent.emit('log', { level: 'warn', message: `????????????????` })
        return [{ name: 'explore', args: { distance: 8 } }]
      }
    }

    return null
  }

  async tick () {
    if (!this.running || this.ticking) return
    if (!this.agent.connected) {
      this._scheduleNext()
      return
    }
    if (this.executor && this.executor.busy) {
      this._scheduleNext()
      return
    }

    if (this.followTarget) {
      this._scheduleNext()
      return
    }

    if (this.holdPosition) {
      this._scheduleNext()
      return
    }

    if (!this._hasValidApiKey()) {
      const snapshot = this.agent.snapshot()
      this._autoCompletePrepSteps(snapshot)
      this._dispatchPlan(this._offlineActions(snapshot), snapshot)
      this._scheduleNext()
      return
    }

    this.ticking = true
    try {
      const snapshot = this.agent.snapshot()
      this._autoCompletePrepSteps(snapshot)

      // 生存优先级：先保命/补给，再交给 AI 决策
      const urgent = this._survivalPriority(snapshot)
      if (urgent) {
        this._dispatchPlan(urgent, snapshot)
        this._scheduleNext()
        return
      }

      const data = await chatCompletion({
        baseUrl: this.config.baseUrl,
        apiKey: this.config.apiKey,
        model: this.config.model,
        messages: this._buildMessages(snapshot),
        tools: TOOLS,
        temperature: this.config.temperature,
        maxTokens: this.config.maxTokens
      })

      let actions = this._normalizeActions(parseActions(data))
      if (!actions.length) actions = [{ name: 'explore', args: {} }]
      this.aiErrorStreak = 0
      this.aiBackoffMs = 0
      this._dispatchPlan(actions, snapshot)
    } catch (e) {
      this.lastError = e.message
      this.aiErrorStreak++
      const backoffMs = this._setAiBackoff(e)
      logger.warn(`AI 决策失败，${Math.ceil(backoffMs / 1000)} 秒后重试:`, e.message)
      this.agent.emit('log', { level: 'warn', message: `AI 决策失败，${Math.ceil(backoffMs / 1000)} 秒后重试: ${e.message}` })
      if (this.aiErrorStreak >= 3 && !this.holdPosition && !this.followTarget) {
        const snapshot = this.agent.snapshot()
        this._dispatchPlan(this._offlineActions(snapshot), snapshot)
      }
    } finally {
      this.ticking = false
    }
    this._scheduleNext()
  }

  /**
   * 处理玩家 @ai 指令：暂停自主循环 → 调用 LLM 分析 → 执行动作 → 恢复
   * @param {string} message - 玩家输入的指令文本
   * @param {string} username - 玩家名
   * @returns {Promise<{reply: string, actions: Array}>}
   */
  async ask (message, username) {
    const isRunning = this.running
    if (isRunning) this.stop()

    const snapshot = this.agent.snapshot()
    const payload = this._userPayload(snapshot)

    // 构建 @ai 专用 prompt：告诉 AI 这是玩家直接指令，不是自主决策
    const askPrompt = `你正在 Minecraft 中运行。玩家 @${username} 向你下达了指令。请分析指令，返回一个 JSON 对象格式的回复。

指令：${message}

当前世界状态：${JSON.stringify(snapshot)}

可用工具：
${JSON.stringify(TOOLS.map(t => ({ name: t.function.name, description: t.function.description })))}

回复格式必须严格为 JSON：
{
  "reply": "给玩家的回复文字，简要说明你做了什么",
  "actions": [{"name": "动作名", "args": {}}]
}

actions 数组可以为空（如果只需要回复）。动作名必须是可用工具中的名称。`

    const messages = [
      { role: 'system', content: this.systemPrompt },
      { role: 'system', content: '当前处于玩家指令模式，直接执行玩家要求，不要自主决策。' },
      { role: 'user', content: askPrompt }
    ]

    try {
      // 注入到 history 用于上下文的连续
      this._pushHistory('user', `${username}: ${message}`)

      const data = await chatCompletion({
        baseUrl: this.config.baseUrl,
        apiKey: this.config.apiKey,
        model: this.config.model,
        messages,
        tools: TOOLS,
        temperature: 0.2,
        maxTokens: this.config.maxTokens
      })

      let actions = this._normalizeActions(parseActions(data))
      const reply = this._extractReply(data) || `已收到指令：${message}`

      this._pushHistory('assistant', reply)

      // chat is delivered as the direct reply; dispatch only real tool actions
      const toolActions = actions.filter(a => a.name !== 'chat')
      if (toolActions.length && this.executor) {
        this._dispatchPlan(toolActions, snapshot)
      }

      return { reply, actions: toolActions }
    } catch (e) {
      this.lastError = e.message
      logger.warn(`AI 指令处理失败: ${e.message}`)
      return { reply: `处理指令时出错: ${e.message}`, actions: [] }
    } finally {
      if (isRunning) this.start()
    }
  }

  _extractReply (data) {
    // OpenAI-style: read choices[0].message.content (JSON {reply} or plain text) and chat tool_calls
    const message = data && data.choices && data.choices[0] && data.choices[0].message
    if (!message) return null

    let content = message.content
    if (typeof content !== 'string' || !content.trim()) content = message.reasoning_content || message.reasoning || ''
    if (typeof content === 'string' && content.trim()) {
      let text = content.trim()
      // strip a leading markdown code fence if present
      if (text.startsWith('```')) {
        const parts = text.split('```')
        if (parts.length >= 2) {
          let body = parts[1] || ''
          const nl = body.indexOf(String.fromCharCode(10))
          if (nl >= 0 && nl <= 10) body = body.slice(nl + 1)
          text = body.trim()
        }
      }
      try {
        const parsed = JSON.parse(text)
        if (parsed && typeof parsed.reply === 'string' && parsed.reply.trim()) return parsed.reply.trim()
      } catch {}
      if (!text.startsWith('{')) return text.slice(0, 200)
    }

    if (Array.isArray(message.tool_calls)) {
      for (const tc of message.tool_calls) {
        if (tc && tc.function && tc.function.name === 'chat') {
          try {
            const args = JSON.parse(tc.function.arguments || '{}')
            if (args && typeof args.message === 'string' && args.message.trim()) return args.message.trim().slice(0, 200)
          } catch {}
        }
      }
    }

    return null
  }
  _buildMessages (snapshot) {
    const messages = [
      { role: 'system', content: this.systemPrompt },
      { role: 'system', content: '当前目标：' + this.goal }
    ]
    for (const m of this.history) {
      if (m && m.role && m.content) messages.push({ role: m.role, content: m.content })
    }
    messages.push({ role: 'user', content: JSON.stringify(this._userPayload(snapshot)) })
    return messages
  }

  _userPayload (snapshot) {
    const plan = this.plan
    const activeStep = plan && Array.isArray(plan.steps) && plan.steps.length
      ? plan.steps[Math.min(plan.activeStep || 0, plan.steps.length - 1)]
      : null
    return {
      worldState: snapshot,
      goal: this.goal,
      plan: plan,
      activeStep: activeStep ? { name: activeStep.name, note: activeStep.note || '', failures: activeStep.failures || 0, lastFailReason: activeStep.lastFailReason || '' } : null,
      previousPlan: this.lastPlan.slice(0, 6),
      previousResults: this.lastResults.slice(-8),
      instruction: this._instruction()
    }
  }

  _instruction () {
    if (this._forceVary) {
      return '上一次方案已重复多次，必须换一个动作或改变参数，禁止再次提交完全相同的计划。'
    }
    const plan = this.plan
    if (plan && Array.isArray(plan.steps) && plan.steps.length) {
      if (plan.status === 'failed') {
        if (!this._completionReported) {
          this._completionReported = true
          this._completionReportedAt = Date.now()
          return '部分步骤因连续失败被跳过，任务并未真正完成。请如实向主人报告一次当前进展、缺少什么条件，不要谎报完成；之后保持沉默，不要重复发言、不要空转。'
        }
        return '任务未完成（有步骤失败被跳过）。保持沉默，除非主人发新指令，否则不要发言、不要空转。'
      }
      if (plan.status === 'complete') {
        if (!this._completionReported) {
          this._completionReported = true
          this._completionReportedAt = Date.now()
          return '任务步骤已完成。请只通过 chat 工具向主人简短报告一次完成；之后原地待命，保持沉默，除非主人发新指令，禁止重复发言，禁止空转。'
        }
        return '任务已完成并已报告。原地待命，保持沉默，除非主人发新指令，否则不要发言、不要空转。'
      }
      if (plan.status === 'paused') {
        return '任务被主人暂停，原地待命，不要空转。'
      }
      const idx = Math.min(plan.activeStep || 0, plan.steps.length - 1)
      const step = plan.steps[idx]
      const doneCount = plan.steps.filter(s => s && s.done).length
      return '你是监工，必须持续推进任务直到主人说停止或完成。当前计划进度 ' + doneCount + '/' + plan.steps.length + '，正在做第 ' + (idx + 1) + ' 步：' + step.note + '（建议工具 ' + step.name + '）。先看 worldState、previousPlan、previousResults，若上一步已成功就继续下一步；若失败就换路径/先准备材料。'
    }
    return '从可用工具中选择下一步。若上一轮动作已成功，继续推进目标；若失败或状态未变化，换一个可执行方案。'
  }

  _normalizeActions (actions) {
    const out = []
    for (const action of actions) {
      if (!action || typeof action !== 'object') continue
      if (action.type === 'chat' && action.message) {
        out.push({ name: 'chat', args: { message: action.message } })
        continue
      }
      if (action.type !== 'tool' || !action.name) continue
      if (!TOOL_NAMES.has(action.name)) continue
      out.push({ name: action.name, args: action.args || {} })
    }
    return out
  }

  recordResult (name, result) {
    this.lastResults.push({ skill: name, result: (result && result.reason) || (result && result.ok ? 'done' : 'failed'), at: Date.now() })
    if (this.lastResults.length > 40) this.lastResults.splice(0, this.lastResults.length - 40)
  }

  destroy () {
    this.stop()
    this._clearFollowRetry()
    if (this.memory) this.memory.destroy()
    if (this.executor) this._unbindExecutor(this.executor)
  }
}

module.exports = Brain
