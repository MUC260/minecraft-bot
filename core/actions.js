const { Vec3 } = require('vec3')
const { goals } = require('mineflayer-pathfinder')
const observations = require('./observations')
const combat = require('../lib/combat')

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

function isDroppedItemEntity (bot, entity) {
  if (!entity || entity === bot.entity) return false
  const name = String(entity.name || '').toLowerCase()
  const type = String(entity.type || '').toLowerCase()
  return type === 'object' || name === 'item' || name === 'item_stack'
}

function nearestItemDrop (bot, radius) {
  let best = null
  for (const entity of Object.values(bot.entities || {})) {
    if (!isDroppedItemEntity(bot, entity)) continue
    const dist = bot.entity.position.distanceTo(entity.position)
    if (dist > radius) continue
    if (!best || dist < best.distance) best = { entity, distance: dist }
  }
  return best
}

function findNearestBlock (bot, args) {
  const radius = Math.max(1, Math.min(Number(args.radius ?? 12), 32))
  const name = String(args.name || '').toLowerCase()
  if (!name || !bot.findBlocks) return null
  let positions = []
  try {
    positions = bot.findBlocks({
      matching: block => {
        if (!block || !block.name) return false
        const n = String(block.name || '').toLowerCase()
        const dn = String(block.displayName || '').toLowerCase()
        return n === name || dn === name
      },
      maxDistance: radius,
      count: 24
    })
  } catch {
    return null
  }
  if (!positions || !positions.length) return null
  let best = null
  for (const pos of positions) {
    const block = bot.blockAt(pos)
    if (!block) continue
    const dist = bot.entity.position.distanceTo(block.position)
    if (!best || dist < best.distance) best = { block, distance: dist }
  }
  return best ? best.block : null
}

function lowerBlockName (block) {
  return String(block && block.name ? block.name : '').toLowerCase()
}

function bkey (pos) {
  return `${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}`
}

function isLogLike (block) {
  const n = lowerBlockName(block)
  return n.endsWith('_log') || n === 'mushroom_stem' || n === 'crimson_stem' || n === 'warped_stem'
}

function isOreLike (block) {
  const n = lowerBlockName(block)
  return n.endsWith('_ore') || n === 'ancient_debris'
}

function findNearestBlockBy (bot, predicate, radius = 12, count = 128) {
  if (!bot.findBlocks || !bot.entity) return null
  let positions = []
  try {
    positions = bot.findBlocks({
      matching: block => {
        try { return !!predicate(block) } catch { return false }
      },
      maxDistance: radius,
      count
    })
  } catch {
    return null
  }
  if (!positions || !positions.length) return null
  let best = null
  for (const pos of positions) {
    const block = bot.blockAt(pos)
    if (!block) continue
    const dist = bot.entity.position.distanceTo(block.position)
    if (!best || dist < best.distance) best = { block, distance: dist }
  }
  return best ? best.block : null
}

function findNearestHostile (bot, radius = 16) {
  if (!bot.entity) return null
  let best = null
  for (const entity of Object.values(bot.entities || {})) {
    if (!entity || entity === bot.entity) continue
    if (!observations.isHostileName(entity.name)) continue
    const dist = bot.entity.position.distanceTo(entity.position)
    if (dist > radius) continue
    if (!best || dist < best.distance) best = { entity, distance: dist }
  }
  return best
}

const BUILD_BLOCK_PREFIXES = ['oak', 'spruce', 'birch', 'jungle', 'acacia', 'dark_oak', 'mangrove', 'cherry', 'bamboo', 'crimson', 'warped']
const BUILD_BLOCK_EXACT = new Set(['cobblestone', 'stone', 'dirt', 'sandstone', 'bricks', 'stone_bricks', 'netherrack', 'end_stone', 'mossy_cobblestone'])

function isBuildBlock (item) {
  if (!item) return false
  const n = String(item.name || '').toLowerCase()
  if (BUILD_BLOCK_EXACT.has(n)) return true
  return n.endsWith('_planks') || n.endsWith('_log') || n.endsWith('_stem') || n.endsWith('_hyphae') || n === 'mushroom_stem'
}

function chooseBuildBlock (bot) {
  const items = bot.inventory.items().filter(isBuildBlock)
  if (!items.length) return null
  const preferred = ['cobblestone', 'stone_bricks', 'oak_planks', 'spruce_planks', 'stone', 'dirt']
  items.sort((a, b) => {
    const ai = preferred.indexOf(String(a.name || '').toLowerCase())
    const bi = preferred.indexOf(String(b.name || '').toLowerCase())
    const rank = n => n === -1 ? 99 : n
    return rank(ai) - rank(bi)
  })
  return items[0]
}

