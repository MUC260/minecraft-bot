const path = require('path')
const config = require('./lib/config')
const logger = require('./lib/logger')
const BotAgent = require('./core/agent')
const Brain = require('./ai/brain')
const ChatCommander = require('./core/chatCommander')
const api = require('./api/server')

logger.init(config.logging)

async function main () {
  logger.info('Minecraft AI Bot 框架启动中...')

  const agent = new BotAgent(config).start()
  const brain = new Brain(agent, {
    ...config.ai,
    memoryFile: config.ai.memoryFile || path.join(config.root, 'logs', 'brain-memory.json')
  })
  const commander = new ChatCommander(agent, brain, config)

  logger.on('log', (item) => agent.emit('log', item))

  const attachExecutorListeners = (executor) => {
    if (!executor) return
    executor.on('skill:start', ({ call }) => {
      agent.emit('log', { level: 'info', message: `技能开始 ${call.name}` })
    })
    executor.on('skill:result', ({ call, result }) => {
      if (result.ok) agent.emit('log', { level: 'info', message: `技能完成 ${call.name}: ${result.reason}` })
      else agent.emit('log', { level: 'warn', message: `技能失败 ${call.name}: ${result.reason}` })
    })
    executor.on('queue:failure', ({ call, result }) => {
      agent.emit('log', { level: 'warn', message: `动作队列失败于 ${call?.name || 'unknown'}: ${result?.reason}` })
    })
  }
  attachExecutorListeners(agent.executor)
  agent.on('executor', (executor) => {
    attachExecutorListeners(executor)
    brain.setExecutor(executor)
  })

  if (config.ai.enabled) {
    if (!config.ai.apiKey || /^sk-xxx$/i.test(String(config.ai.apiKey))) {
      logger.warn('未配置有效 AI_API_KEY，进入离线自主模式（仍可响应聊天指令）')
    }
    brain.start()
  }

  api.start(agent, brain, config)

  const shutdown = () => {
    logger.info('正在关闭...')
    brain.stop()
    agent.stop()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch((err) => {
  logger.error('启动失败:', err.message)
  process.exit(1)
})
