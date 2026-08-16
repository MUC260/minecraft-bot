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
    // 长期规划状态
    this.longTermPlan = null          // 最近一次 AI 生成的大纲
    this.longTermPlanAt = 0           // 生成时间
    this.planTimer = null             // 3 分钟规划定时器
    this.planIntervalMs = config.planIntervalMs || 180000   // 默认 3 分钟
    this.planning = false
    this.systemPrompt = this._loadPrompt()
    this.plannerPrompt = this._loadPlannerPrompt()
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

  _loadPlannerPrompt () {
    try {
      return fs.readFileSync(path.join(__dirname, 'prompts', 'planner.md'), 'utf8')
    } catch {
      return '你是一个 Minecraft 生存战略规划器，输出 JSON 大纲。'
    }
  }

  setGoal (goal) {
    if (goal && String(goal).trim()) this.goal = String(goal).trim()
    // 目标改变时，立即触发一次重新规划
    this.nudgePlan(50)
    return this.goal
  }

  start () {
    if (this.running) return
    this.running = true
    this.lastError = null
    logger.info('AI 决策循环启动')
    this._kick(50)
    // 启动 3 分钟长期规划循环
    this._startPlanLoop()
  }

  stop () {
    this.running = false
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (this.planTimer) clearTimeout(this.planTimer)
    this.planTimer = null
    logger.info('AI 决策循环停止')
  }

  nudge (ms = 0) {
    this._kick(ms)
  }

  // 触发一次长期规划（可被外部调用，如目标变化时）
  nudgePlan (ms = 0) {
    if (!this.running) return
    if (this.planTimer) clearTimeout(this.planTimer)
    this.planTimer = setTimeout(() => this._makeLongTermPlan(), ms)
  }

  // 3 分钟规划循环：每次规划完成后安排下一次
  _startPlanLoop () {
    if (!this.running) return
    this.planTimer = setTimeout(async () => {
      await this._makeLongTermPlan()
      // 循环安排下一次
      this._startPlanLoop()
    }, this.planIntervalMs)
  }

  // 收集完整信息交给 AI，生成行动大纲
  async _makeLongTermPlan () {
    if (!this.running || this.planning || !this.agent.connected) return
    this.planning = true
    try {
      const snapshot = this.agent.snapshot()
      const payload = {
        goal: this.goal,
        worldState: snapshot,
        recentResults: this.lastResults.slice(-10),
        currentShortTermPlan: this.lastPlan.slice(0, 5)
      }
      const messages = [
        { role: 'system', content: this.plannerPrompt },
        { role: 'user', content: JSON.stringify(payload) }
      ]
      const data = await chatCompletion({
        ...this._chatOpts({ temperature: 0.3, maxTokens: 800 }),
        messages
      })
      const content = (data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || ''
      const plan = this._parsePlan(content)
      if (plan) {
        this.longTermPlan = plan
        this.longTermPlanAt = Date.now()
        logger.info(`[规划] 已生成行动大纲: ${plan.priority || ''} (${(plan.plan || []).length} 阶段)`)
        this.agent.emit('log', { level: 'info', message: `[规划] ${plan.summary || '已生成行动大纲'}` })
        this.agent.emit('longTermPlan', plan)
      } else {
        logger.warn('[规划] AI 返回的大纲无法解析')
      }
    } catch (e) {
      logger.warn('[规划] 生成大纲失败:', e.message)
    } finally {
      this.planning = false
    }
  }

  // 解析规划器输出（兼容 markdown 代码块、多余文字）
  _parsePlan (text) {
    if (!text) return null
    let t = String(text).trim()
    const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/)
    if (fence) t = fence[1].trim()
    const start = t.indexOf('{')
    const end = t.lastIndexOf('}')
    if (start === -1 || end === -1) return null
    try {
      const obj = JSON.parse(t.slice(start, end + 1))
      if (obj && (obj.plan || obj.summary || obj.priority)) {
        return {
          summary: obj.summary || '',
          priority: obj.priority || '',
          plan: Array.isArray(obj.plan) ? obj.plan : [],
          hints: Array.isArray(obj.hints) ? obj.hints : []
        }
      }
    } catch (e) {}
    return null
  }

  _kick (ms = 0) {
    if (!this.running) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => this.tick(), ms)
  }

  _scheduleNext () {
    this._kick(this.config.intervalMs || 1500)
  }

  // 构造带降级配置的请求参数
  _chatOpts (extra) {
    return {
      baseUrl: this.config.baseUrl,
      apiKey: this.config.apiKey,
      model: this.config.model,
      temperature: this.config.temperature,
      maxTokens: this.config.maxTokens,
      fallback: {
        baseUrl: this.config.fallbackBaseUrl,
        apiKey: this.config.fallbackApiKey,
        model: this.config.fallbackModel
      },
      ...extra
    }
  }

  async tick () {
    if (process.env.DEBUG_AI) console.log('[BRAIN_TICK]', { running: this.running, ticking: this.ticking, connected: this.agent.connected, busy: this.executor && this.executor.busy })
    if (!this.running || this.ticking || !this.agent.connected) {
      // 未就绪时保持循环，等 bot 连接后再决策
      this._scheduleNext()
      return
    }
    if (this.executor && this.executor.busy) {
      this._scheduleNext()
      return
    }
    this.ticking = true
    try {
      const snapshot = this.agent.snapshot()
      const messages = [
        { role: 'system', content: this.systemPrompt },
        { role: 'system', content: `当前目标：${this.goal}` },
        { role: 'user', content: JSON.stringify(this._userPayload(snapshot)) }
      ]

      const data = await chatCompletion({
        ...this._chatOpts(),
        messages,
        tools: TOOLS
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
    const payload = {
      worldState: snapshot,
      previousPlan: this.lastPlan.slice(0, 6),
      previousResults: this.lastResults.slice(-8),
      instruction: this._forceVary ? '上一次方案已重复多次，必须换一个动作或改变参数，禁止再次提交完全相同的计划。' : '从可用工具中选择下一步。若上一轮动作已成功，继续推进目标；若失败或状态未变化，换一个可执行方案。'
    }
    // 如果存在 3 分钟大纲，附加给短期决策参考
    if (this.longTermPlan && Date.now() - this.longTermPlanAt < this.planIntervalMs * 2) {
      payload.longTermPlan = {
        summary: this.longTermPlan.summary,
        priority: this.longTermPlan.priority,
        currentPhase: this._currentPhase(),
        plan: this.longTermPlan.plan,
        hints: this.longTermPlan.hints
      }
    }
    return payload
  }

  // 判断当前处于大纲的第几阶段（基于执行记录粗略判断）
  _currentPhase () {
    if (!this.longTermPlan || !this.longTermPlan.plan || !this.longTermPlan.plan.length) return null
    const plan = this.longTermPlan.plan
    const recent = this.lastResults.slice(-5).map(r => r.skill)
    // 简单启发：如果最近执行的动作与某阶段 focus 匹配，认为在该阶段
    for (let i = plan.length - 1; i >= 0; i--) {
      const focus = plan[i].focus || ''
      if (focus && recent.some(s => String(s).includes(String(focus).replace(/[^a-zA-Z]/g, '')))) {
        return { index: i, objective: plan[i].objective, focus: plan[i].focus }
      }
    }
    return { index: 0, objective: plan[0].objective, focus: plan[0].focus }
  }

  // 通用 AI 分析接口：其他情况（聊天响应、突发情况等）按需调用
  async analyze (userText, extraContext = {}) {
    const messages = [
      { role: 'system', content: this.systemPrompt },
      { role: 'system', content: `当前目标：${this.goal}` },
      { role: 'user', content: JSON.stringify({ ...extraContext, userText }) }
    ]
    try {
      const data = await chatCompletion({
        ...this._chatOpts(),
        messages,
        tools: TOOLS
      })
      return parseActions(data)
    } catch (e) {
      logger.warn('AI analyze 失败:', e.message)
      return []
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
