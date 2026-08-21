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
  const mountBrain = (bot) => { if (bot) bot.brain = brain }
  mountBrain(agent.bot)

  logger.on('log', (item) => agent.emit('log', item))

  const attachExecutorListeners = (executor) => {
    if (!executor) return
    executor.on('skill:start', ({ call }) => {
      logger.info(`技能开始 ${call.name} ${JSON.stringify(call.args || {})}`)
    })
    executor.on('skill:result', ({ call, result }) => {
      const message = result.ok
        ? `技能完成 ${call.name}: ${result.reason}`
        : `技能失败 ${call.name}: ${result.reason}`
      if (result.ok) logger.info(message)
      else logger.warn(message)
      if (call && call.announce && agent.connected && agent.bot && typeof agent.bot.chat === 'function') {
        try { agent.bot.chat(String(result.ok ? `完成：${result.reason}` : `任务遇到问题：${result.reason}`).slice(0, 180)) } catch {}
      }
    })
    executor.on('queue:failure', ({ call, result }) => {
      logger.warn(`动作队列失败于 ${call?.name || 'unknown'}: ${result?.reason}`)
    })
    executor.on('skill:stuck', ({ call, elapsedMs }) => {
      logger.warn(`技能疑似卡住 ${call?.name || 'unknown'}，已运行 ${elapsedMs}ms`)
    })
  }
  attachExecutorListeners(agent.executor)
  agent.on('executor', (executor) => {
    attachExecutorListeners(executor)
    brain.setExecutor(executor)
    mountBrain(agent.bot)
  })
  // 机器人连接成功时，同步唤醒词为 @机器人名
  agent.on('commanderReady', (username) => {
    commander.onBotReady(username)
    logger.info(`唤醒词已同步为 @${username}`)
  })

  if (config.ai.enabled) {
    if (!config.ai.apiKey || /^sk-xxx$/i.test(String(config.ai.apiKey))) {
      logger.warn('未配置有效 AI_API_KEY，进入离线自主模式（仍可响应聊天指令）')
    }
    brain.start()
  }

  api.start(agent, brain, config, commander)

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
