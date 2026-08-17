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
    this._stopping = false
    this._reconnectTimer = null
    this._reconnectAttempts = 0
    this._lastEndReason = ''
    this._manualDisconnected = false
    this._connectWatchdog = null
    this._lastKnownVersion = String(this.mc.version || '').trim() || null
  }

  start () {
    this._stopping = false
    this._manualDisconnected = false
    this._reconnectAttempts = 0
    this._createBot()
    return this
  }

  _createBot () {
    const c = this.mc
    const requestedVersion = String(c.version || this._lastKnownVersion || '').trim() || undefined
    logger.info(`连接 Minecraft ${c.host}:${c.port} (${c.username}, ${c.auth}${requestedVersion ? `, ${requestedVersion}` : ', 自动版本'})`)
    let bot
    try {
      bot = mineflayer.createBot({
        host: c.host,
        port: c.port,
        username: c.username,
        password: c.password || undefined,
        auth: c.auth || 'offline',
        version: requestedVersion,
        checkTimeoutInterval: Math.max(10000, Number(c.connectTimeoutMs || 20000))
      })
    } catch (err) {
      const message = err && err.message ? err.message : String(err)
      logger.error(`创建机器人连接失败: ${message}`)
      this._scheduleReconnect('create-error:' + message)
      return this
    }
    this.bot = bot
    this._armConnectWatchdog(bot)
    bot.chatBuffer = this.chatBuffer
    bot.loadPlugin(pathfinder)

    this.pathfinderOwner = new PathfinderOwner(bot)
    bot.pathfinderOwner = this.pathfinderOwner
    this.executor = new SkillExecutor(bot, {
      pathfinderOwner: this.pathfinderOwner,
      skillTimeoutMs: this.config.executor?.skillTimeoutMs ?? 120000,
      resumeDebounceMs: this.config.reactive?.resumeDebounceMs ?? 1000,
      resumeGateTimeoutMs: this.config.executor?.resumeGateTimeoutMs ?? 30000
    })
    bot.skillExecutor = this.executor
    this.emit('executor', this.executor)
    this.reactive = new ReactiveController(bot, this.config.reactive || {}, {
      pathfinderOwner: this.pathfinderOwner,
      movements: this.movements
    })

    this._wire(bot)
    return this
  }

  _clearConnectWatchdog () {
    if (this._connectWatchdog) clearTimeout(this._connectWatchdog)
    this._connectWatchdog = null
  }

  _armConnectWatchdog (bot) {
    this._clearConnectWatchdog()
    const timeoutMs = Math.max(10000, Number(this.mc.connectTimeoutMs || 20000))
    this._connectWatchdog = setTimeout(() => {
      this._connectWatchdog = null
      if (this._stopping || this.bot !== bot || this.connected) return
      const reason = `connect-timeout:${timeoutMs}ms`
      logger.warn(`连接握手超时 ${this._connContext(bot)}，准备重试`)
      this._lastEndReason = reason
      this.emit('status', this.status(reason))
      this._scheduleReconnect(reason)
    }, timeoutMs)
    this._connectWatchdog.unref?.()
  }

  _connContext (bot) {
    const c = this.mc || {}
    const username = String(bot && bot.username ? bot.username : (c.username || '')).trim() || '?'
    const host = String(c.host || '?')
    const port = String(c.port || '?')
    return `[host=${host}:${port} user=${username} connected=${this.connected ? 1 : 0} reconnectAttempts=${this._reconnectAttempts}]`
  }

  _wire (bot) {
    bot.once('spawn', () => {
      if (this.bot !== bot) return
      this.connected = true
      this._clearConnectWatchdog()
      if (this._reconnectTimer) {
        clearTimeout(this._reconnectTimer)
        this._reconnectTimer = null
      }
      this._reconnectAttempts = 0
      if (bot.version) this._lastKnownVersion = String(bot.version)
      try {
        const mcData = require('minecraft-data')(bot.version)
        this.movements = new Movements(bot, mcData)
        bot.pathfinder.setMovements(this.movements)
        this.reactive.setMovements(this.movements)
      } catch (e) {
        logger.warn('pathfinder 初始化失败:', e.message)
      }
      this._schedulePluginAuth(bot)
      logger.info(`已生成 ${bot.username}`)
      this.emit('spawn')
      this.emit('status', this.status())
    })

    // 自动注册/登录：监听服务器系统消息，检测到 register/login 提示时自动响应
    const BOT_PASSWORD = this.config.mc?.password || this.config.mc?.registerPassword || 'NyxPass2026!'
    let registered = false
    let loginSent = false
    bot.on('message', (jsonMsg) => {
      try {
        const text = String(jsonMsg.toString() || '').toLowerCase()
        // 注册提示
        if (!registered && (text.includes('register') || text.includes('注册'))) {
          registered = true
          logger.info('检测到注册提示，自动发送 /register')
          bot.chat(`/register ${BOT_PASSWORD} ${BOT_PASSWORD}`)
          setTimeout(() => {
            if (!loginSent) {
              loginSent = true
              logger.info('发送 /login')
              bot.chat(`/login ${BOT_PASSWORD}`)
            }
          }, 1500)
        } else if (!loginSent && (text.includes('login') || text.includes('登录') || text.includes('please login'))) {
          loginSent = true
          logger.info('检测到登录提示，自动发送 /login')
          bot.chat(`/login ${BOT_PASSWORD}`)
        }
      } catch (e) {}
    })

    bot.on('chat', (username, message) => {
      if (this.bot !== bot) return
      const item = { username, message, time: Date.now() }
      this.chatBuffer.push(item)
      if (this.chatBuffer.length > 100) this.chatBuffer.shift()
      this.emit('chat', item)
    })

    bot.on('kicked', (reason) => {
      if (this.bot !== bot) return
      const text = String(reason)
      this.connected = false
      this._clearConnectWatchdog()
      this._lastEndReason = text
      logger.warn(`被踢出: ${text} ${this._connContext(bot)}`)
      this.emit('status', this.status(text))
      this._scheduleReconnect(text)
    })

    bot.on('end', (reason) => {
      if (this.bot !== bot) return
      const text = String(reason)
      this.connected = false
      this._clearConnectWatchdog()
      this._lastEndReason = text
      logger.warn(`连接断开: ${text} ${this._connContext(bot)}`)
      this.emit('status', this.status(text))
      this._scheduleReconnect(text)
    })

    bot.on('error', (err) => {
      if (this.bot !== bot) return
      const message = err && err.message ? err.message : String(err)
      logger.error(`机器人错误: ${message} ${this._connContext(bot)}`)
      if (!this.connected) {
        this._clearConnectWatchdog()
        this._lastEndReason = 'connect-error:' + message
        this._scheduleReconnect(this._lastEndReason)
      }
    })

    bot.on('death', () => {
      if (this.bot !== bot) return
      logger.warn(`角色死亡，等待服务器重生 ${this._connContext(bot)}`)
      this.emit('log', { level: 'warn', message: '角色死亡，等待自动重生' })
    })
    bot.on('reactive:state', (t) => this.emit('reactiveState', t))
    bot.on('reactive:log', (item) => this.emit('log', item))
  }

  _schedulePluginAuth (bot) {
    const c = this.mc
    const password = String(c.pluginPassword || '')
    if (!password) return
    const delay = Math.max(0, Number(c.pluginAuthDelayMs !== undefined ? c.pluginAuthDelayMs : 1500))
    setTimeout(() => {
      if (this._stopping || this.bot !== bot || !bot.chat) return
      const username = String(bot.username || c.username || '')
      const expand = (text) => String(text || '')
        .split('{password}').join(password)
        .split('{username}').join(username)
      const register = String(c.pluginRegisterCommands || '')
      const login = String(c.pluginLoginCommands || '')
      const commands = []
      for (const source of [register, login]) {
        for (const item of String(source).split('|')) {
          const cmd = item.trim()
          if (cmd) commands.push(expand(cmd))
        }
      }
      let i = 0
      const sendNext = () => {
        if (this._stopping || this.bot !== bot) return
        if (i >= commands.length) return
        const cmd = commands[i++]
        try { bot.chat(cmd) } catch (e) {
          logger.warn('插件服登录指令发送失败:', e.message)
        }
        logger.info(`插件服登录指令: ${cmd.split(password).join('***')}`)
        setTimeout(sendNext, 600)
      }
      sendNext()
    }, delay)
  }

  _scheduleReconnect (reason) {
    if (this._stopping || this._reconnectTimer) return
    const c = this.mc
    if (c.reconnect === false) return
    const maxAttempts = Number(c.reconnectMaxAttempts ?? -1)
    if (maxAttempts >= 0 && this._reconnectAttempts >= maxAttempts) {
      logger.warn('达到最大重连次数，停止重连')
      return
    }
    if (/emergency:critical-health/.test(reason) && !c.reconnectAfterEmergencyLogout) {
      logger.warn('紧急低血下线，按配置不自动重连')
      return
    }

    const base = Math.max(500, Number(c.reconnectBaseDelayMs ?? 2000))
    const max = Math.max(base, Number(c.reconnectMaxDelayMs ?? 15000))
    const delay = Math.min(max, base * Math.pow(2, this._reconnectAttempts))
    this._reconnectAttempts++

    logger.warn(`${delay}ms 后第 ${this._reconnectAttempts} 次重连...`)
    this.emit('log', { level: 'warn', message: `${delay}ms 后尝试重连 (${this._reconnectAttempts})` })
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null
      if (this._stopping || this.connected) return
      this._clearCurrentBot()
      this._createBot()
    }, delay)
  }

  snapshot () {
    return observations.build(this.bot, this.chatBuffer)
  }

  status (reason) {
    const snap = this.snapshot()
    return {
      connected: this.connected,
      ownerName: this.mc && this.mc.ownerName ? String(this.mc.ownerName) : '',
      reason: reason || null,
      reconnectAttempts: this._reconnectAttempts,
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

  _clearCurrentBot () {
    this._clearConnectWatchdog()
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer)
      this._reconnectTimer = null
    }
    if (this.executor) {
      try { this.executor.requestCurrentSkillAbort('connection-reset') } catch {}
      try { this.executor.clear() } catch {}
      try { this.executor.destroy() } catch {}
      this.executor = null
    }
    if (this.reactive) {
      this.reactive.shuttingDown = true
      try { this.reactive._releaseToken() } catch {}
      this.reactive = null
    }
    if (this.bot) {
      const bot = this.bot
      this.bot = null
      try { bot.quit('manual-disconnect') } catch {}
    }
    this.pathfinderOwner = null
    this.movements = null
    this.connected = false
  }

  disconnect (reason = 'manual-disconnect') {
    if (this._stopping && !this.connected && !this.bot) return this.status(reason)
    this._manualDisconnected = true
    this._stopping = true
    this._clearCurrentBot()
    this._lastEndReason = reason
    logger.info('\u624b\u52a8\u65ad\u5f00\u670d\u52a1\u5668')
    this.emit('status', this.status(reason))
    return this.status(reason)
  }

  connect () {
    if (this.connected && this.bot) return this.status()
    this._manualDisconnected = false
    this._stopping = true
    this._clearCurrentBot()
    this._stopping = false
    this._reconnectAttempts = 0
    logger.info('\u624b\u52a8\u8fde\u63a5\u670d\u52a1\u5668')
    this._createBot()
    return this.status()
  }

  stop () {
    this._stopping = true
    this._manualDisconnected = true
    this._clearCurrentBot()
  }

}

module.exports = BotAgent
