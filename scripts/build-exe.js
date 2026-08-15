const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

const ROOT = path.join(__dirname, '..')
const DATA_JS = path.join(ROOT, 'node_modules', 'minecraft-data', 'data.js')
const BACKUP_JS = path.join(ROOT, 'node_modules', 'minecraft-data', 'data.js.orig-backup')

function defaultVersions () {
  try {
    const v = require(path.join(ROOT, 'node_modules', 'mineflayer', 'lib', 'version.js'))
    return v.testedVersions || []
  } catch {
    return []
  }
}

function readVersionBlocks (text) {
  const lines = text.split(/\r?\n/)
  const blocks = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    const m = line.match(/^    '([^']+)': \{/)
    if (!m) {
      i++
      continue
    }
    let end = -1
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j] === '    }' || lines[j] === '    },') {
        end = j
        break
      }
    }
    if (end === -1) {
      i++
      continue
    }
    blocks.push({ key: m[1], start: i, end })
    i = end + 1
  }
  return blocks
}

function writeTrimmedDataJs (versions) {
  if (!fs.existsSync(DATA_JS)) throw new Error('未找到 minecraft-data/data.js')
  if (!fs.existsSync(BACKUP_JS)) fs.copyFileSync(DATA_JS, BACKUP_JS)

  const original = fs.readFileSync(BACKUP_JS, 'utf8')
  const lines = original.split(/\r?\n/)
  const blocks = readVersionBlocks(original)
  const wanted = new Set(versions)

  // Extract only the pc section. Bedrock is intentionally left empty:
  // mineflayer is a Java Edition bot and does not need bedrock data.
  const pcStart = lines.findIndex(l => l === "  'pc': {")
  const bedrockStart = lines.findIndex((l, idx) => idx > pcStart && l === "  'bedrock': {")
  if (pcStart === -1 || bedrockStart === -1) throw new Error('无法定位 data.js 的 pc/bedrock 区块')

  const pcBlocks = blocks.filter(b => b.start > pcStart && b.start < bedrockStart)
  const kept = pcBlocks.filter(b => wanted.has(b.key))

  if (kept.length === 0) throw new Error('没有匹配的 Minecraft 版本可打包')

  const out = []
  out.push('module.exports =')
  out.push('{')
  out.push("  'pc': {")

  kept.forEach((block, idx) => {
    const last = idx === kept.length - 1
    for (let i = block.start; i <= block.end; i++) {
      let line = lines[i]
      if (i === block.end && !last) line = line.replace(/,?$/, ',')
      if (i === block.end && last) line = line.replace(/,\s*$/, '')
      out.push(line)
    }
  })

  out.push('  },')
  out.push("  'bedrock': {")
  out.push('  }')
  out.push('}')

  const next = out.join('\n') + '\n'
  fs.writeFileSync(DATA_JS, next, 'utf8')
  return { kept: kept.map(b => b.key), bytes: Buffer.byteLength(next), missing: versions.filter(v => !kept.some(b => b.key === v)) }
}

function restoreDataJs () {
  try {
    if (fs.existsSync(BACKUP_JS)) {
      fs.copyFileSync(BACKUP_JS, DATA_JS)
      fs.unlinkSync(BACKUP_JS)
    }
  } catch (err) {
    console.warn('恢复 minecraft-data/data.js 失败:', err.message)
  }
}

function runPkg () {
  const pkgBin = path.join(ROOT, 'node_modules', '.bin', 'pkg')
  const exe = process.platform === 'win32' ? 'pkg.cmd' : 'pkg'
  const cmd = path.join(ROOT, 'node_modules', '.bin', exe)
  const target = process.env.PKG_TARGET || (process.env.PKG_SEA === '1' ? 'node24-win-x64' : 'node22-win-x64')
  const args = [
    '.',
    '--out-path', 'dist',
    '--target', target,
    '--compress', 'Brotli'
  ]
  if (process.env.PKG_SEA === '1') args.splice(1, 0, '--sea')
  if (process.env.DEBUG_PKG === '1') args.push('--debug')
  const res = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32' })
  if (res.error) throw res.error
  if (res.status !== 0) throw new Error(`pkg exited with ${res.status}`)
}

async function main () {
  const envVersions = (process.env.MC_DATA_PC_VERSIONS || '').split(',').map(s => s.trim()).filter(Boolean)
  const versions = envVersions.length ? envVersions : defaultVersions()

  let info
  try {
    info = writeTrimmedDataJs(versions)
  } catch (err) {
    console.error('裁剪 minecraft-data 失败:', err.message)
    process.exit(1)
  }

  console.log('保留 Minecraft Java 版本:', info.kept.join(', '))
  console.log('裁剪后 data.js 大小:', `${(info.bytes / 1024).toFixed(1)} KB`)
  if (info.missing.length) console.warn('以下版本在 data.js 中不存在，已跳过:', info.missing.join(', '))

  try {
    if (process.env.SKIP_PKG !== '1') runPkg()
  } finally {
    if (process.env.KEEP_TRIMMED !== '1') restoreDataJs()
  }
}

main()