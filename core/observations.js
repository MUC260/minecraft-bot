const combat = require('../lib/combat')
const nearbyTargetsCache = new WeakMap()
const snapshotCache = new WeakMap()

const HOSTILE_NAMES = new Set([
  'zombie', 'skeleton', 'creeper', 'spider', 'cave_spider', 'enderman',
  'witch', 'pillager', 'vindicator', 'evoker', 'ravager', 'husk', 'stray',
  'drowned', 'phantom', 'piglin', 'piglin_brute', 'zombified_piglin',
  'hoglin', 'zoglin', 'wither_skeleton', 'blaze', 'magma_cube', 'slime',
  'ghast', 'guardian', 'elder_guardian', 'shulker', 'silverfish', 'endermite',
  'vex', 'warden', 'breeze', 'bogged'
])

function round (n, digits = 2) {
  if (n === null || n === undefined || Number.isNaN(n)) return null
  return Number(n.toFixed(digits))
}

function vec (v) {
  if (!v) return null
  return { x: round(v.x), y: round(v.y), z: round(v.z) }
}

function isHostileName (name) {
  return HOSTILE_NAMES.has(String(name || '').toLowerCase())
}

function isDroppedItemEntity (entity) {
  if (!entity) return false
  const name = String(entity.name || '').toLowerCase()
  const type = String(entity.type || '').toLowerCase()
  const displayName = String(entity.displayName || '').toLowerCase()
  if (name === 'item' || name === 'item_stack') return true
  if (type === 'object' && (displayName === 'item' || displayName === 'item stack')) return true
  // Avoid calling getDroppedItem() for every mob/player in a large entity list.
  // It is useful only for ambiguous object entities and dominated snapshots on
  // servers with many tracked entities.
  if (type !== 'object' || typeof entity.getDroppedItem !== 'function') return false
  try { return !!entity.getDroppedItem() } catch { return false }
}

function dropPickupCoolingDown (entity, now = Date.now()) {
  if (!entity || !Number.isFinite(Number(entity._pickupRetryAfter))) return false
  const failedAt = entity._pickupFailurePosition
  if (failedAt && entity.position) {
    const dx = Number(entity.position.x) - Number(failedAt.x)
    const dy = Number(entity.position.y) - Number(failedAt.y)
    const dz = Number(entity.position.z) - Number(failedAt.z)
    if (Number.isFinite(dx + dy + dz) && Math.sqrt(dx * dx + dy * dy + dz * dz) >= 2.5) {
      delete entity._pickupRetryAfter
      delete entity._pickupFailurePosition
      delete entity._pickupFailureCount
      delete entity._pickupFailureReason
      return false
    }
  }
  if (Number(entity._pickupRetryAfter) <= now) {
    delete entity._pickupRetryAfter
    delete entity._pickupFailurePosition
    delete entity._pickupFailureCount
    delete entity._pickupFailureReason
    return false
  }
  return true
}

function relativeOffset (bot, entity) {
  if (!bot.entity || !entity) return null
  return {
    x: round(entity.position.x - bot.entity.position.x),
    y: round(entity.position.y - bot.entity.position.y),
    z: round(entity.position.z - bot.entity.position.z)
  }
}

function playerInfo (bot, player) {
  const entity = player && player.entity
  return {
    username: player.username,
    uuid: player.uuid || null,
    position: entity ? vec(entity.position) : null,
    relative: entity ? relativeOffset(bot, entity) : null,
    health: entity ? round(entity.health) : null,
    distance: (bot.entity && entity) ? round(bot.entity.position.distanceTo(entity.position)) : null
  }
}

function entityInfo (bot, entity) {
  const distance = bot.entity ? bot.entity.position.distanceTo(entity.position) : null
  return {
    id: entity.id,
    name: entity.name || entity.username || '',
    type: entity.type || '',
    hostile: isHostileName(entity.name),
    position: vec(entity.position),
    relative: relativeOffset(bot, entity),
    yaw: round(entity.yaw),
    pitch: round(entity.pitch),
    health: round(entity.health),
    distance: distance ? round(distance) : null
  }
}

function inventoryInfo (bot) {
  try {
    const items = bot.inventory.items().map(i => {
      const name = i.name
      const maxDurability = Number(i.maxDurability) || 0
      const durabilityUsed = Number.isFinite(i.durabilityUsed) ? Number(i.durabilityUsed) : null
      return {
        name,
        displayName: i.displayName || i.name,
        count: i.count,
        slot: i.slot,
        // 工具耐久度：只有有耐久上限的物品才带这两个字段
        maxDurability: maxDurability > 0 ? maxDurability : undefined,
        durabilityUsed: (maxDurability > 0 && durabilityUsed !== null) ? durabilityUsed : undefined,
        durabilityPct: (maxDurability > 0 && durabilityUsed !== null)
          ? Math.round(Math.max(0, 1 - durabilityUsed / maxDurability) * 100)
          : undefined
      }
    })
    return {
      held: bot.heldItem ? { name: bot.heldItem.name, displayName: bot.heldItem.displayName || bot.heldItem.name, count: bot.heldItem.count } : null,
      items: items.slice(0, 36),
      armor: combat.armorSummary(bot),
      weapon: combat.heldWeaponSummary(bot),
      shield: combat.hasShield(bot)
    }
  } catch {
    return { held: null, items: [], armor: { slots: {}, totalScore: 0 }, weapon: { melee: false, score: 0 }, shield: false }
  }
}

