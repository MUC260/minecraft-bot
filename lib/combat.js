const ARMOR_SLOT_TO_DEST = { head: 'head', torso: 'torso', legs: 'legs', feet: 'feet' }
const ARMOR_DEST_TO_SLOT = { head: 'head', torso: 'torso', legs: 'legs', feet: 'feet' }
const SLOT_ORDER = ['head', 'torso', 'legs', 'feet']
const MATERIAL_SCORE = {
  netherite: 5,
  diamond: 4,
  iron: 3,
  chainmail: 2,
  gold: 2,
  leather: 1,
  turtle: 2,
  wood: 1,
  stone: 1
}

function lowerName (item) {
  if (!item) return ''
  return String(item.name || item.type || '').toLowerCase()
}

function materialOf (name) {
  const n = String(name || '').toLowerCase()
  if (n.includes('netherite')) return 'netherite'
  if (n.includes('diamond')) return 'diamond'
  if (n.includes('chainmail')) return 'chainmail'
  if (n.includes('iron')) return 'iron'
  if (n.includes('gold') || n.includes('golden')) return 'gold'
  if (n.includes('leather')) return 'leather'
  if (n.includes('turtle')) return 'turtle'
  if (n.includes('wood') || n.includes('wooden')) return 'wood'
  if (n.includes('stone')) return 'stone'
  return ''
}

function materialScore (name) {
  return MATERIAL_SCORE[materialOf(name)] || 0
}

function armorSlotOf (name) {
  const n = String(name || '').toLowerCase()
  if (n.endsWith('_helmet') || n === 'turtle_helmet') return 'head'
  if (n.endsWith('_chestplate')) return 'torso'
  if (n.endsWith('_leggings')) return 'legs'
  if (n.endsWith('_boots')) return 'feet'
  return null
}

function isArmor (item) {
  return !!armorSlotOf(lowerName(item))
}

function isShield (item) {
  return lowerName(item) === 'shield'
}

function isTool (item) {
  return /_(pickaxe|axe|shovel|sword|hoe)$/.test(lowerName(item))
}

// 返回 0~100 的耐久百分比；无耐久上限的物品返回 100。
function durabilityPercent (item) {
  if (!item) return null
  const max = Number(item.maxDurability) || 0
  if (max <= 0) return null
  const used = Number.isFinite(item.durabilityUsed) ? Number(item.durabilityUsed) : 0
  return Math.max(0, Math.min(100, Math.round((1 - used / max) * 100)))
}

// 找出背包里耐久度低于阈值的工具（默认 30%），按耐久百分比升序返回。
function wornTools (items, thresholdPct = 30) {
  if (!Array.isArray(items)) return []
  return items
    .filter(i => i && isTool(i))
    .map(i => ({ item: i, pct: durabilityPercent(i) }))
    .filter(entry => entry.pct !== null && entry.pct < thresholdPct)
    .sort((a, b) => a.pct - b.pct)
}

function isMeleeWeapon (item) {
  const n = lowerName(item)
  return /_(sword|axe)$/.test(n) || n === 'trident' || n === 'mace'
}

function armorScore (item) {
  const slot = armorSlotOf(lowerName(item))
  if (!slot) return 0
  const slotBonus = { head: 2, torso: 3, legs: 2, feet: 1 }[slot] || 0
  let score = materialScore(lowerName(item)) * 4 + slotBonus
  if (String(item.name || '').includes('turtle_helmet')) score += 1
  return score
}

function weaponScore (item) {
  const n = lowerName(item)
  if (!isMeleeWeapon(item)) return 0
  const base = materialScore(n) * 3
  if (n.endsWith('_axe')) return base + 1
  if (n === 'trident') return 12
  if (n === 'mace') return 12
  return base
}

function bestMeleeWeapon (items) {
  return items
    .filter(isMeleeWeapon)
    .sort((a, b) => weaponScore(b) - weaponScore(a))[0] || null
}

function bestArmorForSlot (items, slot) {
  return items
    .filter(i => armorSlotOf(lowerName(i)) === slot)
    .sort((a, b) => armorScore(b) - armorScore(a))[0] || null
}

function currentArmorItems (bot) {
  const out = {}
  for (const slot of SLOT_ORDER) {
    try {
      const dest = ARMOR_SLOT_TO_DEST[slot]
      const invSlot = bot.getEquipmentDestSlot(dest)
      out[slot] = invSlot == null ? null : (bot.inventory.slots[invSlot] || null)
    } catch {
      out[slot] = null
    }
  }
  return out
}

