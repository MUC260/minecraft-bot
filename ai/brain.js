const fs = require('fs')
const path = require('path')
const logger = require('../lib/logger')
const { chatCompletion, parseActions } = require('./provider')
const { TOOLS, TOOL_NAMES } = require('./tools')

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
    this._offlineStep = 0
    this.systemPrompt = this._loadPrompt()
    this._onQueueEmpty = () => this._kick(150)
    this._onQueueFailure = ({ call, result }) => {
      this.recordResult(call?.name, { reason: result?.reason || 'queue failed' })
      this._kick(300)
    }
    this._onSkillResult = ({ call, result }) => this.recordResult(call?.name, result)
    if (this.executor) {
      this.executor.on('queue:empty', this._onQueueEmpty)
      this.executor.on('queue:failure', this._onQueueFailure)
      this.executor.on('skill:result', this._onSkillResult)
    }
  }

  setExecutor (executor) {
    if (this.executor === executor) return this.executor
    if (this.executor) {
      this.executor.removeListener('queue:empty', this._onQueueEmpty)
      this.executor.removeListener('queue:failure', this._onQueueFailure)
      this.executor.removeListener('skill:result', this._onSkillResult)
    }
    this.executor = executor
    if (executor) {
      executor.on('queue:empty', this._onQueueEmpty)
      executor.on('queue:failure', this._onQueueFailure)
      executor.on('skill:result', this._onSkillResult)
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

  setGoal (goal) {
    if (goal && String(goal).trim()) this.goal = String(goal).trim()
    return this.goal
  }

  setHold (hold = true) {
    this.holdPosition = !!hold
    if (hold) this.followTarget = null
    return this.holdPosition
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
    return this.followTarget
  }

  clearFollow () {
    this.followTarget = null
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
    this._kick(this.config.intervalMs || 1500)
  }

  _hasValidApiKey () {
    const key = String(this.config.apiKey || '').trim()
    if (!key) return false
    if (/^sk-xxx$/i.test(key)) return false
    if (/^(your|placeholder|changeme|xxxx+|xxx|none|null|undefined|api[_-]?key)$/i.test(key)) return false
    return true
  }

  _timeoutFor (name) {
    if (name === 'follow') return 110000
    if (['buildHouse', 'buildTower', 'buildBridge', 'buildWall', 'buildShelter', 'craft', 'craftGear'].includes(name)) return 240000
    return undefined
  }

  _dispatchPlan (actions, snapshot) {
    let plan = Array.isArray(actions)
      ? actions.filter(a => a && TOOL_NAMES.has(a.name)).map(a => ({ name: a.name, args: a.args || {} }))
      : []
    if (!plan.length) plan = [{ name: 'explore', args: {} }]
    if (plan.length === 1 && plan[0].name === 'wait' && this._repeatStreak >= 2) {
      plan = [{ name: 'explore', args: {} }]
    }

    // Dropped items are time-sensitive (they despawn). If the world snapshot
    // reports any nearby drops and the AI/fallback plan did not already choose
    // collect, insert it as the very next action so loot is not lost.
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
    this.agent.emit('aiPlan', { actions: plan, at: Date.now() })
    const calls = plan.map(a => ({ name: a.name, args: a.args || {}, timeoutMs: this._timeoutFor(a.name) }))
    this.executor?.enqueue(calls)
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

    // Dropped items should win over new mining/chopping work. Otherwise a
    // bot standing next to a tree will keep chopping forever and never pick up
    // the blocks it just broke.
    const drops = Array.isArray(state.nearbyDrops) ? state.nearbyDrops : []
    if (drops.length) return [{ name: 'collect', args: { radius: 8 } }]

    const build = this._offlineBuildPlan(state)
    if (build) return build

    // Without basic tools the bot gets stuck doing nothing useful. Craft gear
    // when no bigger building task is ready so it can harvest wood and defend
    // itself instead of just wandering around empty-handed.
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
      this._dispatchPlan(this._offlineActions(snapshot), snapshot)
      this._scheduleNext()
      return
    }

    this.ticking = true
    try {
      const snapshot = this.agent.snapshot()
      const messages = [
        { role: 'system', content: this.systemPrompt },
        { role: 'system', content: '当前目标：' + this.goal },
        { role: 'user', content: JSON.stringify(this._userPayload(snapshot)) }
      ]

      const data = await chatCompletion({
        baseUrl: this.config.baseUrl,
        apiKey: this.config.apiKey,
        model: this.config.model,
        messages,
        tools: TOOLS,
        temperature: this.config.temperature,
        maxTokens: this.config.maxTokens
      })

      let actions = this._normalizeActions(parseActions(data))
      if (!actions.length) actions = [{ name: 'explore', args: {} }]
      this.aiErrorStreak = 0
      this._dispatchPlan(actions, snapshot)
    } catch (e) {
      this.lastError = e.message
      this.aiErrorStreak++
      logger.warn('AI 决策失败:', e.message)
      this.agent.emit('log', { level: 'warn', message: 'AI 决策失败: ' + e.message })
      if (this.aiErrorStreak >= 3 && !this.holdPosition && !this.followTarget) {
        const snapshot = this.agent.snapshot()
        const fallback = this._offlineActions(snapshot)
        this._dispatchPlan(fallback, snapshot)
        this.aiErrorStreak = 0
      }
    } finally {
      this.ticking = false
    }
    this._scheduleNext()
  }

  _userPayload (snapshot) {
    return {
      worldState: snapshot,
      previousPlan: this.lastPlan.slice(0, 6),
      previousResults: this.lastResults.slice(-8),
      instruction: this._forceVary
        ? '上一次方案已重复多次，必须换一个动作或改变参数，禁止再次提交完全相同的计划。'
        : '从可用工具中选择下一步。若上一轮动作已成功，继续推进目标；若失败或状态未变化，换一个可执行方案。'
    }
  }

  _normalizeActions (actions) {
    const out = []
    for (const action of actions) {
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
    this.lastResults.push({ skill: name, result: result?.reason || 'done', at: Date.now() })
    if (this.lastResults.length > 40) this.lastResults.splice(0, this.lastResults.length - 40)
  }

  destroy () {
    this.stop()
    if (this.executor) {
      this.executor.removeListener('queue:empty', this._onQueueEmpty)
      this.executor.removeListener('queue:failure', this._onQueueFailure)
      this.executor.removeListener('skill:result', this._onSkillResult)
    }
  }
}

module.exports = Brain
