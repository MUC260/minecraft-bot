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
    intervalMs: num('AI_INTERVAL_MS', file.ai && file.ai.intervalMs, 1500),
    planAhead: bool('AI_PLAN_AHEAD', file.ai && file.ai.planAhead, true)
  },
  api: {
    host: str('API_HOST', file.api && file.api.host, '127.0.0.1'),
    port: num('API_PORT', file.api && file.api.port, 8787)
  },
  reactive: {
    lowHealthFleeThreshold: num('REACTIVE_LOW_HEALTH_FLEE', file.reactive && file.reactive.lowHealthFleeThreshold, 8),
    criticalHealthLogoutThreshold: num('REACTIVE_CRITICAL_LOGOUT', file.reactive && file.reactive.criticalHealthLogoutThreshold, 4),
    hostileScanRadius: num('REACTIVE_HOSTILE_SCAN', file.reactive && file.reactive.hostileScanRadius, 16),
    hostileExitRadius: num('REACTIVE_HOSTILE_EXIT', file.reactive && file.reactive.hostileExitRadius, 42),
    hostileExitDebounceMs: num('REACTIVE_HOSTILE_EXIT_DEBOUNCE', file.reactive && file.reactive.hostileExitDebounceMs, 500),
    engageOverFlee: bool('REACTIVE_ENGAGE_OVER_FLEE', file.reactive && file.reactive.engageOverFlee, false),
    requireShieldToEngage: bool('REACTIVE_REQUIRE_SHIELD', file.reactive && file.reactive.requireShieldToEngage, false),
    maxMeleeEngageThreatCount: num('REACTIVE_MAX_ENGAGE_THREATS', file.reactive && file.reactive.maxMeleeEngageThreatCount, 1),
    minArmorScoreToEngage: num('REACTIVE_MIN_ARMOR_SCORE', file.reactive && file.reactive.minArmorScoreToEngage, 6),
    fleeRange: num('REACTIVE_FLEE_RANGE', file.reactive && file.reactive.fleeRange, 12),
    fleeMinThreatDistance: num('REACTIVE_FLEE_MIN_THREAT_DISTANCE', file.reactive && file.reactive.fleeMinThreatDistance, 2.5),
    fleeMinPathLength: num('REACTIVE_FLEE_MIN_PATH_LENGTH', file.reactive && file.reactive.fleeMinPathLength, 5),
    fleeEscapeTestDistance: num('REACTIVE_FLEE_TEST_DISTANCE', file.reactive && file.reactive.fleeEscapeTestDistance, 10),
    fleeReplanThresholdBlocks: num('REACTIVE_FLEE_REPLAN_THRESHOLD', file.reactive && file.reactive.fleeReplanThresholdBlocks, 4),
    maxInterruptionsPerTarget: num('REACTIVE_MAX_INTERRUPTIONS', file.reactive && file.reactive.maxInterruptionsPerTarget, 3),
    resumeDebounceMs: num('REACTIVE_RESUME_DEBOUNCE', file.reactive && file.reactive.resumeDebounceMs, 1000),
    autoEatStartAt: num('REACTIVE_AUTO_EAT_START', file.reactive && file.reactive.autoEatStartAt, 18),
    reactiveConsumablesEnabled: bool('REACTIVE_CONSUMABLES', file.reactive && file.reactive.reactiveConsumablesEnabled, true)
  },
  executor: {
    skillTimeoutMs: num('EXECUTOR_SKILL_TIMEOUT', file.executor && file.executor.skillTimeoutMs, 120000),
    resumeGateTimeoutMs: num('EXECUTOR_RESUME_TIMEOUT', file.executor && file.executor.resumeGateTimeoutMs, 30000)
  }
}
