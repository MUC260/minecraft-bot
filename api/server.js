const http = require('http')
const path = require('path')
const express = require('express')
const { WebSocketServer } = require('ws')
const logger = require('../lib/logger')
const createRouter = require('./routes')

function start (agent, brain, config) {
  const app = express()
  app.use(express.json())
  app.use('/api', createRouter(agent, brain, config))
  app.use(express.static(config.uiDir))

  const server = http.createServer(app)
  const wss = new WebSocketServer({ server, path: '/ws' })

  const broadcast = (obj) => {
    const data = JSON.stringify(obj)
    for (const client of wss.clients) {
      if (client.readyState === 1) client.send(data)
    }
  }

  const makeStatus = () => ({
    ...agent.status(),
    aiRunning: brain.running,
    aiEnabled: config.ai.enabled && !!config.ai.apiKey,
    lastError: brain.lastError || null,
    goal: brain.goal,
    plan: brain.plan || null,
    memory: brain.getMemory ? brain.getMemory() : null
  })

  agent.on('status', () => broadcast({ type: 'status', data: makeStatus() }))
  agent.on('chat', (item) => broadcast({ type: 'chat', data: item }))
  agent.on('log', (item) => broadcast({ type: 'log', data: item }))
  agent.on('aiResult', (item) => broadcast({ type: 'aiResult', data: item }))

  const port = config.api.port
  const host = config.api.host
  server.listen(port, host, () => {
    logger.info(`控制面板: http://${host}:${port}`)
  })

  setInterval(() => {
    if (agent.connected) broadcast({ type: 'observation', data: agent.snapshot() })
  }, 1000)

  return { app, server, wss }
}

module.exports = { start }
