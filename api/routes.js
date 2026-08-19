const express = require('express')
const logger = require('../lib/logger')
const { listModels } = require('../ai/provider')

module.exports = function createRouter (agent, brain, config, commander) {
  const router = express.Router()
  const notify = () => agent.emit('status', agent.status())

  router.get('/status', (req, res) => {
    res.json(makeStatus())
  })

  router.get('/observations', (req, res) => {
    res.json(agent.snapshot())
  })

  router.get('/logs', (req, res) => {
    try {
      const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 300, 1), 2000)
      const logs = logger.readTail(limit)
      res.json({
        ok: true,
        logs,
        path: logger.getPath(),
        count: logs.length
      })
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message })
    }
  })

  router.get('/config', (req, res) => {
    try {
      res.json(config.getConfig ? config.getConfig() : config)
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message })
    }
  })

  router.put('/config', (req, res) => {
    try {
      const saved = config.saveConfig ? config.saveConfig(req.body || {}) : (req.body || {})
      res.json({ ok: true, config: saved })
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message })
    }
  })

  router.post('/models', async (req, res) => {
    try {
      const body = req.body || {}
      const baseUrl = String(body.baseUrl || config.ai.baseUrl || '').trim()
      const apiKey = body.apiKey != null ? String(body.apiKey) : config.ai.apiKey
      if (!baseUrl) throw new Error('请先填写 API 地址')
      const models = await listModels({ baseUrl, apiKey })
      res.json({ ok: true, models })
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message })
    }
  })

  router.post('/actions', async (req, res) => {
    try {
      const result = await agent.runAction(req.body || {})
      res.json({ ok: true, result })
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message })
    }
  })

  router.post('/bot/connect', (req, res) => {
    try {
      const status = agent.connect()
      notify()
      res.json({ ok: true, status })
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message })
    }
  })

  router.post('/bot/disconnect', (req, res) => {
    try {
      const status = agent.disconnect('manual-disconnect')
      notify()
      res.json({ ok: true, status })
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message })
    }
  })

  router.post('/ai/start', (req, res) => {
    brain.start()
    notify()
    res.json({ ok: true, running: brain.running })
  })

  router.post('/ai/stop', (req, res) => {
    brain.stop()
    notify()
    res.json({ ok: true, running: brain.running })
  })

  router.post('/ai/goal', (req, res) => {
    const goal = brain.setGoal(req.body && req.body.goal)
    notify()
    res.json({ ok: true, goal })
  })

  router.get('/ai/memory', (req, res) => {
    try {
      res.json({ ok: true, memory: brain.getMemory ? brain.getMemory() : null })
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message })
    }
  })

  router.post('/ai/memory/reset', (req, res) => {
    try {
      const memory = brain.resetMemory ? brain.resetMemory() : null
      notify()
      res.json({ ok: true, memory })
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message })
    }
  })

  router.post('/ai/tick', async (req, res) => {
    try {
      await brain.tick()
      res.json({ ok: true })
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message })
    }
  })

  // ── AI 成员管理 + 唤醒词配置 ──────────────────────────────

  /** 获取当前 AI 唤醒词和成员白名单 */
  router.get('/ai/config', (req, res) => {
    try {
      const aiCfg = config.getConfig ? config.getConfig().ai : config.ai || {}
      res.json({
        ok: true,
        aiMention: String(aiCfg.aiMention || '@ai'),
        aiMembers: Array.isArray(aiCfg.aiMembers) ? aiCfg.aiMembers : []
      })
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message })
    }
  })

  /** 更新 AI 唤醒词和成员白名单 */
  router.put('/ai/config', (req, res) => {
    try {
      const body = req.body || {}
      const patch = { ai: {} }
      if (body.aiMention !== undefined) patch.ai.aiMention = String(body.aiMention || '@ai').trim() || '@ai'
      if (body.aiMembers !== undefined) patch.ai.aiMembers = Array.isArray(body.aiMembers) ? body.aiMembers : []

      const saved = config.saveConfig ? config.saveConfig(patch) : config
      const newAi = saved && saved.ai ? saved.ai : {}

      // 同步到 commander 运行时配置
      if (commander && typeof commander.updateAiConfig === 'function') {
        commander.updateAiConfig(newAi)
      }

      res.json({
        ok: true,
        aiMention: String(newAi.aiMention || '@ai'),
        aiMembers: Array.isArray(newAi.aiMembers) ? newAi.aiMembers : []
      })
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message })
    }
  })

  /** 获取当前在线玩家列表（用于便捷勾选） */
  router.get('/ai/players', (req, res) => {
    try {
      const bot = agent && agent.bot
      const players = bot && bot.players ? Object.keys(bot.players) : []
      const online = players.filter(p => {
        if (!bot) return false
        const player = bot.players[p]
        return player && player.username !== bot.username
      })
      res.json({ ok: true, players: online })
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message })
    }
  })

  function makeStatus () {
    const status = agent.status()
    status.aiRunning = brain.running
    status.aiEnabled = config.ai.enabled && !!config.ai.apiKey
    status.lastError = brain.lastError || null
    status.goal = brain.goal
    status.plan = brain.plan || null
    status.memory = brain.getMemory ? brain.getMemory() : null
    return status
  }

  return router
}
