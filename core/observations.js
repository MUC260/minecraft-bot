const combat = require('../lib/combat')

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
  // Canonical mineflayer check first. Some entity getters are deprecated and
  // can be misleading, but getDroppedItem() only succeeds for real item drops.
  if (typeof entity.getDroppedItem === 'function') {
    try {
      if (entity.getDroppedItem()) return true
    } catch {}
  }
  const name = String(entity.name || '').toLowerCase()
  const type = String(entity.type || '').toLowerCase()
  const displayName = String(entity.displayName || '').toLowerCase()
  if (name === 'item' || name === 'item_stack') return true
  // objectType is deprecated in prismarine-entity and prints a stack trace on
  // every read. Older object entities can still be recognized by displayName.
  if (type === 'object' && (displayName === 'item' || displayName === 'item stack')) return true
  return false
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
    const items = bot.inventory.items().map(i => ({
      name: i.name,
      displayName: i.displayName || i.name,
      count: i.count,
      slot: i.slot
    }))
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

function build (bot, chatBuffer) {
  if (!bot || !bot.entity) {
    return { connected: false, bot: null, players: [], entities: [], nearbyHostiles: [], nearbyDrops: [], chat: [], inventory: null }
  }
  const players = Object.values(bot.players || {}).filter(p => p && p.entity && p.entity.id !== bot.entity.id)
  const entities = Object.values(bot.entities || {}).filter(e => e && e.id !== bot.entity.id)
  const hostiles = entities.filter(e => isHostileName(e.name)).sort((a, b) => bot.entity.position.distanceTo(a.position) - bot.entity.position.distanceTo(b.position))
  const drops = entities.filter(isDroppedItemEntity).sort((a, b) => bot.entity.position.distanceTo(a.position) - bot.entity.position.distanceTo(b.position))
  return {
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
    players: players.slice(0, 8).map(p => playerInfo(bot, p)),
    entities: entities.slice(0, 12).map(e => entityInfo(bot, e)),
    nearbyHostiles: hostiles.slice(0, 8).map(e => entityInfo(bot, e)),
    nearbyDrops: drops.slice(0, 8).map(e => entityInfo(bot, e)),
    nearbyTargets: nearbyTargets(bot),
    chat: Array.isArray(chatBuffer)
      ? chatBuffer
          .filter(item => !item || String(item.username || '').toLowerCase() !== String(bot.username || '').toLowerCase())
          .slice(-20)
      : [],
    inventory: inventoryInfo(bot)
  }
}

module.exports = { build, inventoryInfo, HOSTILE_NAMES, isHostileName, isDroppedItemEntity }
