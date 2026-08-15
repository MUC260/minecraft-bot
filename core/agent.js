const EventEmitter = require('events')
const mineflayer = require('mineflayer')
const { pathfinder, Movements } = require('mineflayer-pathfinder')
const observations = require('./observations')
const actions = require('./actions')
const PathfinderOwner = require('./pathfinderOwner')
const SkillExecutor = require('./executor')
const ReactiveController = require('./reactive')
const logger = require('../lib/logger')

class BotAgent extends EventEmitter {
  constructor (config = {}) {
    super()
    this.config = config
    this.mc = config.mc || config
    this.bot = null
    this.connected = false
    this.chatBuffer = []
    this.pathfinderOwner = null
    this.executor = null
    this.reactive = null
    this.movements = null
  }

  start () {
    const c = this.mc
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

    this.pathfinderOwner = new PathfinderOwner(this.bot)
    this.executor = new SkillExecutor(this.bot, {
      pathfinderOwner: this.pathfinderOwner,
      skillTimeoutMs: this.config.executor?.skillTimeoutMs ?? 120000,
      resumeDebounceMs: this.config.reactive?.resumeDebounceMs ?? 1000,
      resumeGateTimeoutMs: this.config.executor?.resumeGateTimeoutMs ?? 30000
    })
    this.bot.skillExecutor = this.executor
    this.reactive = new ReactiveController(this.bot, this.config.reactive || {}, {
      pathfinderOwner: this.pathfinderOwner,
      movements: this.movements
    })

    this._wire()
    return this
  }

  _wire () {
    const bot = this.bot

    bot.once('spawn', () => {
      this.connected = true
      try {
        const mcData = require('minecraft-data')(bot.version)
        this.movements = new Movements(bot, mcData)
        bot.pathfinder.setMovements(this.movements)
        this.reactive.setMovements(this.movements)
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
    bot.on('reactive:state', (t) => this.emit('reactiveState', t))
    bot.on('reactive:log', (item) => this.emit('log', item))
  }

  snapshot () {
    return observations.build(this.bot, this.chatBuffer)
  }

  status (reason) {
    const snap = this.snapshot()
    return {
      connected: this.connected,
      reason: reason || null,
      bot: snap.bot,
      reactive: this.reactive ? this.reactive.status() : null,
      executorBusy: this.executor ? this.executor.busy : false
    }
  }

  async runAction (action) {
    if (this.executor) {
      this.executor.enqueue(action)
      return '已加入动作队列'
    }
    const result = await actions.execute(this.bot, action)
    this.emit('log', { level: 'info', message: `执行动作 ${action.name}: ${result}` })
    return result
  }

  runActionDirect (action) {
    return actions.execute(this.bot, action)
  }

  stop () {
    if (this.executor) {
      try { this.executor.clear() } catch {}
    }
    if (this.reactive) {
      this.reactive.shuttingDown = true
      this.reactive._releaseToken()
    }
    if (this.bot) {
      try { this.bot.quit() } catch {}
    }
    this.connected = false
  }
}

module.exports = BotAgent