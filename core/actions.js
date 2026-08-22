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
function findPlayer (bot, username) {
  const needle = String(username || '').trim().toLowerCase()
  if (!needle) return null
  const players = (bot && bot.players) || {}
  for (const key of Object.keys(players)) {
    const player = players[key]
    if (!player || !player.entity || player.entity.isValid === false) continue
    const candidate = String(player.username || key || '').toLowerCase()
    if (candidate === needle) return player
  }
  return null
}


function getBlock (bot, x, y, z) {
  if (x === undefined || y === undefined || z === undefined) {
    return bot.blockAtCursor(5) || null
  }
  return bot.blockAt(new Vec3(Number(x), Number(y), Number(z)))
}

function isDroppedItemEntity (bot, entity) {
  if (!entity) return false
  const name = String(entity.name || '').toLowerCase()
  const type = String(entity.type || '').toLowerCase()
  const displayName = String(entity.displayName || '').toLowerCase()
  if (name === 'item' || name === 'item_stack') return true
  if (type === 'object' && (displayName === 'item' || displayName === 'item stack')) return true
  if (type !== 'object' || typeof entity.getDroppedItem !== 'function') return false
  try { return !!entity.getDroppedItem() } catch { return false }
}

function dropFailureMoved (entity) {
  const failedAt = entity && entity._pickupFailurePosition
  if (!failedAt || !entity.position) return false
  const dx = Number(entity.position.x) - Number(failedAt.x)
  const dy = Number(entity.position.y) - Number(failedAt.y)
  const dz = Number(entity.position.z) - Number(failedAt.z)
  return Number.isFinite(dx + dy + dz) && Math.sqrt(dx * dx + dy * dy + dz * dz) >= 2.5
}

function dropPickupCoolingDown (entity, now = Date.now()) {
  if (!entity || !Number.isFinite(Number(entity._pickupRetryAfter))) return false
  if (dropFailureMoved(entity) || Number(entity._pickupRetryAfter) <= now) {
    delete entity._pickupRetryAfter
    delete entity._pickupFailurePosition
    delete entity._pickupFailureCount
    delete entity._pickupFailureReason
    return false
  }
  return true
}

function markDropPickupFailure (entity, reason, baseCooldownMs = 45000) {
  if (!entity) return
  const previous = dropPickupCoolingDown(entity) ? Number(entity._pickupFailureCount || 0) : 0
  const count = Math.max(1, previous + 1)
  const delay = Math.min(180000, Math.max(5000, Number(baseCooldownMs) || 45000) * count)
  entity._pickupRetryAfter = Date.now() + delay
  entity._pickupFailureCount = count
  entity._pickupFailureReason = String(reason || 'unreachable')
  if (entity.position) {
    entity._pickupFailurePosition = {
      x: Number(entity.position.x),
      y: Number(entity.position.y),
      z: Number(entity.position.z)
    }
  }
}

function clearDropPickupFailure (entity) {
  if (!entity) return
  delete entity._pickupRetryAfter
  delete entity._pickupFailurePosition
  delete entity._pickupFailureCount
  delete entity._pickupFailureReason
}

function blockCollectKey (pos) {
  return Math.floor(pos.x) + ',' + Math.floor(pos.y) + ',' + Math.floor(pos.z)
}
function inBlockCollectCooldown (bot, blockOrPos, now = Date.now()) {
  if (!blockOrPos) return false
  const pos = blockOrPos.position || blockOrPos
  const map = bot && bot._blockCollectCooldown
  if (!map) return false
  const key = blockCollectKey(pos)
  const until = map[key]
  if (!until) return false
  if (until > now) return true
  delete map[key]
  return false
}
function markBlockCollectCooldown (bot, blockOrPos, ms = 30000) {
  if (!blockOrPos) return
  const pos = blockOrPos.position || blockOrPos
  bot._blockCollectCooldown = bot._blockCollectCooldown || {}
  bot._blockCollectCooldown[blockCollectKey(pos)] = Date.now() + ms
}