async function digConnected (bot, start, predicate, ctx, limit = 64) {
  const startPos = new Vec3(Math.floor(start.x), Math.floor(start.y), Math.floor(start.z))
  const seen = new Set()
  const queue = [startPos]
  seen.add(bkey(startPos))
  let dug = 0

  while (queue.length && dug < limit) {
    throwIfAborted(ctx)
    queue.sort((a, b) => bot.entity.position.distanceTo(a) - bot.entity.position.distanceTo(b))
    const pos = queue.shift()
    const block = bot.blockAt(pos)
    if (!block || !predicate(block)) continue

    const dist = bot.entity.position.distanceTo(block.position)
    if (dist > 3.5) {
      const nav = await pathNearXZ(bot, ctx, block.position.x, block.position.z, 2.5, 45000)
      if (nav && nav.preempted) return { preempted: true, reason: nav.reason || 'reactive preempt' }
      if (nav && !nav.ok) throw new Error(nav.reason || 'unable to reach target block')
    }

    await raceWithAbort(bot.dig(block, true), ctx, () => {
      if (typeof bot.stopDigging === 'function') bot.stopDigging()
    })
    dug++

    const dirs = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]
    for (const [dx, dy, dz] of dirs) {
      const npos = pos.offset(dx, dy, dz)
      const key = bkey(npos)
      if (seen.has(key)) continue
      seen.add(key)
      const nb = bot.blockAt(npos)
      if (nb && predicate(nb)) queue.push(npos)
    }
  }

  return { dug, preempted: false }
}

