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
  if (!entity || entity === bot.entity) return false
  // Canonical mineflayer check first. Some entity getters are deprecated and
  // can be misleading, but getDroppedItem() only succeeds for real item drops.
  if (typeof entity.getDroppedItem === 'function') {
    try {
      if (entity.getDroppedItem()) return true
    } catch {}
  }
  const name = String(entity.name || '').toLowerCase()
  const type = String(entity.type || '').toLowerCase()
  const objectType = String(entity.objectType || '').toLowerCase()
  if (objectType === 'item') return true
  if (name === 'item' || name === 'item_stack') return true
  // Older mineflayer versions may only expose type="object" without objectType.
  // Keep this as a last-resort fallback, but prefer the canonical check above.
  if (type === 'object' && !objectType) return true
  return false
}

function nearestItemDrop (bot, radius) {
  let best = null
  for (const entity of Object.values(bot.entities || {})) {
    if (!isDroppedItemEntity(bot, entity)) continue
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

function blockVisible (bot, block) {
  try {
    if (!bot || !block) return false
    if (typeof bot.canSeeBlock === 'function') return !!bot.canSeeBlock(block)
    return true
  } catch {
    return true
  }
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

function isCollectibleLike (block) {
  const n = lowerBlockName(block)
  if (!n) return false
  if (n.endsWith('_log') || n.endsWith('_ore') || n === 'ancient_debris') return true
  if (n === 'pumpkin' || n === 'melon' || n === 'sugar_cane' || n === 'cactus' || n === 'bamboo') return true
  if (n === 'wheat' || n === 'carrots' || n === 'potatoes' || n === 'beetroots' || n === 'nether_wart' || n === 'cocoa' || n === 'sweet_berry_bush') return true
  return false
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
      items = items.filter(i => {
        const n = String(i.name || '').toLowerCase()
        const dn = String(i.displayName || '').toLowerCase()
        const planks = logPlanksName(n)
        return n.includes(m) || dn.includes(m) || (planks && planks.includes(m))
      })
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
      items = items.filter(i => String(i.name || '').toLowerCase().includes(m) || String(i.displayName || '').toLowerCase().includes(m))
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

async function craftItem (bot, itemName, ctx, count = 1, table = null) {
  if (!bot || !bot.inventory || typeof bot.recipesFor !== 'function' || typeof bot.craft !== 'function') return false
  const byName = getItemsByName(bot)
  const def = byName[itemName]
  if (!def) return false
  let recipes = bot.recipesFor(def.id, null, count, table)
  recipes = Array.isArray(recipes) ? recipes : []
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

  await bot.craft(recipe, count, table)
  await sleep(200, ctx)
  return true
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
  const target = String(raw || '').trim().toLowerCase()
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
  const offsets = [[dx, 0, dz], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [-dx, 0, -dz]]
  for (const [ox, oy, oz] of offsets) {
    const pos = new Vec3(Math.floor(here.x) + ox, y + oy, Math.floor(here.z) + oz)
    const block = bot.blockAt(pos)
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
  if (['dirt', 'grass_block', 'sand', 'gravel', 'clay', 'soul_sand'].includes(n)) return 'shovel'
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

async function pickupNearbyDrops (bot, ctx, radius = 8) {
  // Keep looking for a new nearest drop after each attempt. Dropped items can
  // spawn/despawn while we walk, so a single snapshot is not enough.
  for (let i = 0; i < 24; i++) {
    throwIfAborted(ctx)
    const drop = nearestItemDrop(bot, radius)
    if (!drop) return true

    const entity = drop.entity
    const id = entity && entity.id
    if (drop.distance > 2.5) {
      const nav = await pathNearXZ(bot, ctx, entity.position.x, entity.position.z, 1.2, 20000)
      if (nav && nav.preempted) return nav
      if (nav && !nav.ok) continue
    }

    let collected = false
    for (let j = 0; j < 25; j++) {
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
    if (collected) continue

    if (entity && bot.entity.position.distanceTo(entity.position) > 1.2) {
      const nav = await pathNearXZ(bot, ctx, entity.position.x, entity.position.z, 1.0, 15000)
      if (nav && nav.preempted) return nav
      if (nav && !nav.ok) continue
    }
  }
  return true
}

async function chopOneTree (bot, ctx, maxBlocks = 48, radius = 16) {
  const block = findNearestBlockBy(bot, isLogLike, radius, 128)
  if (!block) throw new Error('附近没有可砍的树木')
  try { await combat.equipBestToolForBlock(bot, block.name) } catch {}
  const result = await digConnected(bot, block.position, isLogLike, ctx, maxBlocks)
  if (result.preempted) return result
  const picked = await pickupNearbyDrops(bot, ctx)
  if (picked && picked.preempted) return picked
  return result
}

async function exploreForBuildResources (bot, ctx, attempts = 3) {
  for (let i = 0; i < attempts; i++) {
    const distance = 10 + Math.floor(Math.random() * 8)
    const angle = Math.random() * Math.PI * 2
    const x = bot.entity.position.x + Math.sin(angle) * distance
    const z = bot.entity.position.z + Math.cos(angle) * distance
    const nav = await pathNearXZ(bot, ctx, x, z, 2, 45000)
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
        if (attempt >= 3 || !String(err.message || '').includes('附近没有可砍')) throw err
        const moved = await exploreForBuildResources(bot, ctx, 2)
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

    if (!blockVisible(bot, block)) {
      try { await bot.lookAt(block.position.offset(0.5, 0.5, 0.5), true) } catch {}
      await sleep(150, ctx)
      if (!blockVisible(bot, block)) continue
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
  if (!bot.pathfinder) throw new Error('pathfinder 未加载')
  const acquired = acquirePathfinder(bot, ctx, 'navigate-xz')
  if (!acquired.ok) return acquired
  const acq = acquired.acq
  try {
    const goal = new goals.GoalNearXZ(x, z, range)
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
    if (!bot.pathfinder) throw new Error('pathfinder \u672a\u52a0\u8f7d')
    const distance = Math.max(3, Math.min(Number(args.distance ?? 8), 24))
    const dir = String(args.direction || '').toLowerCase()
    let x
    let z
    if (dir === 'north') { x = bot.entity.position.x; z = bot.entity.position.z - distance }
    else if (dir === 'south') { x = bot.entity.position.x; z = bot.entity.position.z + distance }
    else if (dir === 'east') { x = bot.entity.position.x + distance; z = bot.entity.position.z }
    else if (dir === 'west') { x = bot.entity.position.x - distance; z = bot.entity.position.z }
    else {
      const angle = Math.random() * Math.PI * 2
      x = bot.entity.position.x + Math.sin(angle) * distance
      z = bot.entity.position.z + Math.cos(angle) * distance
    }
    const nav = await pathNearXZ(bot, ctx, x, z, 2, 45000)
    if (nav && nav.preempted) return nav
    if (nav && !nav.ok) throw new Error(nav.reason || '\u65e0\u6cd5\u63a2\u7d22')
    return '\u5df2\u63a2\u7d22\u81f3 ' + Math.floor(x) + ',' + Math.floor(z)
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
    if (!username) throw new Error('follow ??????')
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
    if (!player || !player.entity) throw new Error('?????: ' + username)

    const acquired = acquirePathfinder(bot, ctx, 'follow')
    if (!acquired.ok) return { preempted: acquired.preempted, reason: acquired.reason }
    const acq = acquired.acq
    try {
      const started = Date.now()
      let lastTargetId = null
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
        const idle = bot.pathfinderOwner ? bot.pathfinderOwner.isIdle() : true
        if (lastTargetId !== target.id || (dist > distance + 1 && idle)) {
          const goal = new goals.GoalFollow(target, distance)
          const installed = setPathfinderGoal(bot, acq, goal, { dynamic: true })
          if (!installed.ok) throw new Error(installed.reason || '?????????')
          lastTargetId = target.id
        }
        await sleep(400, ctx)
      }
      return '????? ' + username
    } catch (err) {
      const reason = ctx && ctx.signal ? ctx.signal.reason : ''
      if (reason === 'reactive-preempt') {
        return { preempted: true, reason: 'reactive ?? follow' }
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
      block = name ? findNearestBlock(bot, { ...args, name }) : findNearestBlockBy(bot, isCollectibleLike, radius, 128)
      if (!block) itemDrop = nearestItemDrop(bot, radius)
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
      const dist = bot.entity.position.distanceTo(block.position)
      if (dist > 3.5) {
        const nav = await pathNearXZ(bot, ctx, block.position.x, block.position.z, 2.5, 45000)
        if (nav && nav.preempted) return nav
        if (nav && !nav.ok) throw new Error(nav.reason || '无法到达目标方块')
      }
      if (!blockVisible(bot, block)) {
        try { await bot.lookAt(block.position.offset(0.5, 0.5, 0.5), true) } catch {}
        await sleep(150, ctx)
        if (!blockVisible(bot, block)) throw new Error('目标方块不可见，无法采集')
      }
      try { await combat.equipBestToolForBlock(bot, block.name) } catch {}
      await raceWithAbort(bot.dig(block, true), ctx, () => {
        if (typeof bot.stopDigging === 'function') bot.stopDigging()
      })
      const picked = await pickupNearbyDrops(bot, ctx, radius)
      if (picked && picked.preempted) return picked
      return '采集 ' + block.name + '，并已拾取附近掉落物'
    }

    const picked = await pickupNearbyDrops(bot, ctx, radius)
    if (picked && picked.preempted) return picked
    return '已拾取附近掉落物'
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
    const predicate = name ? block => lowerBlockName(block) === name : isOreLike
    const radius = Math.max(4, Math.min(Number(args.radius ?? 12), 24))
    const block = findNearestBlockBy(bot, predicate, radius, 128)
    if (!block) throw new Error('附近没有可开采的矿石')
    const maxBlocks = Math.max(1, Math.min(Number(args.max ?? 48), 96))
    try {
      const tool = await combat.equipBestToolForBlock(bot, block.name)
      if (!tool) await ensureWoodenToolForBlock(bot, block.name, ctx)
    } catch {}
    const result = await digConnected(bot, block.position, predicate, ctx, maxBlocks)
    if (result.preempted) return result
    if (result.dug === 0) throw new Error('没有挖到可见的矿石，需要先靠近或换个位置')
    const picked = await pickupNearbyDrops(bot, ctx, radius)
    if (picked && picked.preempted) return picked
    return `采矿完成：${block.name} 共 ${result.dug} 块，并已拾取附近掉落物`
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
    if (!result.placed) throw new Error('房子还没开始建，可能被挡住了。')

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
    // Gear is only useful if the bot actually has wood in hand. Pick up any
    // drops first, then gather/craft planks and place a workbench before the
    // crafting loop so wooden tools do not silently fail on a fresh start.
    const picked = await pickupNearbyDrops(bot, ctx, 8)
    if (picked && picked.preempted) return picked

    if (countMaterialFamily(bot, '_planks') < 4 && !findLogItem(bot, null)) {
      const planks = await gatherAndCraftPlanks(bot, null, ctx, 12)
      if (planks && planks.preempted) return planks
    }
    if (countMaterialFamily(bot, '_planks') < 4) {
      const planks = await gatherAndCraftPlanks(bot, null, ctx, 12)
      if (planks && planks.preempted) return planks
    }
    if (!findCraftingTableBlock(bot, 8)) await ensureCraftingTable(bot, ctx)

    const made = []
    for (const itemName of GEAR_PRIORITY) {
      throwIfAborted(ctx)
      if (findInventoryItemByName(bot, itemName)) continue
      try {
        const r = await craftOneItem(bot, itemName, ctx, 1)
        if (r && r.preempted) return r
        if (typeof r === 'string') made.push(itemName)
      } catch {}
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
    let equipped = []
    try { equipped = await combat.equipBestArmor(bot) } catch {}
    try { await combat.equipBestMelee(bot) } catch {}
    try { await combat.equipShield(bot) } catch {}
    const summary = made.length ? ('已制作: ' + made.join(', ')) : '装备已就绪，无需再制作'
    const eq = equipped.length ? ('；自动装备: ' + equipped.join(', ')) : ''
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
