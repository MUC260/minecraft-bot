const fs = require('fs')
const path = require('path')

const DIR = __dirname
let blockDb = null
let buildingDb = null

function loadJson (name) {
  try {
    const raw = fs.readFileSync(path.join(DIR, name), 'utf8').replace(/^\uFEFF/, '')
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function getBlocks () {
  if (!blockDb) blockDb = loadJson('block_knowledge.json') || { blocks: [] }
  return blockDb
}

function getBuildings () {
  if (!buildingDb) buildingDb = loadJson('building_knowledge.json') || { guides: [] }
  return buildingDb
}

function normalizeId (name) {
  return String(name || '').toLowerCase().replace(/^minecraft:/, '')
}

function queryBlock (name) {
  const n = normalizeId(name)
  if (!n) return null
  const db = getBlocks()
  const blocks = Array.isArray(db.blocks) ? db.blocks : []
  for (const b of blocks) {
    const ids = Array.isArray(b.ids) ? b.ids.map(normalizeId) : []
    if (ids.includes(n) || normalizeId(b.name).includes(n) || n.includes(normalizeId(b.name))) return b
  }
  return null
}

function queryBuilding (id) {
  const n = normalizeId(id)
  const db = getBuildings()
  const guides = Array.isArray(db.guides) ? db.guides : []
  if (n === 'list') return { guides: guides.map(g => ({ id: g.id, name: g.name, category: g.category })) }
  return guides.find(g => normalizeId(g.id) === n || normalizeId(g.name).includes(n) || n.includes(normalizeId(g.id))) || null
}

function listBuildingIds () {
  const db = getBuildings()
  return (Array.isArray(db.guides) ? db.guides : []).map(g => g.id)
}

module.exports = { queryBlock, queryBuilding, listBuildingIds }