async function placeBuildBlock (bot, pos, ctx) {
  const block = bot.blockAt(pos)
  if (!block) throw new Error('target placement position missing')
  if (block.boundingBox !== 'empty') return false
  const ref = bot.blockAt(pos.offset(0, -1, 0))
  if (!ref || ref.boundingBox === 'empty') return false
  const item = chooseBuildBlock(bot)
  if (!item) throw new Error('no building blocks in inventory')
  const held = bot.heldItem
  if (!held || held.name !== item.name) await bot.equip(item, 'hand')
  try { await bot.lookAt(pos.offset(0, 0.5, 0), true) } catch {}
  await raceWithAbort(bot.placeBlock(ref, new Vec3(0, 1, 0)), ctx, () => {})
  return true
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

async function pathNearXZ (bot, ctx, x, z, range = 2.5, timeoutMs = 60000) {
  if (!bot.pathfinder) throw new Error('pathfinder ???')
  const acquired = acquirePathfinder(bot, ctx, 'navigate-xz')
  if (!acquired.ok) return acquired
  const acq = acquired.acq
  try {
    const goal = new goals.GoalNearXZ(x, z, range)
    const installed = setPathfinderGoal(bot, acq, goal)
    if (!installed.ok) return { ok: false, reason: installed.reason }
    const r = await waitForGoal(bot, ctx, timeoutMs)
    if (r.kind === 'preempted') return { preempted: true, reason: 'reactive ????' }
    if (r.kind === 'reached') return { ok: true }
    if (r.kind === 'noPath' || r.kind === 'timeout') throw new Error('????: ' + r.kind)
    throw new Error('?????: ' + r.kind)
  } finally {
    acq.release()
  }
}

async function pathNear (bot, ctx, x, y, z, range = 1, timeoutMs = 60000) {
  if (!bot.pathfinder) throw new Error('pathfinder 未加载')
  const acquired = acquirePathfinder(bot, ctx, 'navigate')
  if (!acquired.ok) return acquired
  const acq = acquired.acq
  try {
    const goal = new goals.GoalNear(x, y, z, range)
    const installed = setPathfinderGoal(bot, acq, goal)
    if (!installed.ok) return { ok: false, reason: installed.reason }
    const r = await waitForGoal(bot, ctx, timeoutMs)
    if (r.kind === 'preempted') return { preempted: true, reason: 'reactive 抢占路径' }
    if (r.kind === 'reached') return { ok: true }
    if (r.kind === 'noPath' || r.kind === 'timeout') throw new Error('寻路失败: ' + r.kind)
    throw new Error('寻路未完成: ' + r.kind)
  } finally {
    acq.release()
  }
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
    try { await combat.equipBestMelee(bot) } catch {}
    try { await combat.equipShield(bot) } catch {}
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
      if (!installed.ok) throw new Error(installed.reason || '无法设置寻路目标')
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

  collect: async (bot, args, ctx) => {
    const x = Number(args.x)
    const y = Number(args.y)
    const z = Number(args.z)
    const hasPos = [x, y, z].every(Number.isFinite)
    let block = null
    let itemDrop = null

    if (hasPos) {
      block = bot.blockAt(new Vec3(x, y, z))
      if (!block || block.boundingBox === 'empty') {
        itemDrop = nearestItemDrop(bot, 4)
      }
    } else {
      block = findNearestBlock(bot, args)
      if (!block) itemDrop = nearestItemDrop(bot, Math.min(Number(args.radius ?? 12), 24))
    }

    if (!block && !itemDrop) throw new Error('附近没有可采集的方块或掉落物')
    if (block) {
      const dist = bot.entity.position.distanceTo(block.position)
      if (dist > 3.5) {
        const nav = await pathNear(bot, ctx, block.position.x, block.position.y, block.position.z, 1.5, 45000)
        if (nav && nav.preempted) return nav
        if (nav && !nav.ok) throw new Error(nav.reason || '无法到达目标方块')
      }
      await raceWithAbort(bot.dig(block, true), ctx, () => {
        if (typeof bot.stopDigging === 'function') bot.stopDigging()
      })
      return `采集 ${block.name}`
    }

    const drop = itemDrop
    if (drop.distance > 2.5) {
      const nav = await pathNear(bot, ctx, drop.entity.position.x, drop.entity.position.y, drop.entity.position.z, 1, 45000)
      if (nav && nav.preempted) return nav
      if (nav && !nav.ok) throw new Error(nav.reason || '无法到达掉落物')
    }
    const id = drop.entity.id
    for (let i = 0; i < 60; i++) {
      throwIfAborted(ctx)
      await sleep(100, ctx)
      const stillThere = Object.values(bot.entities || {}).some(e => e && e.id === id)
      if (!stillThere) return '拾取掉落物'
    }
    return '已靠近掉落物'
  },

  chopTree: async (bot, args, ctx) => {
    const radius = Math.max(4, Math.min(Number(args.radius ?? 12), 24))
    const block = findNearestBlockBy(bot, isLogLike, radius, 128)
    if (!block) throw new Error('附近没有可砍的树木')
    const maxBlocks = Math.max(1, Math.min(Number(args.max ?? 64), 128))
    const result = await digConnected(bot, block.position, isLogLike, ctx, maxBlocks)
    if (result.preempted) return result
    return `砍树完成，共挖掘 ${result.dug} 块原木`
  },

  mineOreVein: async (bot, args, ctx) => {
    const name = String(args.name || '').toLowerCase()
    const predicate = name ? block => lowerBlockName(block) === name : isOreLike
    const radius = Math.max(4, Math.min(Number(args.radius ?? 12), 24))
    const block = findNearestBlockBy(bot, predicate, radius, 128)
    if (!block) throw new Error('附近没有可开采的矿石')
    const maxBlocks = Math.max(1, Math.min(Number(args.max ?? 48), 96))
    const result = await digConnected(bot, block.position, predicate, ctx, maxBlocks)
    if (result.preempted) return result
    return `采矿完成：${block.name} 共 ${result.dug} 块`
  },

  hunt: async (bot, args, ctx) => {
    const target = findEntity(bot, args)
    if (!target) throw new Error('附近没有可攻击目标')
    let attacks = 0
    const maxAttacks = Math.max(5, Math.min(Number(args.max ?? 30), 60))
    while (attacks < maxAttacks) {
      throwIfAborted(ctx)
      const entity = (bot.entities && bot.entities[target.id]) || target
      if (!entity || entity === bot.entity) break
      const dist = bot.entity.position.distanceTo(entity.position)
      if (dist > 2.8) {
        const nav = await pathNear(bot, ctx, entity.position.x, entity.position.y, entity.position.z, 1.8, 30000)
        if (nav && nav.preempted) return nav
        if (nav && !nav.ok) throw new Error(nav.reason || '无法接近目标')
      }
      try { await bot.lookAt(entity.position.offset(0, (entity.height || 1.6) * 0.8, 0), true) } catch {}
      try { await bot.attack(entity) } catch {}
      attacks++
      await sleep(500, ctx)
    }
    return `狩猎结束，攻击 ${target.name || target.username || target.type} ${attacks} 次`
  },

  protect: async (bot, args, ctx) => {
    const username = String(args.username || '').trim()
    if (!username) throw new Error('protect ?? username ??')
    const player = bot.players && bot.players[username]
    if (!player || !player.entity) throw new Error('?????: ' + username)
    const radius = Math.max(4, Math.min(Number(args.radius ?? 12), 32))
    const reactiveCfg = (bot.reactiveController && bot.reactiveController.cfg) || {}
    const lowHealthThreshold = Number(reactiveCfg.lowHealthFleeThreshold ?? 8)
    const lowHealth = Number.isFinite(bot.health) && bot.health <= lowHealthThreshold
    if (lowHealth) {
      const dist = bot.entity.position.distanceTo(player.entity.position)
      if (dist > 3) {
        const nav = await pathNear(bot, ctx, player.entity.position.x, player.entity.position.y, player.entity.position.z, 3, 30000)
        if (nav && nav.preempted) return nav
        if (nav && !nav.ok) throw new Error(nav.reason || '??????')
      }
      return `?????${bot.health}????? ${username}???????`
    }
    const threat = findNearestHostile(bot, radius)
    if (threat) {
      const target = threat.entity
      if (threat.distance > 2.8) {
        const nav = await pathNear(bot, ctx, target.position.x, target.position.y, target.position.z, 1.8, 30000)
        if (nav && nav.preempted) return nav
        if (nav && !nav.ok) throw new Error(nav.reason || '无法接近目标')
      }
      try { await bot.lookAt(target.position.offset(0, (target.height || 1.6) * 0.8, 0), true) } catch {}
      try { await bot.attack(target) } catch {}
      return `已为 ${username} 攻击 ${target.name || target.type}`
    }
    const dist = bot.entity.position.distanceTo(player.entity.position)
    if (dist > 3) {
      const nav = await pathNear(bot, ctx, player.entity.position.x, player.entity.position.y, player.entity.position.z, 3, 30000)
      if (nav && nav.preempted) return nav
      if (nav && !nav.ok) throw new Error(nav.reason || '无法接近目标')
    }
    return `正在跟随 ${username}`
  },

  buildShelter: async (bot, args, ctx) => {
    if (!chooseBuildBlock(bot)) throw new Error('背包里没有可用于建筑的方块')
    const bx = Math.floor(bot.entity.position.x)
    const by = Math.floor(bot.entity.position.y)
    const bz = Math.floor(bot.entity.position.z)
    const placed = []
    const roofY = by + 2
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        const pos = new Vec3(bx + dx, roofY, bz + dz)
        const current = bot.blockAt(pos)
        if (current && current.boundingBox === 'empty') {
          if (await placeBuildBlock(bot, pos, ctx)) placed.push(`${pos.x},${pos.y},${pos.z}`)
        }
      }
    }
    for (const dx of [-1, 1]) {
      for (const dz of [-1, 1]) {
        for (const level of [by, by + 1]) {
          const pos = new Vec3(bx + dx, level, bz + dz)
          const current = bot.blockAt(pos)
          if (current && current.boundingBox === 'empty') {
            if (await placeBuildBlock(bot, pos, ctx)) placed.push(`${pos.x},${pos.y},${pos.z}`)
          }
        }
      }
    }
    if (!placed.length) throw new Error('避难所放置失败')
    return `避难所搭建完成，共放置 ${placed.length} 个方块`
  },

  equip: async (bot, args) => {
    const name = String(args.name || '').toLowerCase()
    const item = bot.inventory.items().find(i => i.name === name || (i.displayName && i.displayName.toLowerCase() === name))
    if (!item) throw new Error('背包里没有: ' + name)
    await bot.equip(item, 'hand')
    return `装备 ${item.displayName || item.name}`
  },

  armor: async (bot) => {
    const equipped = await combat.equipBestArmor(bot)
    return equipped.length ? `自动装备护甲: ${equipped.join(', ')}` : '没有更好的护甲可装备'
  },

  weapon: async (bot) => {
    const item = await combat.equipBestMelee(bot)
    return item ? `装备近战武器: ${item.displayName || item.name}` : '背包里没有近战武器'
  },

  shield: async (bot) => {
    const ok = await combat.equipShield(bot)
    return ok ? '已装备盾牌到副手' : '没有盾牌或服务器不支持副手'
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
    if (result && typeof result === 'object') {
      if (result.preempted) return { preempted: true, reason: result.reason || 'reactive 抢占', state: snapshot() }
      if (result.ok === false) return { ok: false, reason: result.reason || '动作执行失败', state: snapshot() }
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
