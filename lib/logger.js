const fs = require('fs')
const path = require('path')

let fileEnabled = false
let filePath = null

function stamp () {
  return new Date().toISOString()
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
    fs.appendFile(filePath, text, () => {})
  }
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

module.exports = {
  init,
  info: (...args) => emit('INFO', args),
  warn: (...args) => emit('WARN', args),
  error: (...args) => emit('ERROR', args),
  debug: (...args) => {
    if (process.env.DEBUG === '1') emit('DEBUG', args)
  }
}