function currentArmorScore (bot) {
  const items = currentArmorItems(bot)
  let total = 0
  for (const slot of SLOT_ORDER) {
    const item = items[slot]
    if (item) total += armorScore(item)
  }
  return total
}

function armorSummary (bot) {
  const items = currentArmorItems(bot)
  const slots = {}
  for (const slot of SLOT_ORDER) {
    const item = items[slot]
    slots[slot] = item ? { name: item.name, score: armorScore(item) } : null
  }
  return { slots, totalScore: currentArmorScore(bot) }
}

function heldWeaponSummary (bot) {
  const held = bot.heldItem
  if (!held || !isMeleeWeapon(held)) return { name: held ? held.name : null, melee: false, score: 0 }
  return { name: held.name, melee: true, score: weaponScore(held) }
}

function shieldSlot (bot) {
  try {
    const slot = bot.getEquipmentDestSlot('off-hand')
    return slot == null ? null : (bot.inventory.slots[slot] || null)
  } catch {
    return null
  }
}

const TOOL_TIERS = ['netherite', 'diamond', 'iron', 'stone', 'wooden', 'golden']

// 工具耐久低于该百分比时视为“不能再用”，优先选其他更耐用的工具。
const TOOL_MIN_DURABILITY_PCT = 15

const PICKAXE_BLOCKS = new Set([
  'stone', 'cobblestone', 'deepslate', 'cobbled_deepslate', 'granite', 'diorite',
  'andesite', 'tuff', 'netherrack', 'blackstone', 'basalt', 'obsidian', 'end_stone',
  'iron_block', 'gold_block', 'diamond_block', 'emerald_block', 'lapis_block',
  'redstone_block', 'coal_block', 'copper_block', 'amethyst_block', 'mossy_cobblestone',
  'stone_bricks', 'cracked_stone_bricks', 'polished_granite', 'polished_diorite',
  'polished_andesite', 'polished_deepslate', 'deepslate_bricks', 'bricks', 'prismarine',
  'sandstone', 'red_sandstone', 'quartz_block', 'smooth_stone', 'calcite', 'dripstone_block',
  'nether_bricks', 'red_nether_bricks', 'end_stone_bricks', 'purpur_block', 'magma_block',
  'glowstone', 'sea_lantern', 'terracotta', 'clay'
])

const SHOVEL_BLOCKS = new Set([
  'dirt', 'grass_block', 'sand', 'red_sand', 'gravel', 'clay', 'soul_sand',
  'soul_soil', 'mud', 'podzol', 'mycelium', 'coarse_dirt', 'rooted_dirt', 'snow_block'
])

function isUsableTool (item, minDurabilityPct = TOOL_MIN_DURABILITY_PCT) {
  const pct = durabilityPercent(item)
  // 没有耐久信息（如创造模式物品/无耐久物品）视为可用；有耐久但低于阈值则不可用。
  if (pct === null) return true
  return pct >= minDurabilityPct
}

function toolForBlock (blockName, items, opts = {}) {
  const n = String(blockName || '').toLowerCase()
  const logLike = n.endsWith('_log') || n.endsWith('_stem') || n.endsWith('_hyphae') || n === 'mushroom_stem'
  const oreLike = n.endsWith('_ore') || n === 'ancient_debris'
  const shovelLike = SHOVEL_BLOCKS.has(n)
  const pickLike = PICKAXE_BLOCKS.has(n)
  // 优先精确工具类型；挖石头/泥土时也匹配镐/铲，找不到再退回空手（返回 null）。
  const kinds = logLike ? ['axe'] : (oreLike || pickLike) ? ['pickaxe'] : shovelLike ? ['shovel'] : []
  if (!kinds.length) return null
  const minPct = Number(opts.minDurabilityPct) >= 0 ? Number(opts.minDurabilityPct) : TOOL_MIN_DURABILITY_PCT
  const available = items.filter(i => /_(axe|pickaxe|shovel)$/.test(lowerName(i)))
  for (const tier of TOOL_TIERS) {
    for (const kind of kinds) {
      const want = tier + '_' + kind
      const item = available.find(i => lowerName(i) === want && isUsableTool(i, minPct))
      if (item) return item
    }
  }
  return null
}

async function equipBestToolForBlock (bot, blockName, opts = {}) {
  if (!bot || !bot.inventory) return null
  const items = bot.inventory.items().filter(i => i)
  const best = toolForBlock(blockName, items, opts)
  if (!best) return null
  const held = bot.heldItem
  if (held && held.slot === best.slot) return best
  await bot.equip(best, 'hand')
  return best
}

