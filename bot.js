const mineflayer = require('mineflayer')
const fs = require('fs')

const config = loadConfig()
const bot = mineflayer.createBot({
  host: config.host,
  port: config.port,
  username: config.username,
  password: config.password || undefined,
  auth: config.auth || 'offline'
})

function loadConfig () {
  try {
    return JSON.parse(fs.readFileSync('config.json', 'utf8'))
  } catch {
    return {
      host: process.env.MC_HOST || 'localhost',
      port: Number(process.env.MC_PORT) || 25565,
      username: process.env.MC_USERNAME || 'Bot',
      password: process.env.MC_PASSWORD || '',
      auth: process.env.MC_AUTH || 'offline'
    }
  }
}

bot.once('spawn', () => {
  console.log(`[bot] spawned as ${bot.username} on ${config.host}:${config.port}`)
})

bot.on('chat', (username, message) => {
  if (username === bot.username) return
  console.log(`<${username}> ${message}`)
})

bot.on('kicked', (reason) => console.log('[bot] kicked:', reason))
bot.on('error', (err) => console.error('[bot] error:', err.message))
bot.on('end', (reason) => console.log('[bot] disconnected:', reason))
