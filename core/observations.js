function round (n, digits = 2) {
  if (n === null || n === undefined || Number.isNaN(n)) return null
  return Number(n.toFixed(digits))
}

function vec (v) {
  if (!v) return null
  return { x: round(v.x), y: round(v.y), z: round(v.z) }
}

function playerInfo (bot, player) {
  const entity = player && player.entity
  return {
    username: player.username,
    uuid: player.uuid || null,
    position: entity ? vec(entity.position) : null,
    health: entity ? round(entity.health) : null,
    distance: (bot.entity && entity) ? round(bot.entity.position.distanceTo(entity.position)) : null
  }
}

function entityInfo (bot, entity) {
  return {
    id: entity.id,
    name: entity.name || entity.username || '',
    type: entity.type || '',
    position: vec(entity.position),
    yaw: round(entity.yaw),
    pitch: round(entity.pitch),
    health: round(entity.health),
    distance: bot.entity ? round(bot.entity.position.distanceTo(entity.position)) : null
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
      items: items.slice(0, 36)
    }
  } catch {
    return { held: null, items: [] }
  }
}

function build (bot, chatBuffer) {
  if (!bot || !bot.entity) {
    return { connected: false, bot: null, players: [], entities: [], chat: [], inventory: null }
  }
  const players = Object.values(bot.players || {}).filter(p => p && p.entity && p.entity.id !== bot.entity.id)
  const entities = Object.values(bot.entities || {}).filter(e => e && e.id !== bot.entity.id)
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
    chat: chatBuffer.slice(-20),
    inventory: inventoryInfo(bot)
  }
}

module.exports = { build }