function nearestItemDrop (bot, radius, excludedIds = null) {
  let best = null
  for (const entity of Object.values(bot.entities || {})) {
    if (!isDroppedItemEntity(bot, entity)) continue
    if (excludedIds && excludedIds.has(entity.id)) continue
    if (dropPickupCoolingDown(entity)) continue
    if (entity.isValid === false) continue
    if (!entity.position || !bot.entity || !bot.entity.position) continue
    const dist = bot.entity.position.distanceTo(entity.position)
    if (!Number.isFinite(dist) || dist > radius) continue
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
  let bestVisible = null
  for (const pos of positions) {
    const block = bot.blockAt(pos)
    if (!block) continue
    const dist = bot.entity.position.distanceTo(block.position)
    if (blockVisible(bot, block) && (!bestVisible || dist < bestVisible.distance)) bestVisible = { block, distance: dist }
    if (!best || dist < best.distance) best = { block, distance: dist }
  }
  return (bestVisible || best || {}).block || null
}

function lowerBlockName (block) {
  return String(block && block.name ? block.name : '').toLowerCase()
}

function blockVisible (bot, block) {
  try {
    if (!bot || !block) return false
    if (typeof bot.canSeeBlock === 'function') return !!bot.canSeeBlock(block)
    return true
  } catch {
    return true
  }
}

function firstSolidBlockToward (bot, targetPosition, maxDistance = 4.5) {
  if (!bot.entity || !targetPosition) return null
  const eye = bot.entity.position.offset(0, 1.62, 0)
  const delta = targetPosition.minus(eye)
  const length = Math.sqrt(delta.x * delta.x + delta.y * delta.y + delta.z * delta.z)
  if (!Number.isFinite(length) || length <= 0.01) return null
  const limit = Math.min(maxDistance, length)
  const seen = new Set()
  for (let d = 0.35; d <= limit; d += 0.2) {
    const pos = new Vec3(
      Math.floor(eye.x + delta.x / length * d),
      Math.floor(eye.y + delta.y / length * d),
      Math.floor(eye.z + delta.z / length * d)
    )
    const key = bkey(pos)
    if (seen.has(key)) continue
    seen.add(key)
    const block = bot.blockAt(pos)
    if (!block || block.boundingBox === 'empty') continue
    const n = lowerBlockName(block)
    if (n === 'water' || n === 'lava' || n.endsWith('_water') || n.endsWith('_lava')) continue
    return block
  }
  return null
}

async function exposeBlockSafely (bot, targetBlock, ctx, maxObstructions = 48) {
  for (let i = 0; i < maxObstructions; i++) {
    throwIfAborted(ctx)
    if (blockVisible(bot, targetBlock)) return true
    const center = targetBlock.position.offset(0.5, 0.5, 0.5)
    try { await bot.lookAt(center, true) } catch {}
    await sleep(100, ctx)
    const obstruction = firstSolidBlockToward(bot, center, 4.5)
    if (!obstruction || obstruction.boundingBox === 'empty') {
      // The line is open but the target is still too far away. Advance through
      // the tunnel that was just cleared, then continue from the new position.
      const delta = center.minus(bot.entity.position)
      const length = Math.max(0.001, Math.sqrt(delta.x * delta.x + delta.y * delta.y + delta.z * delta.z))
      const step = Math.min(3, Math.max(1, length - 2.5))
      const waypoint = bot.entity.position.offset(delta.x / length * step, delta.y / length * step, delta.z / length * step)
      const nav = await pathNear(bot, ctx, waypoint.x, waypoint.y, waypoint.z, 1.2, 15000)
      if (nav && nav.preempted) return false
      if (nav && !nav.ok) return false
      continue
    }
    if (bkey(obstruction.position) === bkey(targetBlock.position)) return true
    if (obstruction.diggable === false || obstruction.name === 'bedrock') return false
    const oldDistance = bot.entity.position.distanceTo(targetBlock.position)
    const clearedPosition = obstruction.position.clone()
    try { await combat.equipBestToolForBlock(bot, obstruction.name) } catch {}
    await raceWithAbort(bot.dig(obstruction, true), ctx, () => {
      if (typeof bot.stopDigging === 'function') bot.stopDigging()
    })
    await sleep(120, ctx)

    // Move into the newly opened space whenever the target is still outside
    // normal digging reach. This creates a real tunnel/staircase instead of
    // trying to mine through walls from several blocks away.
    if (oldDistance > 4.2) {
      // Give gravity a moment first. For downward mining the bot normally
      // drops into the freshly opened block without needing pathfinder.
      await sleep(650, ctx)
      const afterGravity = bot.entity.position.distanceTo(targetBlock.position)
      if (afterGravity < oldDistance - 0.25) continue

      const nav = await pathNear(bot, ctx, clearedPosition.x + 0.5, clearedPosition.y, clearedPosition.z + 0.5, 0.55, 8000)
      if (nav && nav.preempted) return false
      if (nav && !nav.ok && bot.entity.position.distanceTo(targetBlock.position) >= oldDistance - 0.25) return false
    }
  }
  return blockVisible(bot, targetBlock)
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

function canonicalOreName (name) {
  return String(name || '').toLowerCase().replace(/^deepslate_/, '')
}

function oreMatchesName (block, requestedName) {
  const actual = lowerBlockName(block)
  const requested = String(requestedName || '').toLowerCase()
  if (!requested) return isOreLike(block)
  return actual === requested || canonicalOreName(actual) === canonicalOreName(requested)
}

const ORE_DROP_NAMES = {
  iron_ore: ['raw_iron', 'iron_ingot', 'iron_ore', 'deepslate_iron_ore'],
  gold_ore: ['raw_gold', 'gold_ingot', 'gold_ore', 'deepslate_gold_ore'],
  copper_ore: ['raw_copper', 'copper_ingot', 'copper_ore', 'deepslate_copper_ore'],
  coal_ore: ['coal', 'coal_ore', 'deepslate_coal_ore'],
  diamond_ore: ['diamond', 'diamond_ore', 'deepslate_diamond_ore'],
  emerald_ore: ['emerald', 'emerald_ore', 'deepslate_emerald_ore'],
  lapis_ore: ['lapis_lazuli', 'lapis_ore', 'deepslate_lapis_ore'],
  redstone_ore: ['redstone', 'redstone_ore', 'deepslate_redstone_ore'],
  nether_gold_ore: ['gold_nugget', 'nether_gold_ore'],
  nether_quartz_ore: ['quartz', 'nether_quartz_ore'],
  ancient_debris: ['ancient_debris']
}

function oreYieldCount (bot, requestedName) {
  const canonical = canonicalOreName(requestedName)
  const names = new Set(ORE_DROP_NAMES[canonical] || [requestedName, canonical])
  return (bot.inventory?.items?.() || []).reduce((sum, item) => {
    return names.has(String(item && item.name || '').toLowerCase()) ? sum + Number(item.count || 0) : sum
  }, 0)
}

function trackedYieldCount (bot, blockName) {
  const name = String(blockName || '').toLowerCase()
  if (!name) return null
  if (name.endsWith('_ore') || name === 'ancient_debris') return oreYieldCount(bot, name)
  if (name === 'stone') return countItemByName(bot, 'cobblestone')
  if (name === 'deepslate') return countItemByName(bot, 'cobbled_deepslate')
  return null
}

async function waitForTrackedYield (bot, blockName, before, ctx, timeoutMs) {
  const deadline = Date.now() + Math.max(100, timeoutMs)
  while (Date.now() < deadline) {
    throwIfAborted(ctx)
    const gained = trackedYieldCount(bot, blockName) - before
    if (gained > 0) return gained
    await sleep(100, ctx)
  }
  return trackedYieldCount(bot, blockName) - before
}

function isCollectibleLike (block) {
  const n = lowerBlockName(block)
  if (!n) return false
  if (n.endsWith('_log') || n.endsWith('_ore') || n === 'ancient_debris') return true
  if (n === 'pumpkin' || n === 'melon' || n === 'sugar_cane' || n === 'cactus' || n === 'bamboo') return true
  if (n === 'wheat' || n === 'carrots' || n === 'potatoes' || n === 'beetroots' || n === 'nether_wart' || n === 'cocoa' || n === 'sweet_berry_bush') return true
  return false
}

function harvestToolCandidate (bot, block) {
  if (!bot || !block) return null
  try {
    return combat.toolForBlock(block.name, bot.inventory?.items?.() || []) || bot.heldItem || null
  } catch {
    return bot.heldItem || null
  }
}

function canHarvestBlock (bot, block) {
  if (!block || typeof block.canHarvest !== 'function') return true
  const tool = harvestToolCandidate(bot, block)
  try { return !!block.canHarvest(tool ? tool.type : null) } catch { return true }
}

async function equipForHarvest (bot, block) {
  try { await combat.equipBestToolForBlock(bot, block.name) } catch {}
  if (canHarvestBlock(bot, block)) return true
  const held = bot.heldItem && bot.heldItem.name ? bot.heldItem.name : '\u7a7a\u624b'
  throw new Error(`\u7f3a\u5c11\u80fd\u91c7\u96c6 ${block.name} \u7684\u5de5\u5177\uff08\u5f53\u524d\uff1a${held}\uff09\uff0c\u5df2\u505c\u6b62\u6316\u6398\u4ee5\u514d\u7834\u574f\u65b9\u5757\u5374\u6ca1\u6709\u6389\u843d\u7269`)
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
  let bestVisible = null
  for (const pos of positions) {
    const block = bot.blockAt(pos)
    if (!block) continue
    const dist = bot.entity.position.distanceTo(block.position)
    const visible = blockVisible(bot, block)
    if (visible) {
      if (!bestVisible || dist < bestVisible.distance) bestVisible = { block, distance: dist }
    }
    if (!best || dist < best.distance) best = { block, distance: dist }
  }
  return (bestVisible || best || {}).block || null
}

function probePathResult (bot, movements, goal, timeoutMs = 100) {
  if (!bot?.pathfinder || !movements || !bot.entity?.position || typeof bot.pathfinder.getPathFromTo !== 'function') return null
  try {
    const generator = bot.pathfinder.getPathFromTo(movements, bot.entity.position, goal, {
      timeout: Math.max(25, timeoutMs),
      tickTimeout: Math.min(20, Math.max(5, timeoutMs)),
      searchRadius: Math.min(12, Math.max(6, Number(bot.pathfinder.searchRadius) || 12)),
      optimizePath: true,
      resetEntityIntersects: false
    })
    const next = generator.next()
    return next && next.value ? next.value.result : null
  } catch {
    return null
  }
}

async function findReachableBlockBy (bot, predicate, radius = 16, count = 128, maxChecks = 10) {
  if (!bot.findBlocks || !bot.entity) return null
  let positions = []
  try {
    positions = bot.findBlocks({
      matching: block => {
        try { return !!predicate(block) } catch { return false }
      },
      maxDistance: radius,
      count
    }) || []
  } catch {
    return null
  }

  const candidates = positions
    .map(pos => bot.blockAt(pos))
    .filter(Boolean)
    .map(block => ({
      block,
      distance: bot.entity.position.distanceTo(block.position),
      visible: blockVisible(bot, block)
    }))
    .sort((a, b) => Number(b.visible) - Number(a.visible) || a.distance - b.distance)

  for (const candidate of candidates.slice(0, Math.max(1, maxChecks))) {
    if (candidate.distance <= 3.5 && candidate.visible) return candidate.block
    try {
      const movements = bot.pathfinder && bot.pathfinder.movements
      if (!movements || typeof bot.pathfinder.getPathTo !== 'function') continue
      // This is only a cheap candidate probe.  A long synchronous A* probe here
      // blocks Express, physics and chat, and was a major source of apparent
      // freezes when ten mountain candidates were checked in one tick.
      const goal = new goals.GoalNear(candidate.block.position.x, candidate.block.position.y, candidate.block.position.z, 2.5)
      const result = probePathResult(bot, movements, goal, 100)
      if (result && (result.status === 'success' || (Array.isArray(result.path) && result.path.length >= 2))) return candidate.block
      await Promise.resolve()
    } catch {}
  }
  return null
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
const DOOR_ITEM_SUFFIX = '_door'
const LIGHT_ITEM_NAMES = new Set(['torch', 'lantern', 'soul_torch', 'soul_lantern'])


function isBuildBlock (item) {
  if (!item) return false
  const n = String(item.name || '').toLowerCase()
  if (BUILD_BLOCK_EXACT.has(n)) return true
  return n.endsWith('_planks') || n.endsWith('_log') || n.endsWith('_stem') || n.endsWith('_hyphae') || n === 'mushroom_stem'
}

function chooseBuildBlock (bot, material, need = 0) {
  let items = bot.inventory.items().filter(isBuildBlock)
  if (material) {
    const m = String(material).toLowerCase()
    items = items.filter(i => String(i.name || '').toLowerCase().includes(m) || String(i.displayName || '').toLowerCase().includes(m))
  }
  if (!items.length) return null
  const preferred = ['cobblestone', 'stone_bricks', 'oak_planks', 'spruce_planks', 'stone', 'dirt']
  items.sort((a, b) => {
    const ai = preferred.indexOf(String(a.name || '').toLowerCase())
    const bi = preferred.indexOf(String(b.name || '').toLowerCase())
    const rank = n => n === -1 ? 99 : n
    if (rank(ai) !== rank(bi)) return rank(ai) - rank(bi)
    return Number(b.count || 0) - Number(a.count || 0)
  })
  const target = Number(need) > 0 ? Number(need) : 1
  const enough = items.find(i => Number(i.count || 0) >= target)
  return enough || items[0]
}

function countItemByName (bot, name) {
  if (!name) return 0
  const target = String(name).toLowerCase()
  return bot.inventory.items().filter(i => String(i && i.name || '').toLowerCase() === target).reduce((sum, i) => sum + Number(i.count || 0), 0)
}

function logPlanksName (logName) {
  const n = String(logName || '').toLowerCase()
  const m = n.match(/^(.+)_(log|stem|hyphae)$/)
  if (!m) return null
  return m[1] + '_planks'
}

function isLogItem (item) {
  const n = String(item && item.name || '').toLowerCase()
  return n.endsWith('_log') || n.endsWith('_stem') || n.endsWith('_hyphae') || n === 'mushroom_stem'
}

function findLogItem (bot, material) {
  let items = bot.inventory.items().filter(isLogItem)
  if (material) {
    let m = String(material).toLowerCase()
    if (/^(wood|log|logs|tree|plank|planks|wooden|timber)$/.test(m)) m = ''
    if (m) {
      const matched = items.filter(i => {
        const n = String(i.name || '').toLowerCase()
        const dn = String(i.displayName || '').toLowerCase()
        const planks = logPlanksName(n)
        return n.includes(m) || dn.includes(m) || (planks && planks.includes(m))
      })
      if (matched.length) items = matched
    }
  }
  items.sort((a, b) => Number(b.count || 0) - Number(a.count || 0))
  return items[0] || null
}

function findPlankItem (bot, material) {
  let items = bot.inventory.items().filter(i => String(i && i.name || '').toLowerCase().endsWith('_planks'))
  if (material) {
    let m = String(material).toLowerCase()
    if (/^(wood|log|logs|tree|plank|planks|wooden|timber)$/.test(m)) m = ''
    if (m) {
      const matched = items.filter(i => String(i.name || '').toLowerCase().includes(m) || String(i.displayName || '').toLowerCase().includes(m))
      if (matched.length) items = matched
    }
  }
  items.sort((a, b) => Number(b.count || 0) - Number(a.count || 0))
  return items[0] || null
}

function getItemsByName (bot) {
  if (bot && bot.registry && bot.registry.itemsByName) return bot.registry.itemsByName
  try {
    const mcData = require('minecraft-data')(bot.version)
    return (mcData && mcData.itemsByName) || {}
  } catch {
    return {}
  }
}

function countMaterialFamily (bot, suffix) {
  return bot.inventory.items().filter(i => String(i && i.name || '').toLowerCase().endsWith(suffix)).reduce((sum, i) => sum + Number(i.count || 0), 0)
}

function findInventoryItemByName (bot, name) {
  const target = String(name || '').toLowerCase()
  return bot.inventory.items().find(i => String(i && i.name || '').toLowerCase() === target) || null
}

function closeOpenWindow (bot) {
  try {
    if (bot && bot.currentWindow && typeof bot.closeWindow === 'function') {
      bot.closeWindow(bot.currentWindow)
    }
  } catch {}
}

async function ensureNearCraftingTable (bot, table, ctx) {
  if (!table || !table.position) return true
  try {
    const dist = bot.entity.position.distanceTo(table.position)
    if (dist <= 4) return true
    const nav = await pathNear(bot, ctx, table.position.x, table.position.y, table.position.z, 2, 15000)
    if (nav && nav.preempted) return nav
    return !!(nav && nav.ok)
  } catch {
    return true
  }
}

async function craftWithRetry (bot, recipe, count, table, ctx) {
  closeOpenWindow(bot)
  if (table) {
    const near = await ensureNearCraftingTable(bot, table, ctx)
    if (near && near.preempted) throw abortError(near.reason || 'reactive preempt')
  }
  let lastErr = null
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await raceWithAbort(bot.craft(recipe, count, table), ctx, () => closeOpenWindow(bot))
      closeOpenWindow(bot)
      return true
    } catch (err) {
      lastErr = err
      closeOpenWindow(bot)
      await sleep(1200, ctx)
    }
  }
  throw lastErr || new Error('craft failed')
}

async function craftItem (bot, itemName, ctx, count = 1, table = null) {
  if (!bot || !bot.inventory || typeof bot.recipesFor !== 'function' || typeof bot.craft !== 'function') return false
  const byName = getItemsByName(bot)
  const def = byName[itemName]
  if (!def) return false
  let recipes = bot.recipesFor(def.id, null, count, table)
  recipes = Array.isArray(recipes) ? recipes : []
  // Recipes that need a 3x3 grid (furnace, iron/diamond tools, ...) are not
  // returned when no crafting table is supplied. Make/place one and re-query
  // instead of reporting a false failure.
  if (!recipes.length && !table) {
    table = await ensureCraftingTable(bot, ctx)
    if (!table) return false
    recipes = bot.recipesFor(def.id, null, count, table)
    recipes = Array.isArray(recipes) ? recipes : []
  }
  if (!recipes.length) return false
  let recipe = recipes.find(r => !r.requiresTable) || recipes[0]
  if (!recipe) return false

  // Some recipes are only returned when the crafting table is passed as a
  // block. If we do not have one nearby, make and place one first instead of
  // silently picking an unusable recipe.
  if (recipe.requiresTable && !table) {
    table = await ensureCraftingTable(bot, ctx)
    if (!table) return false
    recipes = bot.recipesFor(def.id, null, count, table)
    recipes = Array.isArray(recipes) ? recipes : []
    if (!recipes.length) return false
    recipe = recipes.find(r => r.requiresTable) || recipes.find(r => !r.requiresTable) || recipes[0]
    if (!recipe) return false
  }

  const useTable = recipe.requiresTable ? table : null
  const crafted = await craftWithRetry(bot, recipe, count, useTable, ctx)
  await sleep(200, ctx)
  return crafted
}

async function ensureSticks (bot, ctx, need = 2) {
  if (countItemByName(bot, 'stick') >= need) return true
  if (countMaterialFamily(bot, '_planks') < 2) {
    const log = findLogItem(bot, null)
    if (!log) return false
    await craftPlanksFromLog(bot, log, 4, ctx)
  }
  if (countMaterialFamily(bot, '_planks') < 2) return false
  return craftItem(bot, 'stick', ctx, 1, null)
}

const CRAFT_ALIASES = {
  '\u5de5\u4f5c\u53f0': 'crafting_table',
  '\u6728\u5251': 'wooden_sword',
  '\u6728\u9550': 'wooden_pickaxe',
  '\u6728\u65a7': 'wooden_axe',
  '\u6728\u9504': 'wooden_shovel',
  '\u77f3\u5251': 'stone_sword',
  '\u77f3\u9550': 'stone_pickaxe',
  '\u77f3\u65a7': 'stone_axe',
  '\u77f3\u9504': 'stone_shovel',
  '\u94c1\u5251': 'iron_sword',
  '\u94c1\u9550': 'iron_pickaxe',
  '\u94c1\u65a7': 'iron_axe',
  '\u94c1\u9504': 'iron_shovel',
  '\u5251': 'wooden_sword',
  '\u9550': 'wooden_pickaxe',
  '\u9504': 'wooden_shovel',
  '\u65a7\u5934': 'wooden_axe',
  '\u76fe\u724c': 'shield',
  '\u6728\u68cd': 'stick',
  '\u68cd\u5b50': 'stick',
  '\u6728\u677f': 'oak_planks',
  '\u7bb1\u5b50': 'chest',
  '\u7bb1': 'chest',
  '\u6728\u95e8': 'oak_door',
  '\u95e8': 'oak_door',
  '\u7194\u7089': 'furnace'
}

const WOOD_TOOL_ITEMS = new Set(['wooden_sword', 'wooden_pickaxe', 'wooden_axe', 'wooden_shovel'])
const STONE_TOOL_ITEMS = new Set(['stone_sword', 'stone_pickaxe', 'stone_axe', 'stone_shovel'])
const GEAR_PRIORITY = ['wooden_pickaxe', 'wooden_axe', 'wooden_sword', 'wooden_shovel']
const LEATHER_ARMOR_ITEMS = ['leather_helmet', 'leather_chestplate', 'leather_leggings', 'leather_boots']

function toolPlanksNeeded (itemName) {
  if (itemName === 'wooden_sword') return 2
  if (itemName === 'wooden_pickaxe' || itemName === 'wooden_axe') return 3
  if (itemName === 'wooden_shovel') return 1
  if (itemName === 'stick') return 2
  return 0
}

function resolveCraftItemName (bot, raw) {
  let target = String(raw || '').trim().toLowerCase()
  if (!target) return null
  // Strip leading Chinese quantity words and trailing modal particles.
  target = target.replace(/^(?:一把|一个|一只|一件|一套|一些|几个|一|把|只|件|套)/, '')
  target = target.replace(/(?:给我|吧|啊|呀|哦|噢|一个|好吗)+$/, '')
  target = target.trim()
  if (!target) return null
  if (CRAFT_ALIASES[target]) return CRAFT_ALIASES[target]
  const byName = getItemsByName(bot)
  if (byName[target]) return target
  if (byName['wooden_' + target]) return 'wooden_' + target
  if (byName['stone_' + target]) return 'stone_' + target
  if (target === 'crafting table' || target === 'workbench') return 'crafting_table'
  if (target === 'wood') return 'oak_planks'
  if (target === 'stick') return 'stick'
  if (target === 'sword') return 'wooden_sword'
  if (target === 'pickaxe' || target === 'pick') return 'wooden_pickaxe'
  if (target === 'axe') return 'wooden_axe'
  if (target === 'shovel') return 'wooden_shovel'
  return null
}

async function ensureWoodMaterialsForCraft (bot, itemName, ctx) {
  const planksNeed = toolPlanksNeeded(itemName)
  if (planksNeed > 0 && countMaterialFamily(bot, '_planks') < planksNeed) {
    const planks = await gatherAndCraftPlanks(bot, null, ctx, planksNeed)
    if (planks && planks.preempted) return planks
    if (!planks) return null
  }
  if (planksNeed > 0 && countMaterialFamily(bot, '_planks') < planksNeed) return null

  if (itemName === 'stick') {
    if (countMaterialFamily(bot, '_planks') < 2) return null
    return true
  }

  if (countItemByName(bot, 'stick') < 2) {
    const ok = await ensureSticks(bot, ctx, 2)
    if (!ok) return null
  }
  return true
}

async function craftOneItem (bot, itemName, ctx, count = 1) {
  const before = countItemByName(bot, itemName)

  if (itemName === 'crafting_table') {
    const table = await ensureCraftingTable(bot, ctx)
    if (!table) throw new Error('没有可用工作台')
    return '已制作并放置工作台'
  }

  let table = null
  if (WOOD_TOOL_ITEMS.has(itemName) || STONE_TOOL_ITEMS.has(itemName)) {
    table = await ensureCraftingTable(bot, ctx)
    if (!table) throw new Error('没有可用工作台')
  }

  if (itemName.endsWith('_planks')) {
    const planks = await gatherAndCraftPlanks(bot, itemName, ctx, count)
    if (planks && planks.preempted) return planks
    if (planks) return '已准备板材: ' + planks + ' x' + Math.max(1, count)
    throw new Error('无法制作板材: ' + itemName)
  }

  if (WOOD_TOOL_ITEMS.has(itemName) || itemName === 'stick') {
    const prepared = await ensureWoodMaterialsForCraft(bot, itemName, ctx)
    if (prepared && prepared.preempted) return prepared
    if (!prepared) throw new Error('材料不足，无法制作: ' + itemName)
  }

  const ok = await craftItem(bot, itemName, ctx, count, table)
  const after = countItemByName(bot, itemName)
  if (!ok || after <= before) throw new Error('制作失败: ' + itemName)
  return '已制作: ' + itemName + ' x' + Math.max(1, count)
}

function findCraftingTableBlock (bot, radius = 8) {
  return findNearestBlockBy(bot, block => lowerBlockName(block) === 'crafting_table', radius, 32)
}

async function placeSpecificBlockNearby (bot, ctx, itemName) {
  const item = findInventoryItemByName(bot, itemName)
  if (!item) return null
  const here = bot.entity.position
  const y = Math.floor(here.y)
  const yaw = Number(bot.entity.yaw) || 0
  const dx = -Math.round(Math.sin(yaw))
  const dz = -Math.round(Math.cos(yaw))
  const offsets = [[dx, 0, dz], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [-dx, 0, -dz], [1, 0, 1], [1, 0, -1], [-1, 0, 1], [-1, 0, -1]]
  for (const [ox, oy, oz] of offsets) {
    const pos = new Vec3(Math.floor(here.x) + ox, y + oy, Math.floor(here.z) + oz)
    let block = bot.blockAt(pos)
    if (!block) continue
    if (block.boundingBox !== 'empty') {
      const name = lowerBlockName(block)
      if (block.diggable === false || name === 'bedrock' || name.includes('water') || name.includes('lava')) continue
      try {
        await equipForHarvest(bot, block)
        await raceWithAbort(bot.dig(block, true), ctx, () => {
          if (typeof bot.stopDigging === 'function') bot.stopDigging()
        })
        await sleep(150, ctx)
        block = bot.blockAt(pos)
      } catch {
        continue
      }
    }
    if (!block || block.boundingBox !== 'empty') continue
    const support = findBuildSupport(bot, pos)
    if (!support) continue
    await equipBuildBlock(bot, item)
    try { await bot.lookAt(pos.offset(0.5, 0.5, 0.5), true) } catch {}
    await raceWithAbort(bot.placeBlock(support.ref, support.face), ctx, () => {})
    return bot.blockAt(pos) || pos
  }
  return null
}

async function ensureCraftingTable (bot, ctx) {
  let table = findCraftingTableBlock(bot, 8)
  if (table) return table
  if (!findInventoryItemByName(bot, 'crafting_table')) {
    if (countMaterialFamily(bot, '_planks') < 4) {
      let log = findLogItem(bot, null)
      if (!log) {
        const planks = await gatherAndCraftPlanks(bot, null, ctx, 4)
        if (planks && planks.preempted) throw abortError(planks.reason || 'reactive preempt')
        log = findLogItem(bot, null)
      } else {
        await craftPlanksFromLog(bot, log, 4, ctx)
      }
    }
    if (countMaterialFamily(bot, '_planks') < 4) return null
    const crafted = await craftItem(bot, 'crafting_table', ctx, 1, null)
    if (!crafted) return null
    await sleep(200, ctx)
  }
  const placed = await placeSpecificBlockNearby(bot, ctx, 'crafting_table')
  if (placed) return placed
  return findCraftingTableBlock(bot, 6)
}

function kindForBlockName (blockName) {
  const n = String(blockName || '').toLowerCase()
  if (n.endsWith('_log') || n.endsWith('_stem') || n.endsWith('_hyphae') || n === 'mushroom_stem') return 'axe'
  if (n.endsWith('_ore') || n === 'ancient_debris') return 'pickaxe'
  // 与 lib/combat 的方块分类保持一致：石头类用镐，泥土/沙类用铲
  if (combat.PICKAXE_BLOCKS && combat.PICKAXE_BLOCKS.has(n)) return 'pickaxe'
  if (combat.SHOVEL_BLOCKS && combat.SHOVEL_BLOCKS.has(n)) return 'shovel'
  return null
}

async function ensureWoodenToolForBlock (bot, blockName, ctx) {
  const kind = kindForBlockName(blockName)
  if (!kind) return false
  const itemName = 'wooden_' + kind
  const existing = combat.toolForBlock(blockName, bot.inventory.items().filter(i => i))
  if (existing) return true
  if (findInventoryItemByName(bot, itemName)) {
    try { await combat.equipBestToolForBlock(bot, blockName) } catch {}
    return true
  }
  if (countMaterialFamily(bot, '_planks') < 3) {
    const log = findLogItem(bot, null)
    if (!log) return false
    await craftPlanksFromLog(bot, log, 4, ctx)
  }
  if (countMaterialFamily(bot, '_planks') < 3) return false
  const table = await ensureCraftingTable(bot, ctx)
  if (!table) return false
  if (countItemByName(bot, 'stick') < 2) await ensureSticks(bot, ctx, 2)
  if (countItemByName(bot, 'stick') < 2) return false
  await craftItem(bot, itemName, ctx, 1, table)
  await sleep(200, ctx)
  const made = findInventoryItemByName(bot, itemName)
  if (made) {
    try { await combat.equipBestToolForBlock(bot, blockName) } catch {}
    return true
  }
  return false
}

async function craftPlanksFromLog (bot, logItem, need, ctx) {
  const planksName = logPlanksName(logItem && logItem.name)
  if (!planksName) return false
  const byName = getItemsByName(bot)
  const def = byName[planksName]
  if (!def || typeof bot.recipesFor !== 'function' || typeof bot.craft !== 'function') return false
  const recipes = bot.recipesFor(def.id, null, 1, false)
  const recipe = Array.isArray(recipes) ? (recipes.find(r => !r.requiresTable) || recipes[0]) : null
  if (!recipe) return false
  const perCraft = Math.max(1, Number(recipe.result && recipe.result.count) || 4)
  const logCount = countItemByName(bot, logItem.name)
  if (logCount <= 0) return false
  const crafts = Math.max(1, Math.min(logCount, Math.ceil(Math.max(1, Number(need) || 1) / perCraft)))
  await bot.craft(recipe, crafts, null)
  await sleep(250, ctx)
  return true
}

async function clearPathToDrop (bot, entityId, ctx, maxBlocks = 4) {
  for (let i = 0; i < maxBlocks; i++) {
    throwIfAborted(ctx)
    const entity = Object.values(bot.entities || {}).find(e => e && e.id === entityId)
    if (!entity || !entity.position) return true
    if (bot.entity.position.distanceTo(entity.position) <= 1.2) return true
    try { await bot.lookAt(entity.position.offset(0, 0.15, 0), true) } catch {}
    await sleep(80, ctx)
    const obstruction = firstSolidBlockToward(bot, entity.position.offset(0, 0.15, 0), 4.5)
    if (!obstruction || obstruction.diggable === false || obstruction.name === 'bedrock') return false
    try {
      await equipForHarvest(bot, obstruction)
      await raceWithAbort(bot.dig(obstruction, true), ctx, () => {
        if (typeof bot.stopDigging === 'function') bot.stopDigging()
      })
      await sleep(350, ctx)
    } catch {
      return false
    }
  }
  return false
}

async function pickupNearbyDrops (bot, ctx, radius = 8) {
  const deadline = Date.now() + 12000
  const failedIds = new Set()
  const outcome = { collected: 0, skipped: 0, attempted: 0 }

  for (let i = 0; i < 12 && Date.now() < deadline; i++) {
    throwIfAborted(ctx)
    const drop = nearestItemDrop(bot, radius, failedIds)
    if (!drop) return outcome

    const entity = drop.entity
    const id = entity && entity.id
    outcome.attempted++

    const fail = (reason) => {
      if (id != null) failedIds.add(id)
      markDropPickupFailure(entity, reason)
      outcome.skipped++
    }

    if (drop.distance > 2.5) {
      const remaining = Math.max(1000, deadline - Date.now())
      const heightGap = Math.abs(Number(entity.position.y) - Number(bot.entity.position.y))
      const navTimeout = Math.min(6000, remaining)
      // GoalNearXZ ignores height. It can report success while the item is many
      // blocks above/below, causing every autonomous tick to chase the same drop.
      const nav = heightGap > 2.25
        ? await pathNear(bot, ctx, entity.position.x, entity.position.y, entity.position.z, 1.25, navTimeout)
        : await pathNearXZ(bot, ctx, entity.position.x, entity.position.z, 1.2, navTimeout)
      if (nav && nav.preempted) return nav
      if (nav && !nav.ok) {
        fail(heightGap > 2.25 ? 'height-gap:' + (nav.reason || 'unreachable') : (nav.reason || 'unreachable'))
        continue
      }
    }

    let collected = false
    for (let j = 0; j < 15 && Date.now() < deadline; j++) {
      throwIfAborted(ctx)
      await sleep(100, ctx)
      const stillThere = Object.values(bot.entities || {}).some(e => e && e.id === id)
      if (!stillThere) {
        collected = true
        break
      }
      const current = Object.values(bot.entities || {}).find(e => e && e.id === id)
      if (current && bot.entity.position.distanceTo(current.position) > 2.5) break
    }
    if (collected) {
      clearDropPickupFailure(entity)
      outcome.collected++
      continue
    }

    let current = Object.values(bot.entities || {}).find(e => e && e.id === id)
    if (current && Date.now() < deadline) {
      const heightGap = Math.abs(Number(current.position.y) - Number(bot.entity.position.y))

      // Drops from mined blocks can fall into the freshly opened shaft. Open a
      // short direct route only for nearby gaps; large cliffs are cooled down.
      if (bot.entity.position.distanceTo(current.position) <= 6.5 && heightGap <= 6) {
        await clearPathToDrop(bot, id, ctx, 6)
        current = Object.values(bot.entities || {}).find(e => e && e.id === id)
      }

      if (current && Date.now() < deadline) {
        const remaining = Math.max(800, deadline - Date.now())
        const nav = await pathNear(bot, ctx, current.position.x, current.position.y, current.position.z, 0.7, Math.min(4000, remaining))
        if (nav && nav.preempted) return nav
        if (nav && nav.ok) {
          for (let j = 0; j < 10 && Date.now() < deadline; j++) {
            await sleep(100, ctx)
            const stillThere = Object.values(bot.entities || {}).some(e => e && e.id === id)
            if (!stillThere) {
              collected = true
              break
            }
          }
        }
      }

      let close = Object.values(bot.entities || {}).find(e => e && e.id === id)
      // GoalNear works on floored block coordinates and may stop at the edge of
      // the pickup radius. Walk the final fraction only when vertical alignment
      // is close enough; otherwise forward motion can walk off a ledge.
      if (!collected && close && bot.entity.position.distanceTo(close.position) <= 3 && Math.abs(close.position.y - bot.entity.position.y) <= 1.75) {
        try { await bot.lookAt(close.position.offset(0, 0.2, 0), true) } catch {}
        bot.setControlState('forward', true)
        try {
          for (let j = 0; j < 12 && Date.now() < deadline; j++) {
            await sleep(100, ctx)
            const stillThere = Object.values(bot.entities || {}).some(e => e && e.id === id)
            if (!stillThere) {
              collected = true
              break
            }
          }
        } finally {
          bot.setControlState('forward', false)
        }
      }
    }

    if (collected) {
      clearDropPickupFailure(entity)
      outcome.collected++
    } else {
      fail('pickup-not-confirmed')
    }
  }
  return outcome
}

async function digReachableTree (bot, start, ctx, limit = 48) {
  const queue = [new Vec3(Math.floor(start.x), Math.floor(start.y), Math.floor(start.z))]
  const seen = new Set(queue.map(bkey))
  let dug = 0

  while (queue.length && dug < limit) {
    throwIfAborted(ctx)
    queue.sort((a, b) => bot.entity.position.distanceTo(a) - bot.entity.position.distanceTo(b))
    const pos = queue.shift()
    const block = bot.blockAt(pos)
    if (!block || !isLogLike(block)) continue

    let distance = bot.entity.position.distanceTo(block.position)
    if (distance > 4.5 && dug === 0) {
      const nav = await pathNear(bot, ctx, block.position.x, block.position.y, block.position.z, 2.5, 20000)
      if (nav && nav.preempted) return { preempted: true, reason: nav.reason }
      if (nav && !nav.ok) { const e = new Error(nav.reason || '\u65e0\u6cd5\u5230\u8fbe\u6811\u6728'); e.code = 'NO_TREE'; throw e }
      distance = bot.entity.position.distanceTo(block.position)
    }
    // Tall trunks can extend beyond normal digging reach. Finish every log that
    // is actually reachable, then return instead of pathing forever toward air.
    if (distance > 4.5) continue

    try { await bot.lookAt(block.position.offset(0.5, 0.5, 0.5), true) } catch {}
    await sleep(80, ctx)
    await equipForHarvest(bot, block)
    await raceWithAbort(bot.dig(block, true), ctx, () => {
      if (typeof bot.stopDigging === 'function') bot.stopDigging()
    })
    dug++

    const dirs = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]
    for (const [dx, dy, dz] of dirs) {
      const next = pos.offset(dx, dy, dz)
      const key = bkey(next)
      if (seen.has(key)) continue
      seen.add(key)
      const neighbour = bot.blockAt(next)
      if (neighbour && isLogLike(neighbour)) queue.push(next)
    }
  }
  return { dug, preempted: false }
}

