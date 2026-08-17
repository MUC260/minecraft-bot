const fs = require('fs')
const path = require('path')
const { EventEmitter } = require('events')

const events = new EventEmitter()
let fileEnabled = false
let filePath = null
let maxSizeBytes = 5 * 1024 * 1024
let maxBackups = 3

function stamp () {
  return new Date().toISOString()
}

// 日志轮转：超过 maxSizeBytes 时把当前文件滚动为 .1/.2/...，删除最老的备份。
function rotateIfNeeded () {
  if (!fileEnabled || !filePath || !fs.existsSync(filePath)) return
  let size
  try {
    size = fs.statSync(filePath).size
  } catch {
    return
  }
  if (size < maxSizeBytes) return
  try {
    // 从最老的开始往后移：agent.log.2 -> agent.log.3, agent.log.1 -> .2
    for (let i = maxBackups - 1; i >= 1; i--) {
      const from = filePath + '.' + i
      const to = filePath + '.' + (i + 1)
      if (fs.existsSync(from)) fs.renameSync(from, to)
    }
    if (fs.existsSync(filePath)) fs.renameSync(filePath, filePath + '.1')
    process.stderr.write(`[${stamp()}] [WARN] 日志超过 ${Math.round(maxSizeBytes / 1024 / 1024)}MB，已轮转\n`)
  } catch (err) {
    process.stderr.write(`[${stamp()}] [WARN] 日志轮转失败: ${err.message}\n`)
  }
}

function formatArg (arg) {
  if (typeof arg === 'string') return arg
  if (arg instanceof Error) return arg.stack || arg.message
  try {
    return JSON.stringify(arg)
  } catch {
    return String(arg)
  }
}

function line (level, args) {
  return `[${stamp()}] [${level}] ${args.map(formatArg).join(' ')}\n`
}

function emit (level, args) {
  const text = line(level, args)
  if (level === 'ERROR') process.stderr.write(text)
  else if (level === 'WARN') process.stderr.write(text)
  else process.stdout.write(text)

  if (fileEnabled && filePath) {
    rotateIfNeeded()
    fs.appendFile(filePath, text, () => {})
  }

  const item = {
    time: Date.now(),
    level: level.toLowerCase(),
    message: args.map(formatArg).join(' ')
  }
  events.emit('log', item)
}

function init (opts = {}) {
  if (opts === false) {
    fileEnabled = false
    filePath = null
    return module.exports
  }
  if (opts.file === false) {
    fileEnabled = false
    filePath = null
    return module.exports
  }
  maxSizeBytes = Math.max(1024 * 1024, Number(opts.maxSizeBytes) || 5 * 1024 * 1024)
  maxBackups = Math.max(1, Math.min(10, Number(opts.maxBackups) || 3))
  try {
    const dir = path.resolve(opts.dir || 'logs')
    fs.mkdirSync(dir, { recursive: true })
    filePath = path.join(dir, opts.name || 'agent.log')
    fileEnabled = true
  } catch (err) {
    fileEnabled = false
    process.stderr.write(`[${stamp()}] [WARN] logger file init failed: ${err.message}\n`)
  }
  return module.exports
}

function parseLogLine (text) {
  const clean = String(text || '').replace(/^\uFEFF/, '')
  const m = clean.match(/^\[([^\]]+)\] \[(INFO|WARN|ERROR|DEBUG)\]\s?(.*)$/)
  if (!m) return null
  const timestamp = Date.parse(m[1])
  return {
    time: Number.isFinite(timestamp) ? timestamp : Date.now(),
    level: m[2].toLowerCase(),
    message: m[3]
  }
}

function readTail (limit = 300, maxBytes = 512 * 1024) {
  if (!fileEnabled || !filePath || !fs.existsSync(filePath)) {
    return []
  }
  const size = fs.statSync(filePath).size
  if (size === 0) return []
  const bytesToRead = Math.min(size, maxBytes)
  const fd = fs.openSync(filePath, 'r')
  try {
    const buf = Buffer.alloc(bytesToRead)
    fs.readSync(fd, buf, 0, bytesToRead, size - bytesToRead)
    let text = buf.toString('utf8')
    // Drop a potentially half line at the start, except when we read the whole file.
    if (size > bytesToRead) {
      const firstNewline = text.indexOf('\n')
      if (firstNewline !== -1) text = text.slice(firstNewline + 1)
    }
    const lines = text.split(/\r?\n/).filter(Boolean)
    return lines.slice(-limit).map(parseLogLine).filter(Boolean)
  } finally {
    fs.closeSync(fd)
  }
}

module.exports = {
  init,
  on: (...args) => events.on(...args),
  off: (...args) => events.off(...args),
  getPath: () => filePath,
  readTail,
  info: (...args) => emit('INFO', args),
  warn: (...args) => emit('WARN', args),
  error: (...args) => emit('ERROR', args),
  debug: (...args) => {
    if (process.env.DEBUG === '1') emit('DEBUG', args)
  }
}
