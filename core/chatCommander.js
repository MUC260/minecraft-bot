const logger = require('../lib/logger')

const DIRECT_COMMANDERS = []

function normalize (text) {
  return String(text || '').trim().replace(/^[!/@#]+/, '').replace(/\s+/g, '').toLowerCase()
}

function compact (text) {
  return String(text || '').trim().replace(/\s+/g, '').toLowerCase()
}

const MOB_ALIASES = {
  僵尸: 'zombie',
  僵尸猪人: 'zombified_piglin',
  僵尸猪灵: 'zombified_piglin',
  骷髅: 'skeleton',
  小白: 'skeleton',
  苦力怕: 'creeper',
  蜘蛛: 'spider',
  洞穴蜘蛛: 'cave_spider',
  末影人: 'enderman',
  末影螨: 'endermite',
  女巫: 'witch',
  掠夺者: 'pillager',
  卫道士: 'vindicator',
  唤魔者: 'evoker',
  劫掠兽: 'ravager',
  幻翼: 'phantom',
  溺尸: 'drowned',
  流浪者: 'stray',
  烈焰人: 'blaze',
  恶魂: 'ghast',
  守卫者: 'guardian',
  远古守卫者: 'elder_guardian',
  潜影贝: 'shulker',
  蠹虫: 'silverfish',
  僵尸疣猪兽: 'zoglin',
  猪灵: 'piglin',
  猪灵蛮兵: 'piglin_brute',
  凋灵骷髅: 'wither_skeleton'
}

const ORE_ALIASES = {
  钻石矿石: 'diamond_ore',
  钻石: 'diamond_ore',
  钻: 'diamond_ore',
  铁矿石: 'iron_ore',
  铁矿: 'iron_ore',
  铁: 'iron_ore',
  煤矿石: 'coal_ore',
  煤矿: 'coal_ore',
  煤: 'coal_ore',
  金矿石: 'gold_ore',
  金矿: 'gold_ore',
  金子: 'gold_ore',
  黄金: 'gold_ore',
  金: 'gold_ore',
  青金石矿石: 'lapis_ore',
  青金石: 'lapis_ore',
  红石矿石: 'redstone_ore',
  红石: 'redstone_ore',
  铜矿石: 'copper_ore',
  铜矿: 'copper_ore',
  铜: 'copper_ore',
  绿宝石矿石: 'emerald_ore',
  绿宝石: 'emerald_ore'
}

const ORE_NAME_RE = /(?:找|挖|开采|采集|去挖|去找)(?:一下|一些)?(?:(\d+|[零〇一二两三四五六七八九十百]+)(?:个|块|颗)?)?(?:的)?(钻石矿石|钻石|钻|铁矿石|铁矿|铁|煤矿石|煤矿|煤|金矿石|金矿|金子|黄金|金|青金石矿石|青金石|红石矿石|红石|铜矿石|铜矿|铜|绿宝石矿石|绿宝石)/

function chineseNumber (value) {
  const text = String(value || '').trim()
  if (!text) return null
  if (/^\d+$/.test(text)) return Number(text)
  const digits = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }
  if (text === '十') return 10
  if (text === '百') return 100
  let total = 0
  let current = 0
  for (const ch of text) {
    if (Object.prototype.hasOwnProperty.call(digits, ch)) {
      current = digits[ch]
    } else if (ch === '十') {
      total += (current || 1) * 10
      current = 0
    } else if (ch === '百') {
      total += (current || 1) * 100
      current = 0
    } else {
      return null
    }
  }
  return total + current
}

class ChatCommander {
  constructor (agent, brain, config) {
    this.agent = agent
    this.brain = brain
    this.config = config
    this.mc = (config && (config.mc || config)) || {}
    this.ownerNames = this._ownerNames(this.mc.ownerName)
    this._lastCommandAt = new Map()
    this.aiCommands = this.mc.aiCommands !== false
    this.commandPrefix = this.mc.commandPrefix == null ? '!' : String(this.mc.commandPrefix)
    this.agent.on('chat', (item) => this.onChat(item))
  }

  _commandText (raw) {
    const text = String(raw || '').trim()
    if (!text) return null
    const prefix = this.commandPrefix == null ? '' : String(this.commandPrefix)
    if (!prefix) return text
    const norm = (ch) => ch === '！' ? '!' : ch
    const accepted = new Set(Array.from(prefix).map(norm))
    if (!accepted.has(norm(text.charAt(0)))) return null
    const command = text.slice(1).trim()
    return command || null
  }

  _ownerNames (value) {
    return String(value || '')
      .split(',')
      .map(s => s.trim().toLowerCase())
      .filter(Boolean)
  }

  isOwner (username) {
    const name = String(username || '').trim().toLowerCase()
    if (!name) return false
    if (this.agent.bot && String(this.agent.bot.username || '').toLowerCase() === name) return false
    // If no owner is configured, treat every human player as owner so chat commands
    // still work after first launch instead of silently ignoring everyone.
    if (this.ownerNames.length === 0) return true
    return this.ownerNames.includes(name)
  }

  onChat (item) {
    if (!item || !this.agent.connected || !this.agent.bot) return
    if (!this.isOwner(item.username)) return
    const raw = String(item.message || '').trim()
    if (!raw) return
    const prefixedCommand = this._commandText(raw)
    const prefix = this.commandPrefix == null ? '' : String(this.commandPrefix)
    const hasExplicitPrefix = prefixedCommand !== null
    const command = hasExplicitPrefix ? prefixedCommand : raw

    // The same owner chat event can arrive more than once from game/UI relays.
    const dedupeKey = String(item.username || '').toLowerCase() + '\u0000' + raw
    const now = Date.now()
    const last = this._lastCommandAt.get(dedupeKey) || 0
    if (now - last < 1500) return
    this._lastCommandAt.set(dedupeKey, now)
    if (this._lastCommandAt.size > 200) {
      const cutoff = now - 60000
      for (const [key, ts] of this._lastCommandAt) {
        if (ts < cutoff) this._lastCommandAt.delete(key)
      }
    }

    const parsed = this.parse(command, item.username, { allowGoalFallback: hasExplicitPrefix || !prefix })
    if (!parsed) return

    item.handled = true
    logger.info(`\u4e3b\u4eba\u6307\u4ee4 ${item.username}: ${raw}`)
    this._ack(parsed.ack || (parsed.action ? `收到，开始执行：${command}` : `收到任务：${command}`))

    if (parsed.action) {
      this.brain.setGoal(parsed.goal)
      this._dispatchAction(parsed.action)
      return
    }

    this.brain.clearFollow()
    this.brain.setHold(false)
    this.brain.setGoal(parsed.goal)
    if (this.brain.nudge) this.brain.nudge(120)
  }


  _ack (message) {
    const bot = this.agent && this.agent.bot
    const text = String(message || '').trim()
    if (!bot || !text || typeof bot.chat !== 'function') return
    try { bot.chat(text.slice(0, 180)) } catch {}
  }

  _dispatchAction (action) {
    if (!action || !this.agent.executor) return
    const executor = this.agent.executor
    executor.clear()
    if (executor.currentCall) executor.requestCurrentSkillAbort('user command')

    const call = { name: action.name, args: action.args || {}, announce: true, requester: 'owner' }
    if (this.brain && typeof this.brain.alignPlanToAction === 'function') {
      this.brain.alignPlanToAction(call)
    }
    const remember = (name, args) => {
      if (this.brain && typeof this.brain.recordAction === 'function') {
        this.brain.recordAction({ name, args: args || {} })
      }
    }

    if (call.name === 'stop') {
      this.brain.setHold(true)
      remember('stop', call.args)
      executor.enqueue({ ...call, timeoutMs: 5000 })
      return
    }

    if (call.name === 'follow') {
      const username = String(call.args.username || '').trim()
      if (!username) return
      this.brain.setFollow(username, Number(call.args.distance || 2))
      remember('follow', call.args)
      executor.enqueue({ ...call, timeoutMs: 86400000 })
      return
    }

    if (call.name === 'goto' && call.args.username) {
      const username = String(call.args.username || '').trim()
      const distance = Number(call.args.distance || 2)
      this.brain.setFollow(username, distance)
      remember('follow', { username, distance })
      executor.enqueue({ name: 'follow', args: { username, distance }, timeoutMs: 86400000 })
      return
    }

    this.brain.clearFollow()
    // One-shot commands return to normal autonomous behavior after finishing.
    // Only the explicit stop/standby command parks the bot indefinitely.
    this.brain.setHold(false)
    remember(call.name, call.args)
    const longBuild = ['buildHouse', 'buildTower', 'buildBridge', 'buildWall'].includes(call.name)
    const countedMining = call.name === 'mineOreVein' && Number(call.args.targetCount || call.args.count) > 0
    executor.enqueue({ ...call, timeoutMs: countedMining ? 600000 : (longBuild ? 240000 : undefined) })
  }

  parse (raw, senderUsername, options = {}) {
    const text = compact(raw)
    const normalized = normalize(raw)
    if (!text) return null

    if (/^(停止|停下|站住|别动|不要动|别乱动|站住别动|原地待命|待机|stop|done|complete|finish)/.test(text) || /^(完成|完成了|好了|可以了|结束|完毕)$/.test(text)) {
      return {
        action: { name: 'stop', args: {} },
        goal: '停止当前动作，原地待命。'
      }
    }

    if (/砍(树|木头|木)|伐木|chop|choptree|chopwood|cutwood/.test(text)) {
      return {
        action: { name: 'chopTree', args: {} },
        goal: '持续寻找并砍伐树木，收集木材，直到我说停止或完成。'
      }
    }

    const oreMatch = text.match(ORE_NAME_RE)
    if (oreMatch) {
      const requested = oreMatch[2]
      const oreName = ORE_ALIASES[requested]
      const count = chineseNumber(oreMatch[1])
      if (oreName) {
        const args = { name: oreName }
        if (Number.isFinite(count) && count > 0) {
          args.targetCount = Math.max(1, Math.min(256, Math.floor(count)))
        }
        return {
          action: { name: 'mineOreVein', args },
          goal: Number.isFinite(count) && count > 0
            ? `开采并拾取 ${args.targetCount} 个${requested}，完成前持续推进。`
            : `持续寻找并开采${requested}，直到我说停止或完成。`,
          ack: Number.isFinite(count) && count > 0
            ? `收到，开始挖 ${args.targetCount} 个${requested}。`
            : `收到，开始寻找并开采${requested}。`
        }
      }
    }

    if (/挖(矿|石头|矿石)|采矿|下矿|mine|mineore|minestone/.test(text)) {
      return {
        action: { name: 'mineOreVein', args: {} },
        goal: '持续寻找并开采矿石，直到我说停止或完成。',
        ack: '收到，开始寻找矿石。'
      }
    }

    if (/^(停止|停下|站住|别动|不要动|别乱动|站住别动|原地待命|待机|stop|done|complete|finish)/.test(text) || /^(完成|完成了|好了|可以了|结束|完毕)$/.test(text)) {
      return {
        action: { name: 'stop', args: {} },
        goal: '停止当前动作，原地待命。'
      }
    }

    if (/捡|拾取|收集|捡东西|捡掉落|拾起|捡起来|捡物品|collect|pickup|pickupitems|collectitems/.test(text)) {
      return {
        action: { name: 'collect', args: { radius: 12 } },
        goal: '持续拾取附近掉落物和可采集物，直到我说停止或完成。'
      }
    }

    if (/跟随我|跟我|跟我走|跟着我|跟住我|跟紧我|跟上我|跟我来|跟我一起|随我|来我这|来我这边|到我这里|到我这边|来这边|过来|过来一下|followme|cometome|comehere|comewithme|stickwithme/.test(text)) {
      const username = String(senderUsername || '').trim()
      return {
        action: { name: 'follow', args: { username, distance: 2 } },
        goal: '跟随主人 ' + username + '，保持跟随，直到我说停止。',
        ack: '收到，开始持续跟随你。'
      }
    }

    if (/保护我|保护我周围|保护|defendme|protectme/.test(text)) {
      const username = String(senderUsername || '').trim()
      return {
        action: { name: 'protect', args: { username, radius: 12 } },
        goal: '保护主人 ' + username + '。'
      }
    }

    if (/盖房子|盖房|建房子|建个房子|造房子|造个房子|盖个房|盖屋子|搭房子|搭个房子|建屋|盖屋|修房子|buildhouse|buildahouse|buildmeahouse/.test(text)) {
      return {
        action: { name: 'buildHouse', args: {} },
        goal: '盖房子任务已开始，我会在附近找个位置，用背包里的建材搭一个房子。'
      }
    }

    if (/建塔|造塔|盖塔|搭塔|建个塔|造个塔|盖个塔|搭个塔|高塔|瞭望塔|buildtower|buildatower/.test(text)) {
      return {
        action: { name: 'buildTower', args: {} },
        goal: '建塔任务已开始，我会在附近用背包里的建材搭一个塔。'
      }
    }

    if (/搭桥|造桥|建桥|架桥|修桥|搭个桥|造个桥|建个桥|修个桥|buildbridge|buildabridge/.test(text)) {
      return {
        action: { name: 'buildBridge', args: {} },
        goal: '搭桥任务已开始，我会从脚下朝前方方向铺一条桥。'
      }
    }

    if (/造墙|建墙|砌墙|搭墙|围墙|修墙|修围墙|围起来|围一圈|buildwall|buildawall/.test(text)) {
      return {
        action: { name: 'buildWall', args: {} },
        goal: '造墙任务已开始，我会在前面搭一面墙。'
      }
    }

    if (/\u770b\u770b\u80cc\u5305|\u68c0\u67e5\u80cc\u5305|\u80cc\u5305\u91cc\u6709\u4ec0\u4e48|\u6709\u4ec0\u4e48\u4e1c\u897f|\u7269\u54c1\u680f|\u80cc\u5305|inventory|checkinventory|listitems/.test(text)) {
      return {
        action: { name: 'inventory', args: { chat: true } },
        goal: '\u67e5\u770b\u5e76\u62a5\u544a\u80cc\u5305\u7269\u54c1\u3002'
      }
    }

    if (/\u505a\u5de5\u4f5c\u53f0|\u5236\u4f5c\u5de5\u4f5c\u53f0|\u5408\u6210\u5de5\u4f5c\u53f0|\u9020\u5de5\u4f5c\u53f0|\u5de5\u4f5c\u53f0|craftingtable|crafttable/.test(text)) {
      return {
        action: { name: 'craft', args: { name: 'crafting_table' } },
        goal: '\u5236\u4f5c\u5e76\u653e\u7f6e\u4e00\u4e2a\u5de5\u4f5c\u53f0\u3002'
      }
    }

    if (/\u5236\u4f5c\u88c5\u5907|\u505a\u88c5\u5907|\u5408\u6210\u88c5\u5907|\u9020\u88c5\u5907|\u51c6\u5907\u88c5\u5907|\u7a7f\u88c5\u5907|\u51c6\u5907\u5de5\u5177|\u5236\u4f5c\u5de5\u5177|\u505a\u5de5\u5177|\u5408\u6210\u5de5\u5177|\u9020\u5de5\u5177|craftgear|craftarmor|gearup|crafttools/.test(text)) {
      return {
        action: { name: 'craftGear', args: {} },
        goal: '\u5236\u4f5c\u57fa\u7840\u5de5\u5177\u3001\u6b66\u5668\u548c\u88c5\u5907\uff0c\u7136\u540e\u81ea\u52a8\u88c5\u5907\u3002'
      }
    }

    const craftMatch = normalized.match(/^(?:\u5236\u4f5c|\u5408\u6210|\u6253\u9020|\u505a|\u9020)(.+)$/)
    if (craftMatch) {
      const targetRaw = String(craftMatch[1] || '').trim()
      return {
        action: { name: 'craft', args: targetRaw ? { name: targetRaw } : {} },
        goal: '\u5236\u4f5c ' + (targetRaw || '\u6307\u5b9a\u7269\u54c1') + '\uff0c\u6750\u6599\u4e0d\u8db3\u65f6\u5148\u91c7\u96c6\u6728\u6750\u3002'
      }
    }

    const attack = normalized.match(/^(?:攻击|打|杀|干掉|去打|去打一下|去攻击|attack|kill)(.+)$/)
    if (attack) {
      const targetRaw = String(attack[1] || '').trim()
      const aliasKey = Object.keys(MOB_ALIASES).find(k => targetRaw.includes(k))
      const target = aliasKey ? MOB_ALIASES[aliasKey] : targetRaw
      return {
        action: { name: 'hunt', args: target ? { name: target } : {} },
        goal: '去攻击 ' + (target || '目标') + '，打完后原地待命。'
      }
    }

    // 普通聊天只触发上面的明确技能；带前缀的未知命令才交给 AI。
    if (options.allowGoalFallback === false) return null
    return { goal: '主人指令：' + raw, ack: '收到，我正在规划这个任务。' }
  }
}

module.exports = ChatCommander
