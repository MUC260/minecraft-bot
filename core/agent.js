const { EventEmitter } = require('events')
const mineflayer = require('mineflayer')
const { pathfinder, Movements } = require('mineflayer-pathfinder')
const logger = require('../lib/logger')
const observations = require('./observations')
const actions = require('./actions')

class BotAgent extends EventEmitter {
  constructor (config) {
    super()
    this.config = config
    this.bot = null
    this.connected = false
    this.chatBuffer = []
  }

  start () {
    const c = this.config
    logger.info(`连接 Minecraft ${c.host}:${c.port} (${c.username}, ${c.auth})`)
    this.bot = mineflayer.createBot({
      host: c.host,
      port: c.port,
      username: c.username,
      password: c.password || undefined,
      auth: c.auth || 'offline',
      version: c.version || undefined
    })
    this.bot.loadPlugin(pathfinder)
    this._wire()
    return this
  }

  _wire () {
    const bot = this.bot

    bot.once('spawn', () => {
      this.connected = true
      try {
        const mcData = require('minecraft-data')(bot.version)
        bot.pathfinder.setMovements(new Movements(bot, mcData))
      } catch (e) {
        logger.warn('pathfinder 初始化失败:', e.message)
      }
      logger.info(`已生成 ${bot.username}`)
      this.emit('spawn')
      this.emit('status', this.status())
    })

    bot.on('chat', (username, message) => {
      const item = { username, message, time: Date.now() }
      this.chatBuffer.push(item)
      if (this.chatBuffer.length > 100) this.chatBuffer.shift()
      this.emit('chat', item)
    })

    bot.on('kicked', (reason) => {
      this.connected = false
      logger.warn('被踢出:', String(reason))
      this.emit('status', this.status(String(reason)))
    })

    bot.on('end', (reason) => {
      this.connected = false
      logger.warn('连接断开:', String(reason))
      this.emit('status', this.status(String(reason)))
    })

    bot.on('error', (err) => {
      logger.error('机器人错误:', err.message)
      this.emit('log', { level: 'error', message: err.message })
    })

    bot.on('death', () => this.emit('log', { level: 'warn', message: '角色死亡' }))
  }

  snapshot () {
    return observations.build(this.bot, this.chatBuffer)
  }

  status (reason) {
    const snap = this.snapshot()
    return { connected: this.connected, reason: reason || null, bot: snap.bot }
  }

  async runAction (action) {
    const result = await actions.execute(this.bot, action)
    this.emit('log', { level: 'info', message: `执行动作 ${action.name}: ${result}` })
    return result
  }

  stop () {
    if (this.bot) {
      try { this.bot.quit() } catch {}
    }
    this.connected = false
  }
}

module.exports = BotAgent
