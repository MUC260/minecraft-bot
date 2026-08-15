const config = require('./lib/config')
const logger = require('./lib/logger')
const BotAgent = require('./core/agent')
const Brain = require('./ai/brain')
const api = require('./api/server')

async function main () {
  logger.info('Minecraft AI Bot 框架启动中...')

  const agent = new BotAgent(config.mc).start()
  const brain = new Brain(agent, config.ai)

  if (config.ai.enabled) {
    if (!config.ai.apiKey) {
      logger.warn('未配置 AI_API_KEY，AI 决策已禁用（仍可通过面板手动控制）')
    } else {
      brain.start()
    }
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
