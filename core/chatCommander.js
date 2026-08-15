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

class ChatCommander {
  constructor (agent, brain, config) {
    this.agent = agent
    this.brain = brain
    this.config = config
    this.mc = (config && (config.mc || config)) || {}
    this.ownerNames = this._ownerNames(this.mc.ownerName)
    this.agent.on('chat', (item) => this.onChat(item))
  }

  _ownerNames (value) {
    return String(value || '')
      .split(',')
      .map(s => s.trim().toLowerCase())
      .filter(Boolean)
  }

  isOwner (username) {
    const name = String(username || '').trim().toLowerCase()
    if (!name || this.ownerNames.length === 0) return false
    if (this.agent.bot && String(this.agent.bot.username || '').toLowerCase() === name) return false
    return this.ownerNames.includes(name)
  }

  onChat (item) {
    if (!item || !this.agent.connected || !this.agent.bot) return
    if (!this.isOwner(item.username)) return
    const raw = String(item.message || '').trim()
    if (!raw) return

    const parsed = this.parse(raw, item.username)
    if (!parsed) return

    logger.info(`主人指令 ${item.username}: ${raw}`)
    this.agent.emit('log', { level: 'info', message: `主人指令 ${item.username}: ${raw}` })

    if (parsed.action) {
      this.brain.setGoal(parsed.goal)
      if (this.agent.executor) this.agent.executor.clear()
      if (this.agent.executor) this.agent.executor.enqueue(parsed.action)
      return
    }

    this.brain.setGoal(parsed.goal)
    if (this.brain.nudge) this.brain.nudge(120)
  }

  parse (raw, senderUsername) {
    const text = compact(raw)
    const normalized = normalize(raw)
    if (!text) return null

    if (/砍(树|木头|木)|伐木/.test(text)) {
      return {
        action: { name: 'chopTree', args: {} },
        goal: '去附近砍树，砍完原地待命等下一句指令。'
      }
    }

    if (/挖(矿|石头|矿石)|采矿|下矿/.test(text)) {
      return {
        action: { name: 'mineOreVein', args: {} },
        goal: '去附近采矿，采完原地待命等下一句指令。'
      }
    }

    if (/停止|停下|站住|别动|不要动|原地待命|待机/.test(text)) {
      return {
        action: { name: 'stop', args: {} },
        goal: '停止当前动作，原地待命。'
      }
    }

    if (/跟我走|跟着我|跟上我|来我这|到我这里|过来|过来一下|来我这边/.test(text)) {
      const username = String(senderUsername || '').trim()
      return {
        action: { name: 'goto', args: { username, distance: 2 } },
        goal: `跟随主人 ${username}，到身边后原地待命。`
      }
    }

    if (/保护我|保护我周围|保护/.test(text)) {
      const username = String(senderUsername || '').trim()
      return {
        action: { name: 'protect', args: { username, radius: 12 } },
        goal: `保护主人 ${username}。`
      }
    }

    const attack = normalized.match(/^(?:攻击|打|杀|干掉|去打|去打一下|去攻击)(.+)$/)
    if (attack) {
      const targetRaw = String(attack[1] || '').trim()
      const aliasKey = Object.keys(MOB_ALIASES).find(k => targetRaw.includes(k))
      const target = aliasKey ? MOB_ALIASES[aliasKey] : targetRaw
      return {
        action: { name: 'hunt', args: target ? { name: target } : {} },
        goal: `去攻击 ${target || '目标'}，打完后原地待命。`
      }
    }

    // Anything else the owner says becomes a temporary AI goal.
    return { goal: `主人指令：${raw}` }
  }
}

module.exports = ChatCommander