function lowerName (block) {
  return String(block && block.name ? block.name : '').toLowerCase()
}

function isCollectibleBlock (block) {
  const n = lowerName(block)
  if (!n) return false
  if (n.endsWith('_log') || n.endsWith('_ore') || n === 'ancient_debris') return true
  if (n === 'pumpkin' || n === 'melon' || n === 'sugar_cane' || n === 'cactus' || n === 'bamboo') return true
  if (n === 'wheat' || n === 'carrots' || n === 'potatoes' || n === 'beetroots' || n === 'nether_wart' || n === 'cocoa' || n === 'sweet_berry_bush') return true
  return false
}

function nearbyTargets (bot, radius = 16, count = 20) {
  if (!bot || !bot.entity || !bot.findBlocks) return []
  let positions = []
  try {
    positions = bot.findBlocks({
      matching: block => {
        try { return isCollectibleBlock(block) } catch { return false }
      },
      maxDistance: radius,
      count
    })
  } catch {
    return []
  }
  const out = []
  for (const pos of positions || []) {
    const block = bot.blockAt(pos)
    if (!block) continue
    const distance = bot.entity.position.distanceTo(block.position)
    out.push({
      name: block.name,
      displayName: block.displayName || block.name,
      position: vec(block.position),
      relative: relativeOffset(bot, { position: block.position }),
      distance: distance ? round(distance) : null
    })
  }
  out.sort((a, b) => (a.distance ?? 999) - (b.distance ?? 999))
  return out.slice(0, count)
}

function nearbyTargetsCached (bot, radius = 16, count = 20) {
  const now = Date.now()
  const cached = nearbyTargetsCache.get(bot)
  if (cached && now - cached.at < 1200 && cached.radius === radius && cached.count === count) return cached.value
  const value = nearbyTargets(bot, radius, count)
  nearbyTargetsCache.set(bot, { at: now, radius, count, value })
  return value
}

function pushNearest (list, entity, distance, limit) {
  if (!Number.isFinite(distance)) return
  let index = list.length
  while (index > 0 && list[index - 1].distance > distance) index--
  list.splice(index, 0, { entity, distance })
  if (list.length > limit) list.pop()
}

function build (bot, chatBuffer) {
  if (!bot || !bot.entity) {
    return { connected: false, bot: null, players: [], entities: [], nearbyHostiles: [], nearbyDrops: [], nearbyTargets: [], chat: [], inventory: null }
  }

  const now = Date.now()
  const cached = snapshotCache.get(bot)
  if (cached && now - cached.at < 200) return cached.value

  const playerRows = []
  for (const player of Object.values(bot.players || {})) {
    if (!player || !player.entity || player.entity.id === bot.entity.id) continue
    playerRows.push(player)
    if (playerRows.length >= 8) break
  }

  const nearestEntities = []
  const nearestHostiles = []
  const nearestDrops = []
  for (const entity of Object.values(bot.entities || {})) {
    if (!entity || entity.id === bot.entity.id || entity.isValid === false || !entity.position) continue
    let distance
    try { distance = bot.entity.position.distanceTo(entity.position) } catch { continue }
    if (!Number.isFinite(distance)) continue
    pushNearest(nearestEntities, entity, distance, 12)
    if (isHostileName(entity.name)) pushNearest(nearestHostiles, entity, distance, 8)
    if (distance <= 24 && !dropPickupCoolingDown(entity) && isDroppedItemEntity(entity)) {
      pushNearest(nearestDrops, entity, distance, 8)
    }
  }

  const value = {
    connected: true,
    bot: {
      username: bot.username,
      health: round(bot.health),
      food: round(bot.food),
      saturation: round(bot.foodSaturation),
      position: vec(bot.entity.position),
      yaw: round(bot.entity.yaw),
      pitch: round(bot.entity.pitch),
      onGround: bot.entity.onGround,
      gamemode: bot.game ? bot.game.gameMode : null,
      dimension: bot.game ? bot.game.dimension : null,
      timeOfDay: bot.time ? bot.time.timeOfDay : null
    },
    players: playerRows.map(p => playerInfo(bot, p)),
    entities: nearestEntities.map(row => entityInfo(bot, row.entity)),
    nearbyHostiles: nearestHostiles.map(row => entityInfo(bot, row.entity)),
    nearbyDrops: nearestDrops.map(row => entityInfo(bot, row.entity)),
    nearbyTargets: nearbyTargetsCached(bot),
    chat: Array.isArray(chatBuffer)
      ? chatBuffer
          .filter(item => !item || String(item.username || '').toLowerCase() !== String(bot.username || '').toLowerCase())
          .slice(-20)
      : [],
    inventory: inventoryInfo(bot)
  }
  snapshotCache.set(bot, { at: now, value })
  return value
}

module.exports = { build, inventoryInfo, HOSTILE_NAMES, isHostileName, isDroppedItemEntity }