async function equipBestMelee (bot) {
  const items = bot.inventory.items().filter(isMeleeWeapon)
  const best = bestMeleeWeapon(items)
  if (!best) return null
  const held = bot.heldItem
  const heldScore = held && isMeleeWeapon(held) ? weaponScore(held) : 0
  if (best.slot === bot.getEquipmentDestSlot('hand') || (held && held.slot === best.slot)) return best
  if (weaponScore(best) > heldScore || !held) {
    await bot.equip(best, 'hand')
  }
  return best
}

async function equipBestArmor (bot) {
  const current = currentArmorItems(bot)
  const equipped = []
  for (const slot of SLOT_ORDER) {
    const best = bestArmorForSlot(bot.inventory.items(), slot)
    if (!best) continue
    const cur = current[slot]
    const curScore = cur ? armorScore(cur) : 0
    const destSlot = bot.getEquipmentDestSlot(slot)
    if (best.slot === destSlot || cur?.slot === best.slot) continue
    if (armorScore(best) > curScore) {
      await bot.equip(best, slot)
      equipped.push(best.name)
    }
  }
  return equipped
}

async function equipShield (bot) {
  const shield = bot.inventory.items().find(isShield)
  if (!shield) return false
  try {
    const dest = bot.getEquipmentDestSlot('off-hand')
    if (dest == null) return false
    const current = bot.inventory.slots[dest]
    if (current && current.slot === shield.slot) return true
    if (current && isShield(current)) return true
    await bot.equip(shield, 'off-hand')
    return true
  } catch {
    return false
  }
}

function hasShield (bot) {
  const held = shieldSlot(bot)
  return !!(held && isShield(held))
}

function waitForConsumeEnd (bot, timeoutMs = 3500) {
  return new Promise(resolve => {
    const start = Date.now()
    const tick = () => {
      if (!bot || bot.usingItem === false || bot.usingItem == null || Date.now() - start >= timeoutMs) return resolve()
      setTimeout(tick, 100)
    }
    tick()
  })
}

async function consumePreserveLoadout (bot, food) {
  if (!bot || !food) return false
  const heldBefore = bot.heldItem || null
  const handSlotBefore = heldBefore ? heldBefore.slot : null
  const offhandBefore = shieldSlot(bot)
  const offhandSlotBefore = offhandBefore ? offhandBefore.slot : null
  let consumed = false
  try {
    await bot.equip(food, 'hand')
    await bot.consume()
    consumed = true
    // mineflayer may resolve consume() before the eating animation fully ends.
    await waitForConsumeEnd(bot)
  } finally {
    // Restore the off-hand first. Eating food that was in the off-hand clears
    // it, and the user specifically asked us to never leave the shield off.
    if (offhandSlotBefore != null && bot.inventory && bot.inventory.slots && bot.inventory.slots[offhandSlotBefore]) {
      const currentOff = shieldSlot(bot)
      if (!currentOff || currentOff.slot !== offhandSlotBefore) {
        try { await bot.equip(bot.inventory.slots[offhandSlotBefore], 'off-hand') } catch {}
      }
    } else if (offhandBefore && isShield(offhandBefore)) {
      try { await equipShield(bot) } catch {}
    }

    if (handSlotBefore != null && bot.inventory && bot.inventory.slots && bot.inventory.slots[handSlotBefore]) {
      const currentHeld = bot.heldItem
      if (!currentHeld || currentHeld.slot !== handSlotBefore) {
        try { await bot.equip(bot.inventory.slots[handSlotBefore], 'hand') } catch {}
      }
    } else if (heldBefore && bot.heldItem !== heldBefore) {
      try { await bot.equip(heldBefore, 'hand') } catch {}
    }
  }
  return consumed
}


module.exports = {
  ARMOR_SLOT_TO_DEST,
  ARMOR_DEST_TO_SLOT,
  SLOT_ORDER,
  MATERIAL_SCORE,
  TOOL_TIERS,
  PICKAXE_BLOCKS,
  SHOVEL_BLOCKS,
  lowerName,
  materialOf,
  materialScore,
  armorSlotOf,
  isArmor,
  isShield,
  isMeleeWeapon,
  armorScore,
  weaponScore,
  bestMeleeWeapon,
  bestArmorForSlot,
  currentArmorItems,
  currentArmorScore,
  armorSummary,
  heldWeaponSummary,
  shieldSlot,
  hasShield,
  equipBestMelee,
  equipBestArmor,
  equipShield,
  consumePreserveLoadout,
  toolForBlock,
  equipBestToolForBlock,
  durabilityPercent,
  wornTools,
  isUsableTool
}
