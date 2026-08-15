const { Vec3 } = require('vec3')
const { goals } = require('mineflayer-pathfinder')

function sleep (ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function findEntity (bot, args) {
  const name = args && (args.name || args.username)
  const type = args && args.type
  return bot.nearestEntity(e => {
    if (!e || e === bot.entity) return false
    if (name && e.username !== name && e.name !== name) return false
    if (type && e.type !== type && e.name !== type) return false
    return true
  })
}

function getBlock (bot, x, y, z) {
  if (x === undefined || y === undefined || z === undefined) {
    return bot.blockAtCursor(5) || null
  }
  return bot.blockAt(new Vec3(Number(x), Number(y), Number(z)))
}

async function lookAtTarget (bot, args) {
  let entity = null
  if (args.username) {
    const p = bot.players && bot.players[args.username]
    entity = p && p.entity
  }
  if (!entity) entity = findEntity(bot, args)
  if (!entity) throw new Error('找不到目标')
  const eye = entity.position.offset(0, entity.height || 1.6, 0)
  await bot.lookAt(eye, true)
  return `看向 ${entity.username || entity.name || args.username || '目标'}`
}

const handlers = {
  chat: async (bot, args) => {
    const message = String(args.message || '').slice(0, 100)
    if (!message) throw new Error('chat 需要 message')
    bot.chat(message)
    return `已发送聊天: ${message}`
  },
  look: async (bot, args) => {
    bot.look(Number(args.yaw ?? bot.entity.yaw), Number(args.pitch ?? bot.entity.pitch), true)
    return '已转向'
  },
  lookAt: lookAtTarget,
  move: async (bot, args) => {
    const dir = String(args.direction || 'forward').toLowerCase()
    const ms = Math.min(Number(args.ms || args.duration || 1000), 10000)
    const valid = ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak']
    if (!valid.includes(dir)) throw new Error('未知方向: ' + dir)
    bot.setControlState(dir, true)
    await sleep(ms)
    bot.setControlState(dir, false)
    return `移动 ${dir} ${ms}ms`
  },
  stop: async (bot) => {
    for (const c of ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak']) {
      bot.setControlState(c, false)
    }
    if (bot.pathfinder) bot.pathfinder.stop()
    return '已停止'
  },
  jump: async (bot) => {
    bot.setControlState('jump', true)
    await sleep(250)
    bot.setControlState('jump', false)
    return '跳跃'
  },
  attack: async (bot, args) => {
    const target = findEntity(bot, args)
    if (!target) throw new Error('附近没有可攻击目标')
    await bot.attack(target)
    return `攻击 ${target.name || target.username || target.type}`
  },
  use: async (bot) => {
    await bot.activateItem()
    return '使用当前物品'
  },
  goto: async (bot, args) => {
    if (!bot.pathfinder) throw new Error('pathfinder 未加载')
    if (args.username) {
      const p = bot.players && bot.players[args.username]
      if (!p || !p.entity) throw new Error('找不到玩家 ' + args.username)
      await bot.pathfinder.goto(new goals.GoalFollow(p.entity, Number(args.distance || 2)))
      return `跟随 ${args.username}`
    }
    const { x, y, z } = args
    if (x === undefined || y === undefined || z === undefined) throw new Error('goto 需要 x,y,z 或 username')
    await bot.pathfinder.goto(new goals.GoalBlock(Number(x), Number(y), Number(z)))
    return `走向 ${x},${y},${z}`
  },
  dig: async (bot, args) => {
    const block = getBlock(bot, args.x, args.y, args.z)
    if (!block) throw new Error('目标方块不存在')
    await bot.dig(block)
    return `挖掘 ${block.name}`
  },
  place: async (bot, args) => {
    const block = getBlock(bot, args.x, args.y, args.z)
    if (!block) throw new Error('目标方块不存在')
    await bot.placeBlock(block, new Vec3(0, 1, 0))
    return `在 ${block.name} 上放置`
  },
  equip: async (bot, args) => {
    const name = String(args.name || '').toLowerCase()
    const item = bot.inventory.items().find(i => i.name === name || (i.displayName && i.displayName.toLowerCase() === name))
    if (!item) throw new Error('背包里没有: ' + name)
    await bot.equip(item, 'hand')
    return `装备 ${item.displayName || item.name}`
  },
  wait: async (bot, args) => {
    const ms = Math.min(Number(args.ms || 500), 10000)
    await sleep(ms)
    return `等待 ${ms}ms`
  }
}

async function execute (bot, action) {
  if (!action || typeof action !== 'object') throw new Error('动作参数无效')
  const name = action.name
  const args = action.args && typeof action.args === 'object' ? action.args : {}
  if (!name || !handlers[name]) throw new Error('未知动作: ' + name)
  return handlers[name](bot, args)
}

module.exports = { execute, handlers }