async function chopOneTree (bot, ctx, maxBlocks = 48, radius = 16) {
  let block = null
  for (let attempt = 0; attempt < 3 && !block; attempt++) {
    block = await findReachableBlockBy(bot, isLogLike, radius, 128, 10)
    if (block || attempt >= 2) break
    const distance = 7 + attempt * 3
    const angle = Math.random() * Math.PI * 2
    const nav = await pathNearXZ(
      bot,
      ctx,
      bot.entity.position.x + Math.sin(angle) * distance,
      bot.entity.position.z + Math.cos(angle) * distance,
      2,
      12000
    )
    if (nav && nav.preempted) return nav
  }
  if (!block) {
    const noTreeErr = new Error('附近没有可砍的树木')
    noTreeErr.code = 'NO_TREE'
    throw noTreeErr
  }
  try {
    const tool = await combat.equipBestToolForBlock(bot, block.name)
    if (!tool) await ensureWoodenToolForBlock(bot, block.name, ctx)
  } catch {}
  const result = await digReachableTree(bot, block.position, ctx, maxBlocks)
  if (result.preempted) return result
  if (!result.dug) { const e = new Error('\u627e\u5230\u4e86\u6811\u6728\uff0c\u4f46\u5f53\u524d\u89d2\u5ea6\u6216\u5730\u5f62\u4e0b\u65e0\u6cd5\u6316\u5230\u539f\u6728'); e.code = 'NO_TREE'; throw e }
  const picked = await pickupNearbyDrops(bot, ctx)
  if (picked && picked.preempted) return picked
  return result
}

async function exploreForBuildResources (bot, ctx, attempts = 3) {
  for (let i = 0; i < attempts; i++) {
    const distance = 18 + Math.floor(Math.random() * 22)
    const angle = Math.random() * Math.PI * 2
    const x = bot.entity.position.x + Math.sin(angle) * distance
    const z = bot.entity.position.z + Math.cos(angle) * distance
    const nav = await pathNearXZ(bot, ctx, x, z, 2, 12000)
    if (nav && nav.preempted) return nav
    if (nav && !nav.ok) continue
    return true
  }
  return false
}

async function gatherAndCraftPlanks (bot, material, ctx, need) {
  for (let attempt = 0; attempt < 5; attempt++) {
    let log = findLogItem(bot, material)
    if (!log) {
      try {
        const chop = await chopOneTree(bot, ctx)
        if (chop && chop.preempted) return chop
      } catch (err) {
        if (err && (err.code === 'ABORT_ERR' || ctx?.signal?.aborted)) throw err
        if (attempt >= 3 || !(err && (err.code === 'NO_TREE' || String(err.message || '').includes('附近没有可砍')))) throw err
        const moved = await exploreForBuildResources(bot, ctx, 6)
        if (moved && moved.preempted) return moved
        continue
      }
      log = findLogItem(bot, material)
    }
    if (log) await craftPlanksFromLog(bot, log, need, ctx)
    const planks = findPlankItem(bot, material)
    if (planks && countItemByName(bot, planks.name) >= need) return planks.name
  }
  return null
}

function isWoodMaterialRequest (material) {
  if (!material) return true
  const m = String(material).toLowerCase()
  return m.includes('log') || m.includes('planks') || m.includes('wood') || m.includes('stem') || m.includes('hyphae') || m.includes('mushroom')
}

async function ensureBuildMaterial (bot, material, ctx, need) {
  const current = chooseBuildBlock(bot, material, need)
  if (current && countItemByName(bot, current.name) >= need) {
    return { material: current.name }
  }

  if (isWoodMaterialRequest(material)) {
    const planks = await gatherAndCraftPlanks(bot, material, ctx, need)
    if (planks && planks.preempted) return planks
    if (planks) {
      const item = chooseBuildBlock(bot, material, need)
      if (item && countItemByName(bot, item.name) >= need) return { material: item.name }
    }
  }

  const fallback = chooseBuildBlock(bot, material, need)
  if (fallback) return { material: fallback.name }
  return null
}


async function digConnected (bot, start, predicate, ctx, limit = 64, options = {}) {
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
    if (dist > 3.5 && !(options.threeDimensional && !blockVisible(bot, block))) {
      const nav = options.threeDimensional
        ? await pathNear(bot, ctx, block.position.x, block.position.y, block.position.z, 2.5, 30000)
        : await pathNear(bot, ctx, block.position.x, block.position.y, block.position.z, 2.5, 20000)
      if (nav && nav.preempted) return { preempted: true, reason: nav.reason || 'reactive preempt' }
      if (nav && !nav.ok) throw new Error(nav.reason || 'unable to reach target block')
    }

    if (!blockVisible(bot, block)) {
      const exposed = options.threeDimensional
        ? await exposeBlockSafely(bot, block, ctx, 48)
        : false
      if (!exposed) {
        try { await bot.lookAt(block.position.offset(0.5, 0.5, 0.5), true) } catch {}
        await sleep(150, ctx)
        if (!blockVisible(bot, block)) continue
      }
    }

    await equipForHarvest(bot, block)
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

async function digDownForOreSearch (bot, ctx, maxSteps = 6) {
  const here = bot.entity.position
  const x = Math.floor(here.x)
  const z = Math.floor(here.z)
  const topY = Math.floor(here.y)
  const steps = Math.max(2, Math.min(6, Number.isFinite(maxSteps) ? Math.floor(maxSteps) : 6))
  let dug = 0
  for (let i = 0; i < steps; i++) {
    throwIfAborted(ctx)
    const digY = topY - 1 - i
    const digBlock = bot.blockAt(new Vec3(x, digY, z))
    if (!digBlock) break
    const name = lowerBlockName(digBlock)
    if (digBlock.boundingBox === 'empty' || name === 'lava' || name === 'water' || name.endsWith('_lava') || name.endsWith('_water')) break
    if (digBlock.diggable === false || name === 'bedrock') break
    // The block the bot would land on must also be solid and hazard-free so it
    // never falls into an open cave, lava pool or water pocket.
    const landing = bot.blockAt(new Vec3(x, digY - 1, z))
    if (!landing) break
    const landingName = lowerBlockName(landing)
    if (landing.boundingBox === 'empty' || landingName === 'lava' || landingName === 'water' || landingName.endsWith('_lava') || landingName.endsWith('_water') || landingName === 'bedrock') break
    try { await combat.equipBestToolForBlock(bot, digBlock.name) } catch {}
    await raceWithAbort(bot.dig(digBlock, true), ctx, () => {
      if (typeof bot.stopDigging === 'function') bot.stopDigging()
    })
    dug++
    await sleep(150, ctx)
  }
  return { dug, preempted: false }
}

function isDeepOreName (name) {
  const n = canonicalOreName(name)
  return ['iron_ore', 'gold_ore', 'diamond_ore', 'redstone_ore', 'lapis_ore', 'emerald_ore', 'copper_ore', 'ancient_debris', 'nether_quartz_ore', 'nether_gold_ore'].includes(n)
}

async function descendForDeepOre (bot, predicate, ctx, targetY = 16, maxRounds = 14) {
  const hardFloor = Math.max(1, Math.min(32, Number.isFinite(targetY) ? Math.floor(targetY) : 16))
  let rounds = 0
  while (rounds < maxRounds) {
    throwIfAborted(ctx)
    rounds++
    const block = findNearestBlockBy(bot, predicate, 24, 256)
    if (block) return { found: block, preempted: false }
    if (Math.floor(bot.entity.position.y) <= hardFloor) break
    const down = await digDownForOreSearch(bot, ctx, 4)
    if (down && down.preempted) return { found: null, preempted: true, reason: down.reason || 'reactive preempt' }
    if (!down || down.dug === 0) break
  }
  const final = findNearestBlockBy(bot, predicate, 24, 256)
  return { found: final || null, preempted: false }
}

async function equipBuildBlock (bot, item) {
  if (!item) return false
  const held = bot.heldItem
  if (!held || held.name !== item.name) {
    await bot.equip(item, 'hand')
    await sleep(80)
  }
  return true
}

function findBuildSupport (bot, pos) {
  const offsets = [
    { off: [0, -1, 0], face: [0, 1, 0] },
    { off: [1, 0, 0], face: [-1, 0, 0] },
    { off: [-1, 0, 0], face: [1, 0, 0] },
    { off: [0, 0, 1], face: [0, 0, -1] },
    { off: [0, 0, -1], face: [0, 0, 1] }
  ]
  for (const o of offsets) {
    const ref = bot.blockAt(pos.offset(o.off[0], o.off[1], o.off[2]))
    if (!ref || ref.boundingBox === 'empty') continue
    const n = lowerBlockName(ref)
    if (n.includes('water') || n.includes('lava')) continue
    return { ref, face: new Vec3(o.face[0], o.face[1], o.face[2]) }
  }
  return null
}

async function placeBuildBlockAt (bot, pos, ctx, material) {
  throwIfAborted(ctx)
  const block = bot.blockAt(pos)
  if (!block) throw new Error('\u76ee\u6807\u653e\u7f6e\u4f4d\u7f6e\u4e0d\u5b58\u5728')
  if (block.boundingBox !== 'empty') return false
  const support = findBuildSupport(bot, pos)
  if (!support) return false

  const dist = bot.entity.position.distanceTo(pos)
  if (dist > 3.5) {
    const nav = await pathNearXZ(bot, ctx, pos.x, pos.z, 2.5, 45000)
    if (nav && nav.preempted) return nav
    if (nav && !nav.ok) throw new Error(nav.reason || '\u5bfb\u8def\u5230\u653e\u7f6e\u70b9\u5931\u8d25')
  }

  const item = chooseBuildBlock(bot, material)
  if (!item) throw new Error(material ? '\u80cc\u5305\u91cc\u6ca1\u6709\u6307\u5b9a\u5efa\u6750: ' + material : '\u80cc\u5305\u91cc\u6ca1\u6709\u53ef\u7528\u4e8e\u5efa\u7b51\u7684\u65b9\u5757')
  await equipBuildBlock(bot, item)
  try { await bot.lookAt(pos.offset(0.5, 0.5, 0.5), true) } catch {}
  await raceWithAbort(bot.placeBlock(support.ref, support.face), ctx, () => {})
  return true
}

async function placeBuildBlock (bot, pos, ctx, material) {
  const r = await placeBuildBlockAt(bot, pos, ctx, material)
  if (r && r.preempted) throw abortError(r.reason || 'reactive preempt')
  return r === true
}

async function placeSpecificItemAt (bot, pos, ctx, item) {
  throwIfAborted(ctx)
  const block = bot.blockAt(pos)
  if (!block || block.boundingBox !== 'empty') return false
  const support = findBuildSupport(bot, pos)
  if (!support) return false

  const dist = bot.entity.position.distanceTo(pos)
  if (dist > 3.5) {
    const nav = await pathNearXZ(bot, ctx, pos.x, pos.z, 2.5, 45000)
    if (nav && nav.preempted) return nav
    if (nav && !nav.ok) return false
  }

  if (!(await equipBuildBlock(bot, item))) return false
  try { await bot.lookAt(pos.offset(0.5, 0.5, 0.5), true) } catch {}
  try {
    await raceWithAbort(bot.placeBlock(support.ref, support.face), ctx, () => {})
    return true
  } catch (err) {
    if (err?.code === 'ABORT_ERR' || ctx?.signal?.aborted) throw err
    return false
  }
}

async function ensureCraftingTableItem (bot, ctx) {
  if (findInventoryItemByName(bot, 'crafting_table')) return true
  if (countMaterialFamily(bot, '_planks') < 4) {
    const planks = await gatherAndCraftPlanks(bot, null, ctx, 6)
    if (planks && planks.preempted) throw abortError(planks.reason || 'reactive preempt')
  }
  if (countMaterialFamily(bot, '_planks') < 4) return false
  await craftItem(bot, 'crafting_table', ctx, 1, null)
  await sleep(200, ctx)
  return !!findInventoryItemByName(bot, 'crafting_table')
}

async function ensureDoorItem (bot, ctx) {
  const existing = bot.inventory.items().find(i => String(i && i.name || '').toLowerCase().endsWith(DOOR_ITEM_SUFFIX))
  if (existing) return existing
  if (countMaterialFamily(bot, '_planks') < 6) {
    const planks = await gatherAndCraftPlanks(bot, null, ctx, 6)
    if (planks && planks.preempted) throw abortError(planks.reason || 'reactive preempt')
  }
  if (countMaterialFamily(bot, '_planks') < 6) return null
  const ok = await craftItem(bot, 'oak_door', ctx, 1, null)
  await sleep(200, ctx)
  return ok ? (bot.inventory.items().find(i => String(i && i.name || '').toLowerCase().endsWith(DOOR_ITEM_SUFFIX)) || null) : null
}

async function ensureLightItem (bot, ctx) {
  const existing = bot.inventory.items().find(i => LIGHT_ITEM_NAMES.has(String(i && i.name || '').toLowerCase()))
  if (existing) return existing
  const byName = getItemsByName(bot)
  if (!byName.torch) return null
  const hasStick = countItemByName(bot, 'stick') > 0
  const hasCoal = countItemByName(bot, 'coal') > 0 || countItemByName(bot, 'charcoal') > 0
  if (!hasStick || !hasCoal) return null
  const ok = await craftItem(bot, 'torch', ctx, 4, null)
  await sleep(200, ctx)
  return ok ? (bot.inventory.items().find(i => LIGHT_ITEM_NAMES.has(String(i && i.name || '').toLowerCase())) || null) : null
}

async function furnishHouse (bot, args, ctx) {
  const seen = new Set()
  let placed = 0
  for (const entry of houseFurniturePositions(bot, args)) {
    throwIfAborted(ctx)
    const pos = new Vec3(Math.floor(entry.pos.x), Math.floor(entry.pos.y), Math.floor(entry.pos.z))
    const key = posKeyBuild(pos)
    if (seen.has(key)) continue
    seen.add(key)

    let item = null
    if (entry.type === 'door') {
      item = bot.inventory.items().find(i => String(i && i.name || '').toLowerCase().endsWith(DOOR_ITEM_SUFFIX)) || null
      if (!item) {
        try { item = await ensureDoorItem(bot, ctx) } catch (err) {
          if (err?.code === 'ABORT_ERR' || ctx?.signal?.aborted) throw err
          item = null
        }
      }
    } else if (entry.type === 'light') {
      item = bot.inventory.items().find(i => LIGHT_ITEM_NAMES.has(String(i && i.name || '').toLowerCase())) || null
      if (!item) {
        try { item = await ensureLightItem(bot, ctx) } catch (err) {
          if (err?.code === 'ABORT_ERR' || ctx?.signal?.aborted) throw err
          item = null
        }
      }
    } else if (entry.type === 'crafting_table') {
      item = findInventoryItemByName(bot, 'crafting_table')
      if (!item) {
        try {
          await ensureCraftingTableItem(bot, ctx)
          item = findInventoryItemByName(bot, 'crafting_table')
        } catch (err) {
          if (err?.code === 'ABORT_ERR' || ctx?.signal?.aborted) throw err
          item = null
        }
      }
    } else if (entry.type === 'window') {
      item = bot.inventory.items().find(i => {
        const n = String(i && i.name || '').toLowerCase()
        return n === 'glass_pane' || n === 'glass'
      }) || null
    } else if (entry.type === 'roof_log') {
      item = bot.inventory.items().find(i => isLogItem(i)) || null
    }
    if (!item) continue

    const r = await placeSpecificItemAt(bot, pos, ctx, item)
    if (r && r.preempted) return r
    if (r === true) placed++
  }
  return { placed }
}

function clampInt (value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, Math.floor(n)))
}

