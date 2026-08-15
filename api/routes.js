const express = require('express')
const logger = require('../lib/logger')

module.exports = function createRouter (agent, brain, config) {
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

  router.post('/actions', async (req, res) => {
    try {
      const result = await agent.runAction(req.body || {})
      res.json({ ok: true, result })
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message })
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

  router.post('/ai/tick', async (req, res) => {
    try {
      await brain.tick()
      res.json({ ok: true })
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
    return status
  }

  return router
}
