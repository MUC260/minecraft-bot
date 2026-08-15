const { Vec3 } = require('vec3')
const { goals } = require('mineflayer-pathfinder')
const observations = require('./observations')

function abortError (reason) {
  const e = new Error(reason || 'task aborted')
  e.name = 'AbortError'
  e.code = 'ABORT_ERR'
  return e
}

function throwIfAborted (ctx) {
  if (ctx?.signal?.aborted) throw abortError(ctx.signal.reason || 'task aborted')
}

function sleep (ms, ctx) {
  return new Promise((resolve, reject) => {
    throwIfAborted(ctx)
    const timer = setTimeout(resolve, ms)
    if (ctx?.signal) {
      const onAbort = () => {
        clearTimeout(timer)
        reject(abortError(ctx.signal.reason || 'task aborted'))
      }
      if (ctx.signal.aborted) onAbort()
      else ctx.signal.addEventListener('abort', onAbort, { once: true })
    }
  })
}

async function raceWithAbort (promise, ctx, onAbort) {
  if (!ctx?.signal) return promise
  if (ctx.signal.aborted) {
    if (onAbort) try { onAbort() } catch {}
    throw abortError(ctx.signal.reason || 'task aborted')
  }
  let rejectAbort
  const abortPromise = new Promise((resolve, reject) => {
    rejectAbort = reject
    ctx.signal.addEventListener('abort', () => {
      if (onAbort) try { onAbort() } catch {}
      reject(abortError(ctx.signal.reason || 'task aborted'))
    }, { once: true })
  })
  try {
    return await Promise.race([promise, abortPromise])
  } finally {
    ctx.signal.removeEventListener('abort', rejectAbort)
    promise.catch(() => {})
  }
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

function acquirePathfinder (bot, ctx, reason) {
  if (!bot.pathfinderOwner) return { ok: false, preempted: false, reason: 'pathfinderOwner 未初始化' }
  const acq = bot.pathfinderOwner.acquire('skill', { reason })
  if (!acq) return { ok: false, preempted: true, reason: 'reactive 持有寻路令牌' }
  return { ok: true, acq }
}

function setPathfinderGoal (bot, acq, goal, { movements } = {}) {
  const installed = bot.pathfinderOwner.setGoal(acq.token, goal, { movements })
  if (!installed) return { ok: false, reason: 'pathfinder setGoal 被拒绝' }
  return { ok: true }
}

function waitForGoal (bot, ctx, timeoutMs = 60000) {
  return new Promise(resolve => {
    let settled = false
    let timer = null

    const cleanup = () => {
      if (timer) clearTimeout(timer)
      bot.removeListener('goal_reached', onGoal)
      bot.removeListener('path_update', onPath)
      if (ctx?.signal) ctx.signal.removeEventListener('abort', onAbort)
    }
    const finish = (kind, extra = {}) => {
      if (settled) return
      settled = true
      cleanup()
      resolve({ kind, ...extra })
    }
    const onGoal = () => finish('reached')
    const onPath = (r) => {
      if (r && (r.status === 'noPath' || r.status === 'timeout')) finish(r.status)
    }
    const onAbort = () => finish('preempted')

    bot.on('goal_reached', onGoal)
    bot.on('path_update', onPath)
    if (ctx?.signal) {
      if (ctx.signal.aborted) {
        finish('preempted')
        return
      }
      ctx.signal.addEventListener('abort', onAbort, { once: true })
    }
    timer = setTimeout(() => finish('timeout'), timeoutMs)
  })
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

  move: async (bot, args, ctx) => {
    const dir = String(args.direction || 'forward').toLowerCase()
    const ms = Math.min(Number(args.ms || args.duration || 1000), 10000)
    const valid = ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak']
    if (!valid.includes(dir)) throw new Error('未知方向: ' + dir)
    bot.setControlState(dir, true)
    try {
      await sleep(ms, ctx)
    } finally {
      bot.setControlState(dir, false)
    }
    return `移动 ${dir} ${ms}ms`
  },

  stop: async (bot) => {
    for (const c of ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak']) {
      bot.setControlState(c, false)
    }
    if (bot.pathfinderOwner) {
      if (bot.pathfinderOwner.currentOwner() === 'skill') bot.pathfinderOwner._stopPathfinder('stop-action')
    } else if (bot.pathfinder) {
      bot.pathfinder.stop()
    }
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

  goto: async (bot, args, ctx) => {
    if (!bot.pathfinder) throw new Error('pathfinder 未加载')
    const acquired = acquirePathfinder(bot, ctx, 'goto')
    if (!acquired.ok) return { preempted: acquired.preempted, reason: acquired.reason }
    const acq = acquired.acq

    try {
      let goal
      let label
      if (args.username) {
        const p = bot.players && bot.players[args.username]
        if (!p || !p.entity) throw new Error('找不到玩家 ' + args.username)
        goal = new goals.GoalFollow(p.entity, Number(args.distance || 2))
        label = `跟随 ${args.username}`
      } else {
        const x = Number(args.x)
        const y = Number(args.y)
        const z = Number(args.z)
        if (![x, y, z].every(Number.isFinite)) throw new Error('goto 需要 x,y,z 或 username')
        goal = new goals.GoalNear(x, y, z, Number(args.range ?? 1))
        label = `走向 ${x},${y},${z}`
      }
      const installed = setPathfinderGoal(bot, acq, goal)
      if (!installed.ok) return { preempted: false, reason: installed.reason }
      const r = await waitForGoal(bot, ctx, 60000)
      if (r.kind === 'preempted') return { preempted: true, reason: 'reactive 抢占 goto' }
      if (r.kind === 'reached') return label
      if (r.kind === 'noPath' || r.kind === 'timeout') throw new Error('寻路失败: ' + r.kind)
      throw new Error('寻路未完成: ' + r.kind)
    } finally {
      acq.release()
    }
  },

  dig: async (bot, args, ctx) => {
    const block = getBlock(bot, args.x, args.y, args.z)
    if (!block) throw new Error('目标方块不存在')
    await raceWithAbort(bot.dig(block, true), ctx, () => {
      if (typeof bot.stopDigging === 'function') bot.stopDigging()
    })
    return `挖掘 ${block.name}`
  },

  place: async (bot, args) => {
    const block = getBlock(bot, args.x, args.y, args.z)
    if (!block) throw new Error('目标方块不存在')
    const face = args.face && new Vec3(Number(args.face.x || 0), Number(args.face.y || 1), Number(args.face.z || 0)) || new Vec3(0, 1, 0)
    await bot.placeBlock(block, face)
    return `在 ${block.name} 上放置`
  },

  equip: async (bot, args) => {
    const name = String(args.name || '').toLowerCase()
    const item = bot.inventory.items().find(i => i.name === name || (i.displayName && i.displayName.toLowerCase() === name))
    if (!item) throw new Error('背包里没有: ' + name)
    await bot.equip(item, 'hand')
    return `装备 ${item.displayName || item.name}`
  },

  eat: async (bot, args) => {
    const name = String(args.name || '').toLowerCase()
    const item = bot.inventory.items().find(i => {
      if (!i) return false
      if (name && i.name !== name && i.displayName?.toLowerCase() !== name) return false
      const food = ['apple', 'golden_apple', 'bread', 'cooked_beef', 'cooked_porkchop', 'cooked_chicken', 'cooked_mutton', 'cooked_rabbit', 'cooked_cod', 'cooked_salmon', 'baked_potato', 'carrot', 'melon_slice', 'sweet_berries', 'beef', 'porkchop', 'chicken', 'mutton', 'rabbit', 'cod', 'salmon']
      return food.includes(i.name)
    })
    if (!item) throw new Error('背包里没有可食用食物: ' + (name || '任意'))
    await bot.equip(item, 'hand')
    await bot.consume()
    return `吃掉 ${item.displayName || item.name}`
  },

  wait: async (bot, args, ctx) => {
    const ms = Math.min(Number(args.ms || 500), 10000)
    await sleep(ms, ctx)
    return `等待 ${ms}ms`
  }
}

async function executeStructured (bot, action, ctx = {}) {
  const snapshot = () => observations.build(bot)
  try {
    if (!action || typeof action !== 'object') return { ok: false, reason: '动作参数无效', state: snapshot() }
    const name = action.name
    const args = action.args && typeof action.args === 'object' ? action.args : {}
    if (!name || !handlers[name]) return { ok: false, reason: '未知动作: ' + String(name), state: snapshot() }
    const result = await handlers[name](bot, args, ctx)
    if (result && typeof result === 'object' && result.preempted) {
      return { preempted: true, reason: result.reason || 'reactive 抢占', state: snapshot() }
    }
    return { ok: true, reason: typeof result === 'string' ? result : 'done', result: result ?? null, state: snapshot() }
  } catch (err) {
    if (err?.code === 'ABORT_ERR' || ctx?.signal?.aborted) {
      return { preempted: true, reason: ctx?.signal?.reason || err.message || '任务中止', state: snapshot() }
    }
    return { ok: false, reason: err.message || String(err), state: snapshot() }
  }
}

async function execute (bot, action) {
  const r = await executeStructured(bot, action)
  if (r.preempted) throw new Error(r.reason || '动作被生存系统抢占')
  if (!r.ok) throw new Error(r.reason || '动作执行失败')
  return r.reason || r.result || 'done'
}

module.exports = { execute, executeStructured, handlers }