function cardinalDirection (bot, requested) {
  if (requested && ['north', 'south', 'east', 'west'].includes(String(requested).toLowerCase())) {
    return String(requested).toLowerCase()
  }
  const yaw = ((Number(bot.entity?.yaw) || 0) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2)
  if (yaw >= Math.PI / 4 && yaw < Math.PI * 3 / 4) return 'west'
  if (yaw >= Math.PI * 3 / 4 && yaw < Math.PI * 5 / 4) return 'north'
  if (yaw >= Math.PI * 5 / 4 && yaw < Math.PI * 7 / 4) return 'east'
  return 'south'
}

const DIR_VECTORS = {
  north: [0, -1],
  south: [0, 1],
  east: [1, 0],
  west: [-1, 0]
}

function posKeyBuild (pos) {
  return Math.floor(pos.x) + ',' + Math.floor(pos.y) + ',' + Math.floor(pos.z)
}

async function placeMany (bot, positions, ctx, material) {
  const seen = new Set()
  const list = []
  for (const pos of positions || []) {
    const key = posKeyBuild(pos)
    if (seen.has(key)) continue
    seen.add(key)
    list.push(new Vec3(Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z)))
  }
  list.sort((a, b) => {
    const dy = a.y - b.y
    if (dy !== 0) return dy
    return bot.entity.position.distanceTo(a) - bot.entity.position.distanceTo(b)
  })

  let pending = list
  let placed = 0
  let skipped = 0
  for (let pass = 0; pass < 6 && pending.length; pass++) {
    const next = []
    // Try supported blocks before unsupported ones on each pass. This makes
    // walls and roof rings finish first, then interior roof blocks can attach
    // to them on a later pass instead of being skipped forever.
    const ordered = pending.slice().sort((a, b) => {
      const dy = a.y - b.y
      if (dy !== 0) return dy
      const sa = findBuildSupport(bot, a) ? 0 : 1
      const sb = findBuildSupport(bot, b) ? 0 : 1
      if (sa !== sb) return sa - sb
      return bot.entity.position.distanceTo(a) - bot.entity.position.distanceTo(b)
    })
    for (const pos of ordered) {
      throwIfAborted(ctx)
      const current = bot.blockAt(pos)
      if (!current || current.boundingBox !== 'empty') {
        skipped++
        continue
      }
      try {
        const r = await placeBuildBlockAt(bot, pos, ctx, material)
        if (r && r.preempted) return r
        if (r === true) placed++
        else next.push(pos)
      } catch (err) {
        if (err?.code === 'ABORT_ERR' || ctx?.signal?.aborted) throw err
        next.push(pos)
      }
    }
    pending = next
  }
  skipped += pending.length
  return { placed, skipped }
}

function houseLayout (bot, args) {
  const sizeX = clampInt(args.width ?? args.size, 3, 15, 5)
  const sizeZ = clampInt(args.depth ?? args.size, 3, 15, 5)
  const height = clampInt(args.height, 2, 8, 3)
  const dir = cardinalDirection(bot, args.direction)
  const [fdx, fdz] = DIR_VECTORS[dir]
  const rdx = fdz
  const rdz = -fdx

  const bx = Math.floor(bot.entity.position.x)
  const by = Math.floor(bot.entity.position.y)
  const bz = Math.floor(bot.entity.position.z)
  const halfW = Math.floor(sizeX / 2)
  const gap = clampInt(args.gap, 2, 6, 3)

  // The front wall is always a few blocks in front of the bot, and the house
  // extends away from it. This keeps the doorway reachable for every size.
  const frontX = bx + fdx * gap
  const frontZ = bz + fdz * gap
  const world = (a, z, y) => new Vec3(frontX + rdx * a + fdx * z, y, frontZ + rdz * a + fdz * z)

  return {
    sizeX,
    sizeZ,
    height,
    halfW,
    frontX,
    frontZ,
    world,
    floorY: by - 1,
    by,
    centerZ: Math.floor(sizeZ / 2)
  }
}

