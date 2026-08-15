const fs = require('fs')
const path = require('path')
const logger = require('../lib/logger')
const { chatCompletion, parseActions } = require('./provider')
const { TOOLS, TOOL_NAMES } = require('./tools')

class Brain {
  constructor (agent, config) {
    this.agent = agent
    this.config = config
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

  start () {
    if (this.running) return
    this.running = true
    this.lastError = null
    logger.info('AI 决策循环启动')
    this._kick(50)
  }

  stop () {
    this.running = false
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    logger.info('AI 决策循环停止')
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

  async tick () {
    if (!this.running || this.ticking || !this.agent.connected) return
    if (this.executor && this.executor.busy) return
    this.ticking = true
    try {
      const snapshot = this.agent.snapshot()
      const messages = [
        { role: 'system', content: this.systemPrompt },
        { role: 'system', content: `当前目标：${this.goal}` },
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

      const actions = this._normalizeActions(parseActions(data))
      if (!actions.length) {
        this._scheduleNext()
        return
      }

      const plan = actions.map(a => ({ name: a.name, args: a.args }))
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
      this.executor?.enqueue(actions)
    } catch (e) {
      this.lastError = e.message
      logger.warn('AI 决策失败:', e.message)
      this.agent.emit('log', { level: 'warn', message: `AI 决策失败: ${e.message}` })
      this._scheduleNext()
    } finally {
      this.ticking = false
    }
  }

  _userPayload (snapshot) {
    return {
      worldState: snapshot,
      previousPlan: this.lastPlan.slice(0, 6),
      previousResults: this.lastResults.slice(-8),
      instruction: this._forceVary ? '上一次方案已重复多次，必须换一个动作或改变参数，禁止再次提交完全相同的计划。' : '从可用工具中选择下一步。若上一轮动作已成功，继续推进目标；若失败或状态未变化，换一个可执行方案。'
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