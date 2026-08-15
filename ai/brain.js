const fs = require('fs')
const path = require('path')
const logger = require('../lib/logger')
const { chatCompletion, parseActions } = require('./provider')
const { TOOLS } = require('./tools')

class Brain {
  constructor (agent, config) {
    this.agent = agent
    this.config = config
    this.running = false
    this.timer = null
    this.lastError = null
    this.goal = '自由行动：观察环境，合理互动。'
    this.systemPrompt = this._loadPrompt()
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
    this._schedule()
  }

  stop () {
    this.running = false
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    logger.info('AI 决策循环停止')
  }

  async _schedule () {
    if (!this.running) return
    this.timer = setTimeout(async () => {
      await this.tick()
      this._schedule()
    }, this.config.intervalMs || 1500)
  }

  async tick () {
    if (!this.running || !this.agent.connected) return
    const snapshot = this.agent.snapshot()
    const messages = [
      { role: 'system', content: this.systemPrompt },
      { role: 'system', content: `当前目标：${this.goal}` },
      { role: 'user', content: JSON.stringify(snapshot) }
    ]
    try {
      const data = await chatCompletion({
        baseUrl: this.config.baseUrl,
        apiKey: this.config.apiKey,
        model: this.config.model,
        messages,
        tools: TOOLS,
        temperature: this.config.temperature,
        maxTokens: this.config.maxTokens
      })
      const actions = parseActions(data)
      if (!actions.length) return
      for (const action of actions) {
        if (action.type === 'tool') {
          try {
            const result = await this.agent.runAction({ name: action.name, args: action.args })
            this.agent.emit('aiResult', { action: action.name, result })
          } catch (e) {
            this.agent.emit('aiResult', { action: action.name, error: e.message })
          }
        } else if (action.type === 'chat' && action.message) {
          await this.agent.runAction({ name: 'chat', args: { message: action.message } })
        }
      }
    } catch (e) {
      this.lastError = e.message
      logger.warn('AI 决策失败:', e.message)
    }
  }
}

module.exports = Brain
