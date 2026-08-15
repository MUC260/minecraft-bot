require('dotenv').config({ quiet: true })
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')

function readJson (file) {
  try {
    const raw = fs.readFileSync(path.join(ROOT, file), 'utf8').replace(/^\uFEFF/, '')
    return JSON.parse(raw)
  } catch {
    return {}
  }
}

function str (envKey, value, fallback) {
  if (process.env[envKey] !== undefined && process.env[envKey] !== '') return process.env[envKey]
  if (value !== undefined && value !== '') return value
  return fallback
}

function num (envKey, value, fallback) {
  const n = Number(str(envKey, value, fallback))
  return Number.isFinite(n) ? n : fallback
}

function bool (envKey, value, fallback) {
  if (process.env[envKey] !== undefined) return process.env[envKey] !== 'false' && process.env[envKey] !== '0'
  if (value !== undefined) return value !== false && value !== 'false'
  return fallback
}

const file = readJson('config.json')

module.exports = {
  root: ROOT,
  mc: {
    host: str('MC_HOST', file.mc && file.mc.host, 'localhost'),
    port: num('MC_PORT', file.mc && file.mc.port, 25565),
    username: str('MC_USERNAME', file.mc && file.mc.username, 'MyBot'),
    password: str('MC_PASSWORD', file.mc && file.mc.password, ''),
    auth: str('MC_AUTH', file.mc && file.mc.auth, 'offline'),
    version: str('MC_VERSION', file.mc && file.mc.version, undefined)
  },
  ai: {
    enabled: bool('AI_ENABLED', file.ai && file.ai.enabled, true),
    baseUrl: str('AI_BASE_URL', file.ai && file.ai.baseUrl, 'https://api.openai.com/v1'),
    apiKey: str('AI_API_KEY', file.ai && file.ai.apiKey, ''),
    model: str('AI_MODEL', file.ai && file.ai.model, 'gpt-4o-mini'),
    temperature: num('AI_TEMPERATURE', file.ai && file.ai.temperature, 0.2),
    maxTokens: num('AI_MAX_TOKENS', file.ai && file.ai.maxTokens, 1200),
    intervalMs: num('AI_INTERVAL_MS', file.ai && file.ai.intervalMs, 1500)
  },
  api: {
    host: str('API_HOST', file.api && file.api.host, '127.0.0.1'),
    port: num('API_PORT', file.api && file.api.port, 8787)
  }
}
