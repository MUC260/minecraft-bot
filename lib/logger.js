function stamp () {
  return new Date().toISOString()
}

module.exports = {
  info: (...args) => console.log(`[${stamp()}] [INFO]`, ...args),
  warn: (...args) => console.warn(`[${stamp()}] [WARN]`, ...args),
  error: (...args) => console.error(`[${stamp()}] [ERROR]`, ...args),
  debug: (...args) => {
    if (process.env.DEBUG === '1') console.log(`[${stamp()}] [DEBUG]`, ...args)
  }
}
