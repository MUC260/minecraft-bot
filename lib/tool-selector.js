const TOOL_KINDS = ['pickaxe', 'axe', 'shovel', 'hoe', 'shears']
const MATERIAL_RANK = { netherite: 7, diamond: 6, iron: 5, stone: 4, golden: 3, wooden: 2, gold: 3 }

function kindOf (item) {
  const name = String(item?.name || '').toLowerCase()
  return TOOL_KINDS.find(kind => name === kind || name.endsWith(`_${kind}`)) || ''
}

function materialRank (item) {
  const name = String(item?.name || '').toLowerCase()
  for (const [material, rank] of Object.entries(MATERIAL_RANK)) {
    if (name.startsWith(`${material}_`)) return rank
  }
  return 1
}

function preferredKind (block) {
  const name = String(block?.name || '').toLowerCase()
  const material = String(block?.material || '').toLowerCase()
  if (material.includes('pickaxe') || name.includes('ore') || name.includes('stone') || name.includes('deepslate') || name === 'ancient_debris') return 'pickaxe'
  if (material.includes('axe') || name.endsWith('_log') || name.endsWith('_wood') || name.endsWith('_stem') || name.endsWith('_hyphae') || name.endsWith('_planks')) return 'axe'
  if (material.includes('shovel') || /(^|_)(dirt|sand|gravel|clay|snow|soul_sand|soul_soil)$/.test(name)) return 'shovel'
  if (material.includes('hoe') || name.includes('leaves') || name.includes('wart_block')) return 'hoe'
  if (name.includes('wool') || name === 'cobweb') return 'shears'
  return ''
}

function digTime (block, item, bot) {
  try {
    return block.digTime(item.type, false, !!bot.entity?.isInWater, !bot.entity?.onGround, item.enchants || [], bot.entity?.effects || {})
  } catch {
    return Number.POSITIVE_INFINITY
  }
}

function bestToolForBlock (bot, block) {
  const tools = (bot.inventory?.items?.() || []).filter(item => kindOf(item))
  if (!tools.length) return null
  const harvestIds = new Set(Object.keys(block?.harvestTools || {}).map(Number))
  const harvestable = harvestIds.size ? tools.filter(item => harvestIds.has(Number(item.type))) : []
  const preferred = preferredKind(block)
  const candidates = (harvestable.length ? harvestable : tools.filter(item => kindOf(item) === preferred)).slice()
  if (!candidates.length) return null
  candidates.sort((a, b) => {
    const byTime = digTime(block, a, bot) - digTime(block, b, bot)
    return Number.isFinite(byTime) && byTime !== 0 ? byTime : materialRank(b) - materialRank(a)
  })
  return candidates[0] || null
}

async function equipBestToolForBlock (bot, block) {
  const item = bestToolForBlock(bot, block)
  if (!item) return null
  if (!bot.heldItem || bot.heldItem.slot !== item.slot) await bot.equip(item, 'hand')
  return item
}

module.exports = { bestToolForBlock, equipBestToolForBlock, kindOf, preferredKind }