function buildHousePositions (bot, args) {
  const L = houseLayout(bot, args)
  const positions = []
  const windows = args.windows !== false

  // 1) Floor, one block below the bot's feet so it has somewhere solid to stand.
  for (let a = -L.halfW; a <= L.halfW; a++) {
    for (let z = 0; z < L.sizeZ; z++) positions.push(L.world(a, z, L.floorY))
  }

  // 2) Four walls with a two-block front door and optional side/back windows.
  for (let a = -L.halfW; a <= L.halfW; a++) {
    for (let z = 0; z < L.sizeZ; z++) {
      const perimeter = a === -L.halfW || a === L.halfW || z === 0 || z === L.sizeZ - 1
      if (!perimeter) continue
      for (let y = L.by; y <= L.by + L.height - 1; y++) {
        const isDoor = z === 0 && a === 0 && (y === L.by || y === L.by + 1)
        if (isDoor) continue
        const isWindow = windows && y === L.by + 1 && (
          ((a === -L.halfW || a === L.halfW) && z === L.centerZ) ||
          (z === L.sizeZ - 1 && a === 0)
        )
        if (isWindow) continue
        positions.push(L.world(a, z, y))
      }
    }
  }

  // 3) Full interior ceiling at the top of the walls.
  const roofY = L.by + L.height
  for (let a = -L.halfW; a <= L.halfW; a++) {
    for (let z = 0; z < L.sizeZ; z++) positions.push(L.world(a, z, roofY))
  }

  // 4) Roof eaves: extend the ceiling one block outward on all sides.
  for (let a = -L.halfW - 1; a <= L.halfW + 1; a++) {
    for (let z = -1; z <= L.sizeZ; z++) {
      const inside = a >= -L.halfW && a <= L.halfW && z >= 0 && z < L.sizeZ
      if (inside) continue
      positions.push(L.world(a, z, roofY))
    }
  }

  // 5) Pitched roof. Each higher layer steps inward from the front/back, so the
  // house gets a proper ridge and gable ends instead of a flat box lid.
  const layers = Math.max(1, Math.floor((L.sizeZ + 1) / 2))
  for (let r = 0; r < layers; r++) {
    const y = roofY + 1 + r
    const zStart = r
    const zEnd = L.sizeZ - 1 - r
    if (zStart > zEnd) break
    for (let a = -L.halfW; a <= L.halfW; a++) {
      for (let z = zStart; z <= zEnd; z++) positions.push(L.world(a, z, y))
    }
  }

  return positions
}
function houseFurniturePositions (bot, args) {
  const L = houseLayout(bot, args)
  const windows = args.windows !== false
  const out = []

  // Interior items first: the doorway is still open, so the bot can walk inside
  // before a real door block is placed.
  if (L.sizeX >= 4 && L.sizeZ >= 4) {
    out.push({ pos: L.world(0, 1, L.by), type: 'crafting_table' })
  }

  // Torches/lighting make the house livable and stop mobs spawning inside.
  if (L.sizeX >= 5 && L.sizeZ >= 5) {
    out.push({ pos: L.world(-1, 1, L.by), type: 'light' })
    out.push({ pos: L.world(1, 1, L.by), type: 'light' })
    out.push({ pos: L.world(0, L.sizeZ - 2, L.by), type: 'light' })
  } else if (L.sizeX >= 3 && L.sizeZ >= 3) {
    out.push({ pos: L.world(0, Math.max(1, L.sizeZ - 2), L.by), type: 'light' })
  }

  // Glass windows fill the holes intentionally left in buildHousePositions.
  if (windows) {
    out.push({ pos: L.world(-L.halfW, L.centerZ, L.by + 1), type: 'window' })
    out.push({ pos: L.world(L.halfW, L.centerZ, L.by + 1), type: 'window' })
    out.push({ pos: L.world(0, L.sizeZ - 1, L.by + 1), type: 'window' })
  }

  // Log ridge cap. The roof planks are already placed, so put a decorative log
  // line one block above the highest roof layer; it can attach to the roof below.
  const roofY = L.by + L.height
  const roofLayers = Math.max(1, Math.floor((L.sizeZ + 1) / 2))
  const capY = roofY + 1 + roofLayers
  const ridgeStart = Math.floor((L.sizeZ - 1) / 2)
  const ridgeEnd = Math.ceil((L.sizeZ - 1) / 2)
  for (let a = -L.halfW; a <= L.halfW; a++) {
    for (let z = ridgeStart; z <= ridgeEnd; z++) {
      out.push({ pos: L.world(a, z, capY), type: 'roof_log' })
    }
  }

  // Lanterns/torches beside the front door make the entrance visible at night.
  out.push({ pos: L.world(-1, -1, L.by), type: 'light' })
  out.push({ pos: L.world(1, -1, L.by), type: 'light' })

  // Real front door fills the two-block gap left in buildHousePositions. Place
  // it last so it does not interfere with reaching the interior.
  out.push({ pos: L.world(0, 0, L.by), type: 'door' })

  return out
}
function buildTowerPositions (bot, args) {
  const size = clampInt(args.size ?? args.width, 3, 9, 3)
  const height = clampInt(args.height, 3, 16, 6)
  const bx = Math.floor(bot.entity.position.x)
  const by = Math.floor(bot.entity.position.y)
  const bz = Math.floor(bot.entity.position.z)
  const minX = bx - Math.floor(size / 2)
  const maxX = minX + size - 1
  const minZ = bz - Math.floor(size / 2)
  const maxZ = minZ + size - 1
  const positions = []
  const centerX = bx
  const doorZ = maxZ

  for (let y = by; y < by + height; y++) {
    for (let x = minX; x <= maxX; x++) {
      for (let z = minZ; z <= maxZ; z++) {
        const perimeter = x === minX || x === maxX || z === minZ || z === maxZ
        if (!perimeter) continue

        const isDoor = x === centerX && z === doorZ && (y === by || y === by + 1)
        if (isDoor) continue

        // Narrow arrow-slit windows on every side, one block above the door.
        const windowY = by + 2
        const onXFace = (x === minX || x === maxX) && z === bz
        const onZFace = (z === minZ || z === maxZ) && x === bx
        if (y === windowY && (onXFace || onZFace)) continue

        positions.push(new Vec3(x, y, z))
      }
    }
  }

  // Battlement/crenellation ring on top. It reads as a watchtower rather than a
  // hollow tube, and gives archers/observers cover while keeping the corners.
  const topY = by + height
  for (let x = minX; x <= maxX; x++) {
    for (let z = minZ; z <= maxZ; z++) {
      const perimeter = x === minX || x === maxX || z === minZ || z === maxZ
      if (!perimeter) continue
      const even = (x + z) % 2 === 0
      if (even) positions.push(new Vec3(x, topY, z))
    }
  }

  return positions
}
function buildBridgePositions (bot, args) {
  const length = clampInt(args.length, 2, 32, 8)
  const width = clampInt(args.width, 1, 5, 1)
  const dir = cardinalDirection(bot, args.direction)
  const [dx, dz] = DIR_VECTORS[dir]
  const bx = Math.floor(bot.entity.position.x)
  const by = Math.floor(bot.entity.position.y)
  const bz = Math.floor(bot.entity.position.z)
  const y = by - 1
  const positions = []
  const lateral = dir === 'north' || dir === 'south'
  for (let i = 1; i <= length; i++) {
    const cx = bx + dx * i
    const cz = bz + dz * i
    for (let w = 0; w < width; w++) {
      const offset = w - Math.floor((width - 1) / 2)
      const px = lateral ? cx + offset : cx
      const pz = lateral ? cz : cz + offset
      positions.push(new Vec3(px, y, pz))

      // Low side rails make a bridge read as a bridge. For a one-block walkway
      // the rails are omitted so the bot does not get stuck against them.
      if (width > 1 && (w === 0 || w === width - 1)) {
        positions.push(new Vec3(px, y + 1, pz))
      }
    }
  }
  return positions
}
function buildWallPositions (bot, args) {
  const length = clampInt(args.length, 2, 32, 8)
  const height = clampInt(args.height, 1, 10, 3)
  const dir = cardinalDirection(bot, args.direction)
  const [dx, dz] = DIR_VECTORS[dir]
  const bx = Math.floor(bot.entity.position.x)
  const by = Math.floor(bot.entity.position.y)
  const bz = Math.floor(bot.entity.position.z)
  const startX = bx + dx * 2
  const startZ = bz + dz * 2
  const y0 = by
  const positions = []
  const half = Math.floor(length / 2)

  for (let i = 0; i < length; i++) {
    const along = i - half
    const northSouth = dir === 'north' || dir === 'south'
    const px = northSouth ? startX + along : startX
    const pz = northSouth ? startZ : startZ + along

    for (let y = y0; y < y0 + height; y++) {
      // A two-block gate at the middle lets the bot and its owner pass through
      // while the rest of the wall still reads as a defensive line.
      const gate = along === 0 && (y === y0 || y === y0 + 1)
      if (gate) continue
      positions.push(new Vec3(px, y, pz))
    }

    // Crenellations on top give the wall a castle look instead of a plain slab.
    if (i % 2 === 0) positions.push(new Vec3(px, y0 + height, pz))
  }

  return positions
}
async function lookAtTarget (bot, args) {
  let entity = null
  if (args.username) {
    const p = findPlayer(bot, args.username)
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

function setPathfinderGoal (bot, acq, goal, { movements, dynamic = false } = {}) {
  const installed = bot.pathfinderOwner.setGoal(acq.token, goal, { movements, dynamic })
  if (!installed) return { ok: false, reason: 'pathfinder setGoal 被拒绝' }
  return { ok: true }
}

function goalSatisfied (bot) {
  const goal = bot && bot.pathfinder && bot.pathfinder.goal
  const position = bot && bot.entity && bot.entity.position
  if (!goal || !position || typeof goal.isEnd !== 'function') return false
  try {
    const floored = position.floored()
    return goal.isEnd(floored) || goal.isEnd(floored.offset(0, 1, 0))
  } catch {
    return false
  }
}

function waitForGoal (bot, ctx, timeoutMs = 60000) {
  return new Promise(resolve => {
    let settled = false
    let timer = null
    let poll = null
    let partialPathAt = 0
    let partialStatus = ''
    let sawPathAt = 0
    let lastPathStatus = ''
    let lastMotionAt = Date.now()
    let lastPosition = bot.entity?.position?.clone?.() || null

    const cleanup = () => {
      if (timer) clearTimeout(timer)
      if (poll) clearInterval(poll)
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
      if (!r) return
      const hasUsablePath = Array.isArray(r.path) && r.path.length > 0
      sawPathAt = Date.now()
      lastPathStatus = String(r.status || '')
      if ((r.status === 'partial' || r.status === 'timeout' || r.status === 'noPath') && hasUsablePath) {
        // Let the bot walk the best partial path before replanning. Previously a
        // timeout/noPath result was stopped immediately, so mountainous routes failed
        // without using the path that A* had already found.
        partialPathAt = Date.now()
        partialStatus = r.status
        return
      }
      if (r.status === 'noPath') {
        finish('noPath')
        return
      }
      // An empty timeout means the bounded A* slice did not reach even a
      // useful node yet.  Do not report failure immediately: the pathfinder
      // can replan from the same position on the next tick.  The caller has a
      // finite retry budget, so an actually impossible route still exits.
      if (r.status === 'timeout') finish('timeout', { retryable: !hasUsablePath })
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

    poll = setInterval(() => {
      if (goalSatisfied(bot)) {
        finish('reached')
        return
      }
      const now = Date.now()
      const currentPosition = bot.entity?.position
      if (lastPosition && currentPosition) {
        const moved = currentPosition.distanceTo(lastPosition)
        if (moved >= 0.18) {
          lastMotionAt = now
          lastPosition = currentPosition.clone()
        }
      }
      let moving = false
      try { moving = !!bot.pathfinder.isMoving() } catch {}
      if (partialPathAt && !moving && now - partialPathAt >= 750) {
        finish('partial', { status: partialStatus, retryable: true })
        return
      }
      // A path can be computed successfully yet remain stuck on its first
      // movement node (water edge, fence, stale block update, etc.). Waiting
      // the full action timeout only repeats the same failure. Replan quickly
      // from the live position and let the caller try another direction.
      if (sawPathAt && now - sawPathAt >= 1000 && now - lastMotionAt >= 2800) {
        finish('stalled', { status: lastPathStatus, retryable: true })
      }
    }, 100)
    timer = setTimeout(() => finish('timeout'), timeoutMs)
  })
}

function horizontalDistanceTo (bot, x, z) {
  const dx = Number(bot.entity.position.x) - Number(x)
  const dz = Number(bot.entity.position.z) - Number(z)
  return Math.sqrt(dx * dx + dz * dz)
}

function spatialDistanceTo (bot, x, y, z) {
  const dx = Number(bot.entity.position.x) - Number(x)
  const dy = Number(bot.entity.position.y) - Number(y)
  const dz = Number(bot.entity.position.z) - Number(z)
  return Math.sqrt(dx * dx + dy * dy + dz * dz)
}

function localWaypointXZ (bot, x, z, maxStep = 6) {
  const p = bot.entity.position
  const dx = Number(x) - Number(p.x)
  const dz = Number(z) - Number(p.z)
  const distance = Math.hypot(dx, dz)
  if (!Number.isFinite(distance) || distance <= maxStep) return { x: Number(x), z: Number(z), final: true }
  return {
    x: Number(p.x) + dx / distance * maxStep,
    z: Number(p.z) + dz / distance * maxStep,
    final: false
  }
}

function localWaypoint3D (bot, x, y, z, maxStep = 6) {
  const p = bot.entity.position
  const dx = Number(x) - Number(p.x)
  const dy = Number(y) - Number(p.y)
  const dz = Number(z) - Number(p.z)
  const distance = Math.sqrt(dx * dx + dy * dy + dz * dz)
  if (!Number.isFinite(distance) || distance <= maxStep) {
    return { x: Number(x), y: Number(y), z: Number(z), final: true }
  }
  const horizontal = Math.hypot(dx, dz)
  const horizontalScale = horizontal > 0.01 ? Math.min(1, maxStep / horizontal) : 0
  return {
    x: Number(p.x) + dx * horizontalScale,
    y: Number(p.y) + Math.max(-2, Math.min(2, dy * Math.max(horizontalScale, 0.35))),
    z: Number(p.z) + dz * horizontalScale,
    final: false
  }
}

async function pathNearXZ (bot, ctx, x, z, range = 2.5, timeoutMs = 60000) {
  if (!bot.pathfinder) throw new Error('pathfinder \u672a\u52a0\u8f7d')
  const acquired = acquirePathfinder(bot, ctx, 'navigate-xz')
  if (!acquired.ok) return acquired
  const acq = acquired.acq
  const deadline = Date.now() + Math.max(1000, timeoutMs)
  let bestDistance = horizontalDistanceTo(bot, x, z)
  let lastReason = '\u5bfb\u8def\u672a\u5b8c\u6210'
  let stagnantRetries = 0
  const maxSegments = Math.max(4, Math.min(16, Math.ceil(bestDistance / 5) + 4))
  try {
    for (let attempt = 0; attempt < maxSegments && Date.now() < deadline; attempt++) {
      const remaining = Math.max(500, deadline - Date.now())
      const waypoint = localWaypointXZ(bot, x, z, 6)
      const goalRange = waypoint.final ? range + Math.min(1, attempt * 0.15) : 1.25
      const goal = new goals.GoalNearXZ(waypoint.x, waypoint.z, goalRange)
      const installed = setPathfinderGoal(bot, acq, goal)
      if (!installed.ok) return { ok: false, reason: installed.reason }
      const r = await waitForGoal(bot, ctx, Math.min(7000, remaining))
      if (r.kind === 'preempted') return { preempted: true, reason: 'reactive \u62a2\u5360\u8def\u5f84' }
      const currentDistance = horizontalDistanceTo(bot, x, z)
      if (currentDistance <= range + 0.8) return { ok: true }
      const progress = bestDistance - currentDistance
      bestDistance = Math.min(bestDistance, currentDistance)
      lastReason = '\u5bfb\u8def\u5931\u8d25: ' + r.kind
      if (progress >= 0.35 && Date.now() + 500 < deadline) {
        stagnantRetries = 0
        continue
      }
      if ((r.kind === 'reached' || r.retryable) && ++stagnantRetries <= 1 && Date.now() + 500 < deadline) continue
      return { ok: false, reason: lastReason }
    }
    return bestDistance <= range + 0.8 ? { ok: true } : { ok: false, reason: lastReason }
  } finally {
    if (bot.pathfinder.movements) bot.pathfinder.movements.canDig = false
    acq.release()
  }
}

async function pathNear (bot, ctx, x, y, z, range = 1, timeoutMs = 60000) {
  if (!bot.pathfinder) throw new Error('pathfinder \u672a\u52a0\u8f7d')
  const acquired = acquirePathfinder(bot, ctx, 'navigate')
  if (!acquired.ok) return acquired
  const acq = acquired.acq
  const deadline = Date.now() + Math.max(1000, timeoutMs)
  let bestDistance = spatialDistanceTo(bot, x, y, z)
  let lastReason = '\u5bfb\u8def\u672a\u5b8c\u6210'
  let stagnantRetries = 0
  const maxSegments = Math.max(4, Math.min(16, Math.ceil(bestDistance / 5) + 4))
  try {
    for (let attempt = 0; attempt < maxSegments && Date.now() < deadline; attempt++) {
      const remaining = Math.max(500, deadline - Date.now())
      const waypoint = localWaypoint3D(bot, x, y, z, 6)
      const goalRange = waypoint.final ? range + Math.min(1, attempt * 0.15) : 1.5
      const goal = new goals.GoalNear(waypoint.x, waypoint.y, waypoint.z, goalRange)
      const installed = setPathfinderGoal(bot, acq, goal)
      if (!installed.ok) return { ok: false, reason: installed.reason }
      const r = await waitForGoal(bot, ctx, Math.min(7000, remaining))
      if (r.kind === 'preempted') return { preempted: true, reason: 'reactive \u62a2\u5360\u8def\u5f84' }
      const currentDistance = spatialDistanceTo(bot, x, y, z)
      if (currentDistance <= range + 0.9) return { ok: true }
      const progress = bestDistance - currentDistance
      bestDistance = Math.min(bestDistance, currentDistance)
      lastReason = '\u5bfb\u8def\u5931\u8d25: ' + r.kind
      if (progress >= 0.35 && Date.now() + 500 < deadline) {
        stagnantRetries = 0
        continue
      }
      if ((r.kind === 'reached' || r.retryable) && ++stagnantRetries <= 1 && Date.now() + 500 < deadline) continue
      return { ok: false, reason: lastReason }
    }
    return bestDistance <= range + 0.9 ? { ok: true } : { ok: false, reason: lastReason }
  } finally {
    if (bot.pathfinder.movements) bot.pathfinder.movements.canDig = false
    acq.release()
  }
}

function formatInventoryText (bot) {
  const info = observations.inventoryInfo(bot)
  const items = Array.isArray(info.items) ? info.items : []
  const lines = items.slice(0, 36).map(i => (i.displayName || i.name) + ' x' + i.count).join('\u3001')
  const held = info.held
    ? '\u624b\u6301 ' + (info.held.displayName || info.held.name) + ' x' + info.held.count
    : '\u624b\u6301 \u65e0'
  const armor = info.armor || {}
  const armorParts = []
  for (const slot of ['head', 'torso', 'legs', 'feet']) {
    const item = armor.slots && armor.slots[slot]
    if (item) armorParts.push(item.name)
  }
  const armorText = armorParts.length ? '\u62a4\u7532 ' + armorParts.join('/') : '\u62a4\u7532 \u65e0'
  const weaponText = info.weapon && info.weapon.name ? '\u6b66\u5668 ' + info.weapon.name : '\u6b66\u5668 \u65e0'
  const shieldText = info.shield ? '\u76fe\u724c \u6709' : '\u76fe\u724c \u65e0'
  return held + '\uff1b\u80cc\u5305\uff1a' + (lines || '\u7a7a') + '\uff1b' + armorText + '\uff1b' + weaponText + '\uff1b' + shieldText
}

function chooseReachableExploreTarget (bot, distance, preferredDirection = '') {
  const p = bot.entity.position
  const vectors = {
    north: [0, -1],
    south: [0, 1],
    east: [1, 0],
    west: [-1, 0]
  }
  const ordered = []
  if (vectors[preferredDirection]) ordered.push(preferredDirection)
  for (const name of ['north', 'south', 'east', 'west']) if (!ordered.includes(name)) ordered.push(name)
  // Diagonals often provide a route around a cliff face that blocks all four
  // straight target points; the intermediate octants add even more escape
  // angles when mountains or water trap the bot.
  const diagonals = [[1, -1], [-1, -1], [1, 1], [-1, 1]]
  const intermediates = []
  for (let i = 0; i < 8; i++) {
    const angle = (Math.PI * (2 * i + 1)) / 16
    intermediates.push([Math.cos(angle), Math.sin(angle)])
  }
  const candidates = ordered.map(name => ({ name, vector: vectors[name] }))
    .concat(diagonals.map((vector, i) => ({ name: 'diagonal-' + i, vector })))
    .concat(intermediates.map((vector, i) => ({ name: 'intermediate-' + i, vector })))
  const movements = bot.pathfinder?.movements
  const originalCanDig = movements ? movements.canDig : undefined
  const originalAllow1by1Towers = movements ? movements.allow1by1towers : undefined
  // Degradation ladder: probe a shorter radius first, then allow 1x1 digging
  // as a last resort so a thin stone/dirt wall cannot dead-end exploration.
  const maxProbe = Math.min(6, distance)
  const radii = [...new Set([maxProbe, Math.min(4, distance), 2.5])]
  const stages = radii.map(radius => ({ radius, canDig: false }))
    .concat(radii.map(radius => ({ radius, canDig: true })))
  let best = null
  try {
    // Allow 1x1 tower-up during probing so pillar-climbing escape routes are
    // visible to the pathfinder; restored in finally.
    if (movements) movements.allow1by1towers = true
    for (const stage of stages) {
      if (movements && stage.canDig !== undefined) movements.canDig = stage.canDig
      for (const candidate of candidates) {
        const [rawX, rawZ] = candidate.vector
        const length = Math.hypot(rawX, rawZ) || 1
        const ux = rawX / length
        const uz = rawZ / length
        const localX = p.x + ux * stage.radius
        const localZ = p.z + uz * stage.radius
        const result = probePathResult(bot, movements, new goals.GoalNearXZ(localX, localZ, 1.25), 80)
        if (!result || !Array.isArray(result.path)) continue
        const pathLength = result.path.length
        if (result.status !== 'success' && pathLength < 2) continue
        const score = (result.status === 'success' ? 1000 : 0) + pathLength - (candidate.name === preferredDirection ? 0 : 0.25)
        if (!best || score > best.score) {
          // Degraded (shorter) probes return a closer target so the bot makes
          // incremental progress instead of failing the full distance again.
          const targetDistance = stage.radius >= maxProbe ? distance : stage.radius
          best = {
            x: p.x + ux * targetDistance,
            z: p.z + uz * targetDistance,
            direction: candidate.name,
            score
          }
        }
      }
      if (best) return best
    }
  } finally {
    if (movements && originalCanDig !== undefined) movements.canDig = originalCanDig
    if (movements && originalAllow1by1Towers !== undefined) movements.allow1by1towers = originalAllow1by1Towers
  }
  return best
}

function countInventoryItem (bot, name) {
  const n = String(name || '').toLowerCase()
  return (bot.inventory && typeof bot.inventory.items === 'function' ? bot.inventory.items() : []).reduce((sum, i) => String(i && i.name || '').toLowerCase() === n ? sum + Number(i.count || 0) : sum, 0)
}

function dimName (bot) {
  return String((bot.game && bot.game.dimension) || (bot.entity && bot.entity.dimension) || '').toLowerCase()
}

function findBlocksByPredicate (bot, predicate, radius = 16, count = 256) {
  if (!bot.findBlocks || !bot.entity) return []
  try {
    const positions = bot.findBlocks({ matching: block => { try { return !!predicate(block) } catch { return false } }, maxDistance: radius, count })
    return (positions || []).map(pos => bot.blockAt(pos)).filter(Boolean)
  } catch {
    return []
  }
}

async function ensureFurnaceBlock (bot, ctx) {
  let existing = findNearestBlockBy(bot, b => lowerBlockName(b) === 'furnace', 8, 16)
  if (existing) return existing
  await placeSpecificBlockNearby(bot, ctx, 'furnace')
  return findNearestBlockBy(bot, b => lowerBlockName(b) === 'furnace', 8, 16)
}

async function findPortalSite (bot, ctx) {
  const here = bot.entity.position
  const yaw = Number(bot.entity.yaw) || 0
  for (let i = 0; i < 8; i++) {
    const ang = yaw + (i * Math.PI / 4)
    const dx = -Math.round(Math.sin(ang)) * 4
    const dz = -Math.round(Math.cos(ang)) * 4
    const bx = Math.floor(here.x) + dx
    const bz = Math.floor(here.z) + dz
    const by = Math.floor(here.y)
    let clear = true
    for (let y = 0; y < 5 && clear; y++) {
      for (let x = 0; x < 4 && clear; x++) {
        const b = bot.blockAt(new Vec3(bx + x, by + y, bz))
        if (!b) { clear = false; break }
        if (b.boundingBox !== 'empty') { clear = false; break }
      }
    }
    if (clear) return { x: bx, y: by, z: bz }
  }
  return null
}

async function ignitePortal (bot, ctx, framePositions) {
  let igniter = findInventoryItemByName(bot, 'flint_and_steel')
  if (!igniter) igniter = findInventoryItemByName(bot, 'fire_charge')
  if (!igniter) return false
  const framePos = framePositions.find(p => {
    const b = bot.blockAt(p)
    return b && b.name && String(b.name).toLowerCase() === 'obsidian'
  }) || framePositions[0]
  if (!framePos) return false
  const frame = bot.blockAt(framePos)
  if (!frame) return false
  try { await bot.equip(igniter, 'hand') } catch { return false }
  try { await bot.lookAt(frame.position.offset(0.5, 0.5, 0.5), true) } catch {}
  try { await raceWithAbort(bot.activateBlock(frame), ctx, () => {}) } catch {}
  const deadline = Date.now() + 3000
  while (Date.now() < deadline) {
    throwIfAborted(ctx)
    if (findNearestBlockBy(bot, b => lowerBlockName(b) === 'nether_portal', 6, 16)) return true
    await sleep(200, ctx)
  }
  return !!findNearestBlockBy(bot, b => lowerBlockName(b) === 'nether_portal', 6, 16)
}

async function throwEnderEye (bot, ctx, eyeItem) {
  if (!eyeItem) return null
  try { await bot.equip(eyeItem, 'hand') } catch { return null }
  try { await bot.lookAt(bot.entity.position.offset(0, 1.5, -1), true) } catch {}
  try { await raceWithAbort(bot.activateItem(), ctx, () => {}) } catch { return null }
  const deadline = Date.now() + 4000
  while (Date.now() < deadline) {
    throwIfAborted(ctx)
    const eye = bot.nearestEntity(e => e && e.name === 'eye_of_ender')
    if (eye && eye.position) {
      const dx = eye.position.x - bot.entity.position.x
      const dz = eye.position.z - bot.entity.position.z
      const len = Math.hypot(dx, dz)
      if (len > 0.3) return { x: dx / len, z: dz / len }
    }
    await sleep(100, ctx)
  }
  return null
}


const handlers = {
  chat: async (bot, args) => {
    const message = String(args.message || '').slice(0, 100)
    if (!message) throw new Error('chat \u9700\u8981 message')
    const now = Date.now()
    bot._chatDedupe = bot._chatDedupe || {}
    if (now - (bot._chatDedupe[message] || 0) < 20000) return '\u5df2\u5ffd\u7565\u91cd\u590d\u804a\u5929'
    bot._chatDedupe[message] = now
    bot.chat(message)
    return '\u5df2\u53d1\u9001\u804a\u5929: ' + message
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
    return '\u8df3\u8dc3'
  },

  explore: async (bot, args, ctx) => {
    if (!bot.pathfinder) throw new Error('pathfinder 未加载')
    const distance = Math.max(3, Math.min(Number(args.distance ?? 8), 64))
    const dir = String(args.direction || '').toLowerCase()
    const movements = bot.pathfinder.movements
    const originalCanDig = movements ? movements.canDig : undefined
    const originalAllow1by1Towers = movements ? movements.allow1by1towers : undefined
    const originalMaxDropDown = movements ? movements.maxDropDown : undefined
    let lastReason = '探索失败'
    try {
      // Allow 1x1 tower-up and deeper drops while explore navigates so the bot
      // can pillar out of pits or climb short ledges; restored in finally.
      if (movements) movements.allow1by1towers = true
      if (movements) movements.maxDropDown = 5
      for (let attempt = 0; attempt < 3; attempt++) {
        const target = chooseReachableExploreTarget(bot, distance, attempt === 0 ? dir : '')
        if (!target) {
          // No reachable target even after distance/direction/dig degradation:
          // report a clean failure so the decision loop can switch to mining,
          // placing or crafting instead of retrying explore forever.
          return { ok: false, reason: 'no-reachable-explore-target' }
        }
        // Allow 1x1 digging only while this explore navigates so a thin
        // dirt/stone/water wall cannot stall the bot; restored in finally.
        if (movements) movements.canDig = true
        const nav = await pathNearXZ(bot, ctx, target.x, target.z, 2, 16000)
        if (nav && nav.preempted) return nav
        if (nav && nav.ok) return '已到达 ' + Math.floor(target.x) + ',' + Math.floor(target.z)
        lastReason = nav && nav.reason ? nav.reason : lastReason
      }
      return { ok: false, reason: lastReason }
    } finally {
      if (movements && originalCanDig !== undefined) movements.canDig = originalCanDig
      if (movements && originalAllow1by1Towers !== undefined) movements.allow1by1towers = originalAllow1by1Towers
      if (movements && originalMaxDropDown !== undefined) movements.maxDropDown = originalMaxDropDown
    }
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
        const p = findPlayer(bot, args.username)
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

  follow: async (bot, args, ctx) => {
    const username = String(args.username || '').trim()
    if (!username) throw new Error('follow 需要 username')
    const distance = clampInt(args.distance, 1, 8, 2)
    const durationMs = clampInt(args.durationMs, 1000, 86400000, 86400000)

    // The tracked player entity can lag behind spawn/teleports. Give the server
    // a few seconds to surface it before giving up on the command.
    const waitStart = Date.now()
    let player = findPlayer(bot, username)
    while ((!player || !player.entity) && Date.now() - waitStart < 30000) {
      await sleep(500, ctx)
      player = findPlayer(bot, username)
    }
    if (!player || !player.entity) throw new Error('找不到玩家: ' + username)

    const acquired = acquirePathfinder(bot, ctx, 'follow')
    if (!acquired.ok) return { preempted: acquired.preempted, reason: acquired.reason }
    const acq = acquired.acq
    try {
      const started = Date.now()
      let lastTargetId = null
      let lastPosition = bot.entity.position.clone()
      let lastProgressAt = Date.now()
      let bestDistance = Infinity
      let stalledReplans = 0
      let lastReplanAt = 0
      let replanDelayMs = 700
      while (Date.now() - started < durationMs) {
        throwIfAborted(ctx)
        const current = findPlayer(bot, username)
        const target = current && current.entity
        if (!target || target.isValid === false || !target.position) {
          // Player temporarily out of the tracked entity list (lag/teleport).
          await sleep(500, ctx)
          continue
        }

        const dist = bot.entity.position.distanceTo(target.position)
        const moved = bot.entity.position.distanceTo(lastPosition)
        if (moved >= 0.35 || dist < bestDistance - 0.5 || dist <= distance + 1) {
          lastProgressAt = Date.now()
          stalledReplans = 0
          bestDistance = Math.min(bestDistance, dist)
          lastPosition = bot.entity.position.clone()
        }

          const owner = bot.pathfinderOwner
        const ownerIdle = owner ? owner.isIdle() : true
        const idleWhy = owner ? String(owner.lastIdleWhy || '') : ''
        let pathMoving = false
        try { pathMoving = !!bot.pathfinder.isMoving() } catch {}
        // A timed-out A* search may still provide a partial route. Once that
        // route has been walked, replan from the new position. If the server
        // reports noPath, back off instead of resetting the same impossible
        // goal every 400 ms and starving the API/event loop.
        const now = Date.now()
        const partialRouteExhausted = dist > distance + 1 && !pathMoving && now - lastProgressAt >= 2500
        const stalled = dist > distance + 2 && now - lastProgressAt >= 12000
        const noPathBackoff = ownerIdle && idleWhy.includes('noPath') && now - lastReplanAt < 2500
        const timeoutBackoff = ownerIdle && idleWhy.includes('timeout') && now - lastReplanAt < 1200
        const canReplan = now - lastReplanAt >= replanDelayMs
        const needsReplan = lastTargetId !== target.id ||
          (!noPathBackoff && !timeoutBackoff && canReplan && dist > distance + 1 && ownerIdle) ||
          (canReplan && partialRouteExhausted) || stalled
        if (needsReplan) {
          if (stalled) {
            stalledReplans++
            owner?.stop(acq.token)
            lastProgressAt = now
            lastPosition = bot.entity.position.clone()
            bestDistance = dist
            replanDelayMs = Math.min(5000, Math.max(1200, replanDelayMs * 1.5))
          } else {
            replanDelayMs = 700
          }
          const goal = new goals.GoalFollow(target, distance)
          const installed = setPathfinderGoal(bot, acq, goal, { dynamic: true })
          if (!installed.ok) throw new Error(installed.reason || '路径规划失败')
          lastTargetId = target.id
          lastReplanAt = now
        }
        if (stalledReplans >= 4) throw new Error(`跟随被地形卡住，和 ${username} 相距 ${dist.toFixed(1)} 格，稍后自动重试`)
        await sleep(400, ctx)
      }
      return '正在跟随 ' + username
    } catch (err) {
      const reason = ctx && ctx.signal ? ctx.signal.reason : ''
      if (reason === 'reactive-preempt') {
        return { preempted: true, reason: 'reactive 中断 follow' }
      }
      throw err
    } finally {
      acq.release()
    }
  },


  dig: async (bot, args, ctx) => {
    const block = getBlock(bot, args.x, args.y, args.z)
    if (!block) throw new Error('目标方块不存在')
    try { await combat.equipBestToolForBlock(bot, block.name) } catch {}
    await raceWithAbort(bot.dig(block, true), ctx, () => {
      if (typeof bot.stopDigging === 'function') bot.stopDigging()
    })
    const picked = await pickupNearbyDrops(bot, ctx, 6)
    if (picked && picked.preempted) return picked
    return `挖掘 ${block.name}，并已拾取附近掉落物`
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
    const radius = Math.max(4, Math.min(Number(args.radius ?? 12), 24))

    if (hasPos) {
      block = bot.blockAt(new Vec3(x, y, z))
      if (!block || block.boundingBox === 'empty') {
        itemDrop = nearestItemDrop(bot, 4)
      }
    } else {
      const name = String(args.name || '').toLowerCase()
      if (name) {
        block = await findReachableBlockBy(bot, candidate => {
          if (!candidate || !candidate.name) return false
          const blockName = String(candidate.name).toLowerCase()
          const displayName = String(candidate.displayName || '').toLowerCase()
          return (blockName === name || displayName === name) && !inBlockCollectCooldown(bot, candidate)
        }, radius, 128, 10)
        if (!block) itemDrop = nearestItemDrop(bot, radius)
      } else {
        // Finish collecting existing drops before breaking another block. This
        // prevents autonomous mode from leaving a trail of ore items behind.
        itemDrop = nearestItemDrop(bot, radius)
        if (!itemDrop) {
          // A nearby block can still be behind a cliff or in an unreachable
          // pocket. Check a small set of path candidates before committing to it.
          block = await findReachableBlockBy(bot, candidate => isCollectibleLike(candidate) && canHarvestBlock(bot, candidate) && !inBlockCollectCooldown(bot, candidate), radius, 128, 10)
        }
      }
    }

    if (!block && !itemDrop) {
      const angle = Math.random() * Math.PI * 2
      const distance = Math.max(3, Math.min(Number(args.moveDistance ?? 6), 16))
      const tx = bot.entity.position.x + Math.sin(angle) * distance
      const tz = bot.entity.position.z + Math.cos(angle) * distance
      const nav = await pathNearXZ(bot, ctx, tx, tz, 2, 40000)
      if (nav && nav.preempted) return nav
      if (nav && !nav.ok) throw new Error(nav.reason || '无法移动探索')
      const afterMove = nearestItemDrop(bot, radius)
      if (afterMove) {
        const picked = await pickupNearbyDrops(bot, ctx, radius)
        if (picked && picked.preempted) return picked
        return '移动探索途中发现了掉落物并已拾取'
      }
      return '附近暂时没有可采集目标，已移动探索'
    }

    if (block) {
      // Check the tool before walking to an ore. This prevents a long pathing
      // attempt followed by destroying valuable ore with an invalid tool.
      await equipForHarvest(bot, block)
      const beforeYield = trackedYieldCount(bot, block.name)
      const dist = bot.entity.position.distanceTo(block.position)
      if (dist > 3.5) {
        const nav = await pathNear(bot, ctx, block.position.x, block.position.y, block.position.z, 2.5, 15000)
        if (nav && nav.preempted) return nav
        if (nav && !nav.ok) {
          markBlockCollectCooldown(bot, block.position)
          throw new Error(nav.reason || '无法到达目标方块')
        }
      }
      if (!blockVisible(bot, block)) {
        const exposed = await exposeBlockSafely(bot, block, ctx, 16)
        if (!exposed) {
          try { await bot.lookAt(block.position.offset(0.5, 0.5, 0.5), true) } catch {}
          await sleep(150, ctx)
          if (!blockVisible(bot, block)) throw new Error('\u76ee\u6807\u65b9\u5757\u4e0d\u53ef\u89c1\uff0c\u5df2\u5c1d\u8bd5\u6316\u5f00\u906e\u6321\u4f46\u4ecd\u65e0\u6cd5\u91c7\u96c6')
        }
      }
      await raceWithAbort(bot.dig(block, true), ctx, () => {
        if (typeof bot.stopDigging === 'function') bot.stopDigging()
      })
      let picked = await pickupNearbyDrops(bot, ctx, radius)
      if (picked && picked.preempted) return picked
      if (beforeYield != null) {
        let gained = await waitForTrackedYield(bot, block.name, beforeYield, ctx, 1200)
        if (gained <= 0) {
          picked = await pickupNearbyDrops(bot, ctx, Math.min(24, radius + 4))
          if (picked && picked.preempted) return picked
          gained = await waitForTrackedYield(bot, block.name, beforeYield, ctx, 2500)
        }
        if (gained <= 0) throw new Error('\u5df2\u6316\u6398 ' + block.name + '\uff0c\u4f46\u6ca1\u6709\u62fe\u53d6\u5230\u5bf9\u5e94\u6389\u843d\u7269')
        return '\u91c7\u96c6 ' + block.name + '\uff0c\u5df2\u62fe\u53d6 ' + gained + ' \u4e2a\u76ee\u6807\u6389\u843d\u7269'
      }
      return '采集 ' + block.name + '，并已拾取附近掉落物'
    }

    const picked = await pickupNearbyDrops(bot, ctx, radius)
    if (picked && picked.preempted) return picked
    if (picked && picked.collected > 0) return `已拾取附近掉落物 ${picked.collected} 个`
    if (picked && picked.skipped > 0) return `附近有 ${picked.skipped} 个掉落物暂时不可达，已跳过并进入冷却`
    return '附近没有需要拾取的可达掉落物'
  },

  chopTree: async (bot, args, ctx) => {
    const radius = Math.max(4, Math.min(Number(args.radius ?? 12), 24))
    const maxBlocks = Math.max(1, Math.min(Number(args.max ?? 64), 128))
    const result = await chopOneTree(bot, ctx, maxBlocks, radius)
    if (result.preempted) return result
    return `砍树完成，共挖掘 ${result.dug} 块原木`
  },

  mineOreVein: async (bot, args, ctx) => {
    const name = String(args.name || '').toLowerCase()
    const predicate = name ? block => oreMatchesName(block, name) : isOreLike
    const radius = Math.max(4, Math.min(Number(args.radius ?? 20), 32))
    const targetCountRaw = Number(args.targetCount ?? args.count)
    const targetCount = Number.isFinite(targetCountRaw) && targetCountRaw > 0
      ? Math.max(1, Math.min(Math.floor(targetCountRaw), 256))
      : 0
    const defaultMaxBlocks = targetCount ? Math.max(targetCount, targetCount * 2) : 48
    const maxBlocks = Math.max(1, Math.min(Number(args.max ?? defaultMaxBlocks), 256))
    const beforeYield = targetCount && name ? oreYieldCount(bot, name) : 0
    let totalDug = 0
    let searchesWithoutOre = 0

    while (totalDug < maxBlocks) {
      throwIfAborted(ctx)
      if (targetCount && name && oreYieldCount(bot, name) - beforeYield >= targetCount) break

      let block = findNearestBlockBy(bot, predicate, Math.min(32, radius + searchesWithoutOre * 2), 256)
      if (!block) {
        if (!targetCount || searchesWithoutOre >= 12) break
        searchesWithoutOre++
        if (isDeepOreName(name)) {
          const down = await descendForDeepOre(bot, predicate, ctx, 16, 14)
          if (down && down.preempted) return down
          if (down && down.found) {
            block = down.found
            searchesWithoutOre = 0
          } else {
            const angle = Math.random() * Math.PI * 2
            const distance = 6 + searchesWithoutOre * 3
            const nav = await pathNearXZ(
              bot,
              ctx,
              bot.entity.position.x + Math.sin(angle) * distance,
              bot.entity.position.z + Math.cos(angle) * distance,
              2,
              45000
            )
            if (nav && nav.preempted) return nav
            continue
          }
        } else {
          const angle = Math.random() * Math.PI * 2
          const distance = 6 + searchesWithoutOre * 4
          const nav = await pathNearXZ(
            bot,
            ctx,
            bot.entity.position.x + Math.sin(angle) * distance,
            bot.entity.position.z + Math.cos(angle) * distance,
            2,
            45000
          )
          if (nav && nav.preempted) return nav
          if (nav && !nav.ok) continue
          continue
        }
      }

      searchesWithoutOre = 0
      try {
        const tool = await combat.equipBestToolForBlock(bot, block.name)
        if (!tool) await ensureWoodenToolForBlock(bot, block.name, ctx)
      } catch {}
      const remaining = Math.max(1, maxBlocks - totalDug)
      const gained = targetCount && name ? Math.max(0, oreYieldCount(bot, name) - beforeYield) : 0
      const needed = targetCount ? Math.max(1, targetCount - gained) : remaining
      const batchLimit = Math.max(1, Math.min(remaining, needed))
      const result = await digConnected(bot, block.position, predicate, ctx, batchLimit, { threeDimensional: true })
      if (result.preempted) return result
      totalDug += Number(result.dug || 0)
      if (!result.dug) break
      const picked = await pickupNearbyDrops(bot, ctx, radius)
      if (picked && picked.preempted) return picked
    }

    const collected = targetCount && name ? Math.max(0, oreYieldCount(bot, name) - beforeYield) : totalDug
    if (totalDug === 0) {
      const label = name ? canonicalOreName(name) : '矿石'
      throw new Error(`附近 ${radius} 格内没有可见的 ${label}，请先带我到矿洞或矿脉附近`)
    }
    if (targetCount && collected < targetCount) {
      return `部分完成：已挖 ${totalDug} 块并拾取 ${collected}/${targetCount} 个目标矿物，附近暂时找不到更多`
    }
    if (targetCount) return `采矿完成：已挖 ${totalDug} 块并拾取 ${collected}/${targetCount} 个目标矿物`
    return `采矿完成：共挖掘 ${totalDug} 块，并已拾取附近掉落物`
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
    if (!username) throw new Error('protect 需要 username')
    const player = findPlayer(bot, username)
    if (!player || !player.entity) throw new Error('找不到玩家: ' + username)
    const radius = Math.max(4, Math.min(Number(args.radius ?? 12), 32))
    const reactiveCfg = (bot.reactiveController && bot.reactiveController.cfg) || {}
    const lowHealthThreshold = Number(reactiveCfg.lowHealthFleeThreshold ?? 8)
    const lowHealth = Number.isFinite(bot.health) && bot.health <= lowHealthThreshold
    if (lowHealth) {
      const dist = bot.entity.position.distanceTo(player.entity.position)
      if (dist > 3) {
        const nav = await pathNear(bot, ctx, player.entity.position.x, player.entity.position.y, player.entity.position.z, 3, 30000)
        if (nav && nav.preempted) return nav
        if (nav && !nav.ok) throw new Error(nav.reason || '无法接近目标')
      }
      return `低血量 ${bot.health}，优先保命并跟随 ${username}`
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
    const prepared = await ensureBuildMaterial(bot, args.material ? String(args.material) : null, ctx, 20)
    if (prepared && prepared.preempted) return prepared
    const material = prepared ? prepared.material : null
    if (!material) throw new Error('背包里没有可用于建筑的方块')
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
          if (await placeBuildBlock(bot, pos, ctx, material)) placed.push(`${pos.x},${pos.y},${pos.z}`)
        }
      }
    }
    for (const dx of [-1, 1]) {
      for (const dz of [-1, 1]) {
        for (const level of [by, by + 1]) {
          const pos = new Vec3(bx + dx, level, bz + dz)
          const current = bot.blockAt(pos)
          if (current && current.boundingBox === 'empty') {
            if (await placeBuildBlock(bot, pos, ctx, material)) placed.push(`${pos.x},${pos.y},${pos.z}`)
          }
        }
      }
    }
    if (!placed.length) throw new Error('避难所放置失败')
    return '避难所搭建完成，共放置 ' + placed.length + ' 个方块'
  },

  buildHouse: async (bot, args, ctx) => {
    const material = args.material ? String(args.material) : null
    const houseArgs = { ...(args || {}) }
    let positions = buildHousePositions(bot, houseArgs)
    const prepared = await ensureBuildMaterial(bot, material, ctx, positions.length)
    if (prepared && prepared.preempted) return prepared
    const selected = prepared ? prepared.material : null
    if (!selected) throw new Error(material ? '背包里没有指定建材: ' + material : '背包里没有可用于建筑的方块，并且附近没有可采集的树木')

    // If we do not have enough blocks for the default 5x5x3 house, scale the
    // house down instead of leaving a half-built shell. A complete small house
    // is far more useful than scattered partial walls.
    const available = countItemByName(bot, selected)
    if (available < positions.length) {
      const candidates = [
        { width: 5, depth: 4, height: 3 },
        { width: 4, depth: 4, height: 3 },
        { width: 4, depth: 4, height: 2 },
        { width: 3, depth: 3, height: 3 },
        { width: 3, depth: 3, height: 2 }
      ]
      let resized = false
      for (const cand of candidates) {
        const smallerArgs = { ...houseArgs, ...cand }
        const smaller = buildHousePositions(bot, smallerArgs)
        if (smaller.length <= available) {
          positions = smaller
          Object.assign(houseArgs, cand)
          resized = true
          break
        }
      }
      // If even the smallest house does not fit, still build the smallest
      // possible shell rather than a much larger, half-finished outline.
      if (!resized) {
        const smallest = candidates[candidates.length - 1]
        const smallestArgs = { ...houseArgs, ...smallest }
        positions = buildHousePositions(bot, smallestArgs)
        Object.assign(houseArgs, smallest)
      }
    }

    const result = await placeMany(bot, positions, ctx, selected)
    if (result && result.preempted) return result
    const uniquePositions = new Set(positions.map(p => p.x + ',' + p.y + ',' + p.z)).size
    if (!result.placed || (uniquePositions > 0 && result.placed / uniquePositions < 0.5)) {
      throw new Error('房子建造不完整，实际放置 ' + result.placed + '/' + uniquePositions + ' 个方块，已中止以免误报完成')
    }

    const furnished = await furnishHouse(bot, houseArgs, ctx)
    if (furnished && furnished.preempted) return furnished

    let text = '房子建造完成，共放置 ' + result.placed + ' 个方块，跳过 ' + result.skipped + ' 个。'
    if (furnished && furnished.placed) text += '并安装了 ' + furnished.placed + ' 个门/照明/家具。'
    return text
  },

  buildTower: async (bot, args, ctx) => {
    const material = args.material ? String(args.material) : null
    const positions = buildTowerPositions(bot, args || {})
    const prepared = await ensureBuildMaterial(bot, material, ctx, positions.length)
    if (prepared && prepared.preempted) return prepared
    const selected = prepared ? prepared.material : null
    if (!selected) throw new Error(material ? '背包里没有指定建材: ' + material : '背包里没有可用于建筑的方块，并且附近没有可采集的树木')
    const result = await placeMany(bot, positions, ctx, selected)
    if (result && result.preempted) return result
    if (!result.placed) throw new Error('塔还没开始建，可能被挡住了。')
    return '塔建造完成，共放置 ' + result.placed + ' 个方块。'
  },

  buildBridge: async (bot, args, ctx) => {
    const material = args.material ? String(args.material) : null
    const positions = buildBridgePositions(bot, args || {})
    const prepared = await ensureBuildMaterial(bot, material, ctx, positions.length)
    if (prepared && prepared.preempted) return prepared
    const selected = prepared ? prepared.material : null
    if (!selected) throw new Error(material ? '背包里没有指定建材: ' + material : '背包里没有可用于建筑的方块，并且附近没有可采集的树木')
    const result = await placeMany(bot, positions, ctx, selected)
    if (result && result.preempted) return result
    if (!result.placed) throw new Error('桥还没开始建，可能被挡住了。')
    return '桥建造完成，共放置 ' + result.placed + ' 个方块。'
  },

  buildWall: async (bot, args, ctx) => {
    const material = args.material ? String(args.material) : null
    const positions = buildWallPositions(bot, args || {})
    const prepared = await ensureBuildMaterial(bot, material, ctx, positions.length)
    if (prepared && prepared.preempted) return prepared
    const selected = prepared ? prepared.material : null
    if (!selected) throw new Error(material ? '背包里没有指定建材: ' + material : '背包里没有可用于建筑的方块，并且附近没有可采集的树木')
    const result = await placeMany(bot, positions, ctx, selected)
    if (result && result.preempted) return result
    if (!result.placed) throw new Error('墙还没开始建，可能被挡住了。')
    return '墙建造完成，共放置 ' + result.placed + ' 个方块。'
  },

  inventory: async (bot, args) => {
    const text = formatInventoryText(bot)
    if (args && args.chat) {
      const now = Date.now()
      bot._chatDedupe = bot._chatDedupe || {}
      if (now - (bot._chatDedupe[text] || 0) > 15000) {
        bot._chatDedupe[text] = now
        try { bot.chat(text) } catch {}
      }
    }
    return text
  },

  // 检查并替换耐久度低的工具：把低于阈值的工具丢弃，为后续 craftGear 腾出空间。
  checkTools: async (bot, args) => {
    const threshold = Math.max(1, Math.min(99, Number(args.threshold ?? 30)))
    const items = bot.inventory.items().filter(i => i)
    const worn = combat.wornTools(items, threshold)
    if (!worn.length) return '工具耐久度正常'
    const dropped = []
    for (const entry of worn) {
      const item = entry.item
      try {
        // 只丢弃非手持的工具，避免把手上的工具扔掉后反而无法继续。
        if (bot.heldItem && bot.heldItem.slot === item.slot) continue
        await bot.tossStack(item)
        dropped.push(`${item.displayName || item.name}(${entry.pct}%)`)
      } catch {}
    }
    if (!dropped.length) return `有 ${worn.length} 件低耐久工具，但都不可丢弃（可能正手持）`
    return `已丢弃低耐久工具: ${dropped.join(', ')}`
  },

  craft: async (bot, args, ctx) => {
    const rawName = String(args.name || args.item || '').trim()
    if (!rawName) throw new Error('craft 需要 name 参数')
    const itemName = resolveCraftItemName(bot, rawName)
    if (!itemName) throw new Error('不认识或无法制作的物品: ' + rawName)
    const count = clampInt(args.count ?? args.amount, 1, 64, 1)
    const result = await craftOneItem(bot, itemName, ctx, count)
    if (result && result.preempted) return result
    if (typeof result === 'string') return result
    throw new Error('制作失败: ' + itemName)
  },

  craftGear: async (bot, args, ctx) => {
    const picked = await pickupNearbyDrops(bot, ctx, 8)
    if (picked && picked.preempted) return picked

    const missingBefore = GEAR_PRIORITY.filter(itemName => !findInventoryItemByName(bot, itemName))
    if (missingBefore.length && countMaterialFamily(bot, '_planks') < 20) {
      const planks = await gatherAndCraftPlanks(bot, null, ctx, 20)
      if (planks && planks.preempted) return planks
    }
    if (!findCraftingTableBlock(bot, 8)) await ensureCraftingTable(bot, ctx)

    const made = []
    const failures = []
    for (const itemName of GEAR_PRIORITY) {
      throwIfAborted(ctx)
      if (findInventoryItemByName(bot, itemName)) continue
      try {
        const r = await craftOneItem(bot, itemName, ctx, 1)
        if (r && r.preempted) return r
        if (typeof r === 'string') made.push(itemName)
      } catch (err) {
        failures.push(itemName + ': ' + String(err && err.message ? err.message : err))
      }
    }
    for (const itemName of LEATHER_ARMOR_ITEMS) {
      throwIfAborted(ctx)
      if (findInventoryItemByName(bot, itemName)) continue
      try {
        const r = await craftOneItem(bot, itemName, ctx, 1)
        if (r && r.preempted) return r
        if (typeof r === 'string') made.push(itemName)
      } catch {}
    }

    const missing = GEAR_PRIORITY.filter(itemName => !findInventoryItemByName(bot, itemName))
    if (missing.length) {
      const detail = failures.length ? ('\uff1b' + failures.slice(0, 4).join('\uff1b')) : ''
      throw new Error('\u88c5\u5907\u5236\u4f5c\u672a\u5b8c\u6210\uff0c\u7f3a\u5c11: ' + missing.join(', ') + detail)
    }

    let equipped = []
    try { equipped = await combat.equipBestArmor(bot) } catch {}
    try { await combat.equipBestMelee(bot) } catch {}
    try { await combat.equipShield(bot) } catch {}
    const summary = made.length ? ('\u5df2\u5236\u4f5c: ' + made.join(', ')) : '\u88c5\u5907\u5df2\u5c31\u7eea\uff0c\u65e0\u9700\u518d\u5236\u4f5c'
    const eq = equipped.length ? ('\uff1b\u81ea\u52a8\u88c5\u5907: ' + equipped.join(', ')) : ''
    return summary + eq
  },

  craftPlanks: async (bot, args, ctx) => {
    const count = clampInt(args.count ?? args.amount, 1, 256, 16)
    const material = args.material ? String(args.material) : (args.log ? String(args.log) : null)
    const planks = await gatherAndCraftPlanks(bot, material, ctx, count)
    if (planks && planks.preempted) return planks
    if (!planks) throw new Error(material ? '无法制作指定建材: ' + material : '附近没有可用来制作木板的树木')
    return '已准备建筑材料 ' + planks + '，目标数量 ' + count
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
    await combat.consumePreserveLoadout(bot, item)
    return `吃掉 ${item.displayName || item.name}`
  },

  wait: async (bot, args, ctx) => {
    const requested = Number(args.ms || args.duration || 1000)
    const ms = Number.isFinite(requested) ? Math.max(200, Math.min(requested, 60000)) : 1000
    await sleep(ms, ctx)
    return `等待 ${ms}ms`
  },


  build_plan: async (bot, args, ctx) => builderBuildPlan(bot, args, ctx),
  scan: async (bot, args, ctx) => builderScan(bot, args, ctx),
  query: async (bot, args, ctx) => builderQuery(bot, args, ctx),
  verify_path: async (bot, args, ctx) => builderVerifyPath(bot, args, ctx),
  query_block: async (bot, args) => {
    const knowledge = require('../ai/knowledge')
    const entry = knowledge.queryBlock(args.name)
    if (!entry) throw new Error('方块百科里没有: ' + (args.name || ''))
    return JSON.stringify({ name: entry.name, category: entry.category, usage: (entry.usage || '').slice(0, 1600), properties: (entry.properties || []).slice(0, 8) })
  },
  query_building: async (bot, args) => {
    const knowledge = require('../ai/knowledge')
    const entry = knowledge.queryBuilding(args.id)
    if (!entry) throw new Error('建筑教程里没有: ' + (args.id || '') + '，可用: ' + knowledge.listBuildingIds().join(', '))
    return JSON.stringify({ id: entry.id, name: entry.name, category: entry.category, guide: entry.guide })
  },
  mineBlock: async (bot, args, ctx) => {
    const name = String(args.name || '').toLowerCase()
    const count = Math.max(1, Number(args.count || args.amount || 1))
    const output = String(args.output || '').toLowerCase()
    const dropName = output || ({ stone: 'cobblestone', deepslate: 'cobbled_deepslate', grass_block: 'dirt', dirt: 'dirt', gravel: 'gravel', sand: 'sand', obsidian: 'obsidian' }[name] || name)
    const maxAttempts = Math.max(1, Math.min(Number(args.maxAttempts || 24), 80))
    let lastErr = null
    for (let i = 0; i < maxAttempts; i++) {
      throwIfAborted(ctx)
      if (countInventoryItem(bot, dropName) >= count) break
      try {
        const r = await handlers.collect(bot, { name, radius: 16, moveDistance: 8 }, ctx)
        if (r && r.preempted) return r
      } catch (err) {
        lastErr = String(err && err.message ? err.message : err)
      }
      await sleep(150, ctx)
    }
    const got = countInventoryItem(bot, dropName)
    if (got >= count) return 'mined ' + dropName + ' x' + got + ' (target ' + count + ')'
    if (got > 0) return 'mined ' + dropName + ' x' + got + ' of ' + count
    throw new Error(lastErr || ('not enough ' + dropName + ': have ' + got + '/' + count))
  },

  smelt: async (bot, args, ctx) => {
    const input = String(args.input || '').toLowerCase()
    const output = String(args.output || '').toLowerCase()
    const count = Math.max(1, Number(args.count || args.amount || 1))
    const fuel = String(args.fuel || 'coal').toLowerCase()
    if (!input || !output) throw new Error('smelt needs input and output')
    if (countInventoryItem(bot, output) >= count) return 'already have ' + output + ' x' + countInventoryItem(bot, output)
    const fBlock = await ensureFurnaceBlock(bot, ctx)
    if (!fBlock || !fBlock.position) throw new Error('no furnace available')
    let lastErr = null
    for (let i = 0; i < Math.max(count, 6); i++) {
      throwIfAborted(ctx)
      if (countInventoryItem(bot, output) >= count) break
      let inputItem = findInventoryItemByName(bot, input)
      if (!inputItem) {
        const alt = { raw_iron: 'iron_ore', raw_gold: 'gold_ore', raw_copper: 'copper_ore' }[input]
        if (alt) inputItem = findInventoryItemByName(bot, alt)
      }
      const fuelItem = findInventoryItemByName(bot, fuel)
      if (!inputItem || !fuelItem) { lastErr = !inputItem ? ('no input ' + input) : ('no fuel ' + fuel); break }
      try {
        const furnace = await raceWithAbort(bot.openFurnace(fBlock), ctx, () => closeOpenWindow(bot))
        await furnace.putInput(inputItem.type, null, 1)
        await furnace.putFuel(fuelItem.type, null, 1)
        await sleep(9000, ctx)
        try { await furnace.takeOutput() } catch {}
        closeOpenWindow(bot)
      } catch (err) {
        lastErr = String(err && err.message ? err.message : err)
        closeOpenWindow(bot)
        await sleep(800, ctx)
      }
    }
    const got = countInventoryItem(bot, output)
    if (got >= count) return 'smelted ' + output + ' x' + got
    if (got > 0) return 'smelted ' + output + ' x' + got + ' of ' + count
    throw new Error(lastErr || ('smelt failed for ' + output))
  },

  buildNetherPortal: async (bot, args, ctx) => {
    const obsidian = findInventoryItemByName(bot, 'obsidian')
    if (!obsidian) throw new Error('no obsidian in inventory')
    const site = await findPortalSite(bot, ctx)
    if (!site) throw new Error('no room to build nether portal')
    const positions = []
    for (let y = 0; y < 5; y++) {
      for (let x = 0; x < 4; x++) {
        if (x === 0 || x === 3 || y === 0 || y === 4) positions.push(new Vec3(site.x + x, site.y + y, site.z))
      }
    }
    let placed = 0
    for (const pos of positions) {
      throwIfAborted(ctx)
      const r = await placeSpecificItemAt(bot, pos, ctx, obsidian)
      if (r && r.preempted) throw abortError(r.reason || 'reactive preempt')
      if (r === true) placed++
      await sleep(80, ctx)
    }
    if (placed < 10) throw new Error('portal frame incomplete: ' + placed + '/10')
    const ignited = await ignitePortal(bot, ctx, positions)
    if (!ignited) throw new Error('nether portal frame built but failed to light it')
    return 'nether portal built and lit (' + placed + ' obsidian)'
  },

  enterPortal: async (bot, args, ctx) => {
    const portal = findNearestBlockBy(bot, b => {
      const n = lowerBlockName(b)
      return n === 'nether_portal' || n === 'end_portal' || n === 'end_gateway'
    }, 12, 24)
    if (!portal) throw new Error('no portal block nearby')
    const nav = await pathNear(bot, ctx, portal.position.x, portal.position.y, portal.position.z, 0.6, 30000)
    if (nav && nav.preempted) return nav
    if (nav && !nav.ok) throw new Error(nav.reason || 'cannot reach portal')
    const startDim = dimName(bot)
    bot.setControlState('forward', true)
    const deadline = Date.now() + 20000
    try {
      while (Date.now() < deadline) {
        throwIfAborted(ctx)
        if (dimName(bot) !== startDim) return 'entered ' + dimName(bot)
        await sleep(300, ctx)
      }
    } finally {
      bot.setControlState('forward', false)
    }
    throw new Error('portal dimension change timeout (still ' + startDim + ')')
  },

  obtainBlazeRods: async (bot, args, ctx) => {
    const need = Math.max(1, Number(args.count || 1))
    if (countInventoryItem(bot, 'blaze_rod') >= need) return 'already have blaze_rod x' + countInventoryItem(bot, 'blaze_rod')
    const r = await handlers.hunt(bot, { name: 'blaze', max: 40 }, ctx)
    if (r && r.preempted) return r
    const got = countInventoryItem(bot, 'blaze_rod')
    if (got >= need) return 'obtained blaze_rod x' + got
    if (got > 0) return 'obtained blaze_rod x' + got + ' of ' + need
    throw new Error('no blaze nearby to farm')
  },

  obtainEnderPearls: async (bot, args, ctx) => {
    const need = Math.max(1, Number(args.count || 1))
    if (countInventoryItem(bot, 'ender_pearl') >= need) return 'already have ender_pearl x' + countInventoryItem(bot, 'ender_pearl')
    const r = await handlers.hunt(bot, { name: 'enderman', max: 40 }, ctx)
    if (r && r.preempted) return r
    const got = countInventoryItem(bot, 'ender_pearl')
    if (got >= need) return 'obtained ender_pearl x' + got
    if (got > 0) return 'obtained ender_pearl x' + got + ' of ' + need
    throw new Error('no enderman nearby to farm')
  },

  findStronghold: async (bot, args, ctx) => {
    const eye = findInventoryItemByName(bot, 'ender_eye')
    if (!eye) throw new Error('no ender_eye to locate stronghold')
    let lastDir = null
    for (let i = 0; i < 10; i++) {
      throwIfAborted(ctx)
      const dir = await throwEnderEye(bot, ctx, eye)
      if (dir) {
        lastDir = dir
        const step = 60
        const tx = bot.entity.position.x + dir.x * step
        const tz = bot.entity.position.z + dir.z * step
        const nav = await pathNearXZ(bot, ctx, tx, tz, 3, 60000)
        if (nav && nav.preempted) return nav
        if (nav && !nav.ok) throw new Error(nav.reason || 'cannot follow ender eye')
      } else {
        break
      }
    }
    if (lastDir) return 'followed ender eyes toward stronghold; now near ' + Math.floor(bot.entity.position.x) + ',' + Math.floor(bot.entity.position.z)
    throw new Error('could not track ender eye direction')
  },

  activateEndPortal: async (bot, args, ctx) => {
    const eye = findInventoryItemByName(bot, 'ender_eye')
    if (!eye) throw new Error('no ender_eye to activate portal')
    const frames = findBlocksByPredicate(bot, b => lowerBlockName(b) === 'end_portal_frame', 24, 256)
    if (!frames.length) throw new Error('no end portal frames nearby')
    let placed = 0
    for (const frame of frames) {
      throwIfAborted(ctx)
      let hasEye = false
      try { const props = frame.getProperties && frame.getProperties(); hasEye = !!(props && props.eye) } catch {}
      if (hasEye) continue
      const nav = await pathNear(bot, ctx, frame.position.x, frame.position.y, frame.position.z, 2.5, 30000)
      if (nav && nav.preempted) return nav
      if (nav && !nav.ok) continue
      try { await bot.equip(eye, 'hand') } catch {}
      try { await bot.lookAt(frame.position.offset(0.5, 0.5, 0.5), true) } catch {}
      try { await raceWithAbort(bot.activateBlock(frame), ctx, () => {}) } catch {}
      placed++
      await sleep(400, ctx)
    }
    const portal = findNearestBlockBy(bot, b => lowerBlockName(b) === 'end_portal', 24, 32)
    if (portal) return 'end portal activated (' + placed + ' eyes placed)'
    throw new Error('end portal not activated after placing ' + placed + ' eyes')
  },

  fightEnderDragon: async (bot, args, ctx) => {
    try { await combat.equipBestMelee(bot) } catch {}
    try { await combat.equipShield(bot) } catch {}
    const deadline = Date.now() + 90000
    while (Date.now() < deadline) {
      throwIfAborted(ctx)
      const crystal = bot.nearestEntity(e => e && e.name === 'end_crystal' && bot.entity.position.distanceTo(e.position) < 18)
      if (crystal) {
        const nav = await pathNear(bot, ctx, crystal.position.x, crystal.position.y, crystal.position.z, 3, 20000)
        if (nav && nav.preempted) return nav
        if (nav && nav.ok) {
          try { await bot.lookAt(crystal.position.offset(0, 0.5, 0), true) } catch {}
          try { await bot.attack(crystal) } catch {}
        }
        await sleep(700, ctx)
        continue
      }
      const dragon = bot.nearestEntity(e => e && e.name === 'ender_dragon')
      if (!dragon) break
      const dist = bot.entity.position.distanceTo(dragon.position)
      if (dist > 3) {
        const nav = await pathNear(bot, ctx, dragon.position.x, dragon.position.y, dragon.position.z, 3, 20000)
        if (nav && nav.preempted) return nav
        if (nav && !nav.ok) { await sleep(1000, ctx); continue }
      }
      try { await bot.lookAt(dragon.position.offset(0, 1, 0), true) } catch {}
      try { await bot.attack(dragon) } catch {}
      await sleep(400, ctx)
    }
    const dragon = bot.nearestEntity(e => e && e.name === 'ender_dragon')
    if (!dragon) return 'ender dragon defeated'
    throw new Error('ender dragon still alive after fight window')
  },

  plan: async (bot, args) => {
    const brain = bot.brain
    if (!brain) throw new Error('brain 未挂载')
    const todos = brain.setAiPlan(args.todos)
    return '计划已更新: ' + JSON.stringify(todos)
  },
  set_goal: async (bot, args) => {
    const brain = bot.brain
    if (!brain) throw new Error('brain 未挂载')
    const goal = brain.setAiGoal(args.goal)
    return '目标已设为: ' + goal
  },
  pause_goal: async (bot) => {
    const brain = bot.brain
    if (!brain) throw new Error('brain 未挂载')
    brain.pauseAiGoal()
    return '任务已暂停，原地待命'
  },
  resume_goal: async (bot) => {
    const brain = bot.brain
    if (!brain) throw new Error('brain 未挂载')
    brain.resumeAiGoal()
    return '任务已恢复'
  },
  cancel_goal: async (bot) => {
    const brain = bot.brain
    if (!brain) throw new Error('brain 未挂载')
    brain.cancelAiGoal()
    return '任务已取消，回到自由行动'
  },
  recall: async (bot, args) => {
    const brain = bot.brain
    const mem = brain && brain.memory
    if (!mem) throw new Error('记忆未挂载')
    const rows = mem.recall(args.query, { time: args.time, types: args.types, limit: args.limit })
    if (!rows.length) return '没有检索到相关情景记忆'
    return JSON.stringify(rows.map(e => ({ id: e.id, at: e.at, type: e.type, text: e.text })))
  },
  remember: async (bot, args) => {
    const brain = bot.brain
    const mem = brain && brain.memory
    if (!mem) throw new Error('记忆未挂载')
    const ep = mem.remember(args.text, args.type, args.meta || {})
    return '已记住: ' + (ep ? ep.id : '空')
  },

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



// ===== 融合 shabao-ai：shape 建造 / 地形感知 / 路径自检 =====

function _iterBox3 (x1, y1, z1, x2, y2, z2, cb) {
  const ax = Math.min(x1, x2); const bx = Math.max(x1, x2)
  const ay = Math.min(y1, y2); const by = Math.max(y1, y2)
  const az = Math.min(z1, z2); const bz = Math.max(z1, z2)
  for (let x = ax; x <= bx; x++) for (let y = ay; y <= by; y++) for (let z = az; z <= bz; z++) cb(x, y, z)
}

function _iterRect (x1, z1, x2, z2, cb) {
  const ax = Math.min(x1, x2); const bx = Math.max(x1, x2)
  const az = Math.min(z1, z2); const bz = Math.max(z1, z2)
  for (let x = ax; x <= bx; x++) for (let z = az; z <= bz; z++) cb(x, z)
}

function _shapePositions (bot, step) {
  const shape = String(step.shape || '').toLowerCase()
  if (Array.isArray(step.blocks) && step.blocks.length) {
    return step.blocks.map(b => {
      const arr = Array.isArray(b) ? b : (b && typeof b === 'object' ? [b.x, b.y, b.z, b.id] : null)
      if (!arr) return null
      const x = Math.floor(Number(arr[0])); const y = Math.floor(Number(arr[1])); const z = Math.floor(Number(arr[2]))
      if (![x, y, z].every(Number.isFinite)) return null
      return { x, y, z, id: arr[3] ? String(arr[3]) : null }
    }).filter(Boolean)
  }
  const x1 = Math.floor(Number(step.x1)); const y1 = Math.floor(Number(step.y1)); const z1 = Math.floor(Number(step.z1))
  const x2 = Math.floor(Number(step.x2)); const y2 = Math.floor(Number(step.y2)); const z2 = Math.floor(Number(step.z2))
  const out = []
  if (shape === 'fill') {
    _iterBox3(x1, y1, z1, x2, y2, z2, (x, y, z) => out.push({ x, y, z, id: null }))
  } else if (shape === 'box') {
    _iterBox3(x1, y1, z1, x2, y2, z2, (x, y, z) => {
      if (x === x1 || x === x2 || y === y1 || y === y2 || z === z1 || z === z2) out.push({ x, y, z, id: null })
    })
  } else if (shape === 'wall') {
    _iterBox3(x1, y1, z1, x2, y2, z2, (x, y, z) => {
      if (x === x1 || x === x2 || z === z1 || z === z2) out.push({ x, y, z, id: null })
    })
  } else if (shape === 'floor') {
    const y = Math.floor(Number(step.y))
    if (!Number.isFinite(y)) return out
    _iterRect(x1, z1, x2, z2, (x, z) => {
      const hx1 = step.hx1 !== undefined ? Math.floor(Number(step.hx1)) : null
      const hz1 = step.hz1 !== undefined ? Math.floor(Number(step.hz1)) : null
      const hx2 = step.hx2 !== undefined ? Math.floor(Number(step.hx2)) : null
      const hz2 = step.hz2 !== undefined ? Math.floor(Number(step.hz2)) : null
      if (hx1 !== null && hz1 !== null && hx2 !== null && hz2 !== null) {
        if (x >= Math.min(hx1, hx2) && x <= Math.max(hx1, hx2) && z >= Math.min(hz1, hz2) && z <= Math.max(hz1, hz2)) return
      }
      out.push({ x, y, z, id: null })
    })
  } else if (shape === 'door' || shape === 'stairs' || shape === 'ladder' || shape === 'spiral') {
    const x = Math.floor(Number(step.x)); const y = Math.floor(Number(step.y)); const z = Math.floor(Number(step.z))
    if (![x, y, z].every(Number.isFinite)) return out
    const id = step.block || (shape === 'door' ? 'oak_door' : shape === 'ladder' ? 'ladder' : 'oak_stairs')
    out.push({ x, y, z, id: String(id) })
  }
  return out
}

async function _builderPlaceOne (bot, target, material, ctx) {
  const pos = new Vec3(target.x, target.y, target.z)
  const block = bot.blockAt(pos)
  if (!block) return 'skipped'
  if (block.boundingBox !== 'empty') return 'skipped'
  if (target.id) {
    const item = findInventoryItemByName(bot, target.id)
    if (!item) return 'skipped'
    const r = await placeSpecificItemAt(bot, pos, ctx, item)
    if (r && r.preempted) throw abortError(r.reason || 'reactive preempt')
    return r === true ? 'placed' : 'skipped'
  }
  const ok = await placeBuildBlock(bot, pos, ctx, material)
  return ok ? 'placed' : 'skipped'
}

function _builderSurfaceY (bot, x, z) {
  const p = bot.entity.position
  for (let y = Math.floor(p.y) + 28; y >= Math.floor(p.y) - 28; y--) {
    const b = bot.blockAt(new Vec3(x, y, z))
    if (!b) continue
    const n = lowerBlockName(b)
    if (b.boundingBox !== 'empty' && !n.includes('water') && !n.includes('lava') && !n.includes('air') && !n.includes('leaves')) return y
  }
  return null
}

async function builderBuildPlan (bot, args, ctx) {
  throwIfAborted(ctx)
  const steps = Array.isArray(args.steps) ? args.steps : []
  if (!steps.length) throw new Error('build_plan 需要 steps 数组')
  const summary = { placed: 0, skipped: 0, invalid: 0, failures: [] }
  for (const step of steps) {
    throwIfAborted(ctx)
    if (!step || typeof step !== 'object') { summary.invalid++; continue }
    if (String(step.shape || '').toLowerCase() === 'clear') {
      const r = await builderClearTerrain(bot, step, ctx)
      if (r && r.preempted) throw abortError(r.reason || 'reactive preempt')
      if (r) { summary.placed += r.placed; summary.skipped += r.skipped; summary.failures.push(...r.failures) }
      continue
    }
    const positions = _shapePositions(bot, step)
    if (!positions.length) { summary.invalid++; continue }
    const p = bot.entity.position
    positions.sort((a, b) => (((a.x - p.x) ** 2 + (a.y - p.y) ** 2 + (a.z - p.z) ** 2) - ((b.x - p.x) ** 2 + (b.y - p.y) ** 2 + (b.z - p.z) ** 2)))
    for (const target of positions) {
      throwIfAborted(ctx)
      try {
        const r = await _builderPlaceOne(bot, target, step.material, ctx)
        if (r === 'placed') summary.placed++
        else if (r === 'skipped') summary.skipped++
        else summary.failures.push(target.x + ',' + target.y + ',' + target.z)
      } catch (err) {
        if (err && (err.code === 'ABORT_ERR' || ctx.signal?.aborted)) throw err
        summary.failures.push(target.x + ',' + target.y + ',' + target.z + ':' + String(err.message || err))
      }
    }
  }
  return 'build_plan 完成: 放置 ' + summary.placed + '，跳过 ' + summary.skipped + '，失败 ' + summary.failures.length + (summary.failures.length ? ' → ' + summary.failures.slice(0, 8).join('; ') : '')
}

async function builderClearTerrain (bot, step, ctx) {
  const x1 = Math.floor(Number(step.x1)); const z1 = Math.floor(Number(step.z1))
  const x2 = Math.floor(Number(step.x2)); const z2 = Math.floor(Number(step.z2))
  if (![x1, z1, x2, z2].every(Number.isFinite)) throw new Error('clear 需要 x1,z1,x2,z2')
  const material = step.material || null
  const summary = { placed: 0, skipped: 0, failures: [] }

  // 未指定 y 时取区域内最高地表（把低洼填到该层，避免地基悬空；削高需手动）
  let targetY = Number(step.y)
  if (!Number.isFinite(targetY)) {
    let maxY = -Infinity
    _iterRect(x1, z1, x2, z2, (x, z) => { const t = _builderSurfaceY(bot, x, z); if (t !== null) maxY = Math.max(maxY, t) })
    if (!Number.isFinite(maxY)) throw new Error('无法采样该区域地表')
    targetY = Math.floor(maxY)
  }
  const fills = []
  _iterRect(x1, z1, x2, z2, (x, z) => {
    const top = _builderSurfaceY(bot, x, z)
    if (top === null) return
    if (top < targetY) for (let y = top + 1; y <= targetY; y++) fills.push([x, y, z])
  })
  fills.sort((a, b) => (((a[0] - bot.entity.position.x) ** 2 + (a[2] - bot.entity.position.z) ** 2) - ((b[0] - bot.entity.position.x) ** 2 + (b[2] - bot.entity.position.z) ** 2)))
  for (const [x, y, z] of fills) {
    throwIfAborted(ctx)
    try {
      const r = await _builderPlaceOne(bot, { x, y, z, id: null }, material, ctx)
      if (r === 'placed') summary.placed++
      else summary.skipped++
    } catch (err) {
      if (err && (err.code === 'ABORT_ERR' || ctx.signal?.aborted)) throw err
      summary.failures.push(x + ',' + y + ',' + z)
    }
  }
  return summary
}

async function builderScan (bot, args, ctx) {
  const p = bot.entity.position
  const cx = Math.floor(args.x ?? p.x)
  const cy = Math.floor(args.y ?? p.y)
  const cz = Math.floor(args.z ?? p.z)
  const radius = Math.max(2, Math.min(32, Number(args.radius ?? 12)))
  const heights = []
  let water = 0; let lava = 0; let solid = 0; let air = 0
  _iterRect(cx - radius, cz - radius, cx + radius, cz + radius, (x, z) => {
    const top = _builderSurfaceY(bot, x, z)
    if (top !== null) heights.push(top)
    for (let y = cy - 3; y <= cy + 3; y++) {
      const b = bot.blockAt(new Vec3(x, y, z))
      if (!b) continue
      const n = lowerBlockName(b)
      if (n.includes('water')) water++
      else if (n.includes('lava')) lava++
      else if (b.boundingBox !== 'empty') solid++
      else air++
    }
  })
  let median = null; let minY = null; let maxY = null
  if (heights.length) {
    const sorted = heights.slice().sort((a, b) => a - b)
    median = sorted[Math.floor(sorted.length / 2)]
    minY = sorted[0]; maxY = sorted[sorted.length - 1]
  }
  return JSON.stringify({
    center: { x: cx, y: cy, z: cz },
    radius,
    ground: { medianY: median, minY, maxY, sampled: heights.length },
    blocks: { solid, air, water, lava }
  })
}

async function builderQuery (bot, args, ctx) {
  const p = bot.entity.position
  const ground = _builderSurfaceY(bot, Math.floor(p.x), Math.floor(p.z))
  const brain = bot.brain
  const mem = brain && brain.memory ? brain.memory.snapshot() : null
  const recent = (mem && mem.episodes ? mem.episodes : []).slice(-6).map(e => '[' + e.type + '] ' + e.text.slice(0, 120))
  const obs = observations.build(bot, [])
  return JSON.stringify({
    position: { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) },
    groundY: ground,
    health: bot.health,
    food: bot.food,
    dimension: bot.game && bot.game.dimension,
    goal: brain ? brain.goal : null,
    inventory: obs.inventory && obs.inventory.items ? obs.inventory.items.slice(0, 24).map(i => ({ name: i.name, count: i.count })) : [],
    nearbyHostiles: (obs.nearbyHostiles || []).slice(0, 5).map(e => e.name),
    recentEpisodes: recent
  })
}

function _walkableName (n) {
  return n.includes('air') || n.includes('water') || n === 'ladder' || n.endsWith('_stairs') || n.endsWith('_slab') || n === 'torch' || n === 'grass' || n.endsWith('_carpet')
}

async function builderVerifyPath (bot, args, ctx) {
  const a = Array.isArray(args.from) ? args.from : [args.x1, args.y1, args.z1]
  const b = Array.isArray(args.to) ? args.to : [args.x2, args.y2, args.z2]
  const sx = Math.floor(Number(a[0])); const sy = Math.floor(Number(a[1])); const sz = Math.floor(Number(a[2]))
  const tx = Math.floor(Number(b[0])); const ty = Math.floor(Number(b[1])); const tz = Math.floor(Number(b[2]))
  if (![sx, sy, sz, tx, ty, tz].every(Number.isFinite)) throw new Error('verify_path 需要 from/to 或 x1,y1,z1,x2,y2,z2')
  const limit = 4000
  const key = (x, y, z) => x + ',' + y + ',' + z
  const seen = new Set([key(sx, sy, sz)])
  const queue = [[sx, sy, sz]]
  const dirs = [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]]
  let steps = 0
  while (queue.length && steps < limit) {
    const [x, y, z] = queue.shift()
    if (x === tx && y === ty && z === tz) return JSON.stringify({ reachable: true, steps, from: [sx,sy,sz], to: [tx,ty,tz] })
    steps++
    for (const [dx, dy, dz] of dirs) {
      const nx = x + dx; const ny = y + dy; const nz = z + dz
      const k = key(nx, ny, nz)
      if (seen.has(k)) continue
      const block = bot.blockAt(new Vec3(nx, ny, nz))
      if (!block) continue
      const n = lowerBlockName(block)
      if (_walkableName(n) || block.boundingBox === 'empty') {
        seen.add(k); queue.push([nx, ny, nz])
      }
    }
  }
  return JSON.stringify({ reachable: false, steps, from: [sx,sy,sz], to: [tx,ty,tz], reason: 'BFS 无法连通（或被方块隔断）' })
}

module.exports = {
  execute,
  executeStructured,
  handlers,
  _test: { nearestItemDrop, dropPickupCoolingDown, markDropPickupFailure, clearDropPickupFailure }
}
