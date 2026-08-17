const fs = require('fs')
const path = require('path')
const dotenv = require('dotenv')

const IS_PACKAGED = !!process.pkg || (() => {
  try { return require('node:sea').isSea() } catch { return false }
})()
const BUNDLED_ROOT = path.join(__dirname, '..')
const EXTERNAL_ROOT = IS_PACKAGED ? path.dirname(process.execPath) : BUNDLED_ROOT

dotenv.config({
  quiet: true,
  path: IS_PACKAGED ? path.join(EXTERNAL_ROOT, '.env') : path.join(BUNDLED_ROOT, '.env')
})

function readJson (file) {
  try {
    const raw = fs.readFileSync(path.join(EXTERNAL_ROOT, file), 'utf8').replace(/^\uFEFF/, '')
    return JSON.parse(raw)
  } catch {
    return {}
  }
}

function readBundledJson (file) {
  try {
    const raw = fs.readFileSync(path.join(BUNDLED_ROOT, file), 'utf8').replace(/^\uFEFF/, '')
    return JSON.parse(raw)
  } catch {
    return {}
  }
}

function ensureExternalFiles () {
  if (!IS_PACKAGED) return
  const target = path.join(EXTERNAL_ROOT, 'config.json')
  if (fs.existsSync(target)) return
  try {
    const source = path.join(BUNDLED_ROOT, 'config.example.json')
    if (fs.existsSync(source)) fs.copyFileSync(source, target)
  } catch {}
}

ensureExternalFiles()
const file = readJson('config.json')

function isPlainObject (value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function deepMerge (base, over) {
  if (Array.isArray(base) && Array.isArray(over)) return over
  if (isPlainObject(base) && isPlainObject(over)) {
    const out = { ...base }
    for (const key of Object.keys(over)) {
      const value = over[key]
      if (value === undefined) continue
      out[key] = deepMerge(base[key], value)
    }
    return out
  }
  return over === undefined ? base : over
}

const defaultFile = readBundledJson('config.example.json')
let editableConfig = deepMerge(defaultFile || {}, file || {})

// Never show the example placeholder as a real configured key.
if (editableConfig.ai && (editableConfig.ai.apiKey === 'sk-xxx' || !file.ai || !Object.prototype.hasOwnProperty.call(file.ai, 'apiKey'))) {
  editableConfig.ai.apiKey = ''
}

function getConfig () {
  return editableConfig
}

function saveConfig (patch) {
  const next = deepMerge(editableConfig, patch || {})
  if (next.ai && next.ai.apiKey === 'sk-xxx') next.ai.apiKey = ''
  const target = path.join(EXTERNAL_ROOT, 'config.json')
  fs.writeFileSync(target, JSON.stringify(next, null, 2) + '\n', 'utf8')
  editableConfig = next
  return next
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

function resolveUiDir () {
  const external = path.join(EXTERNAL_ROOT, 'ui')
  if (IS_PACKAGED && fs.existsSync(path.join(external, 'index.html'))) return external
  return path.join(BUNDLED_ROOT, 'ui')
}

module.exports = {
  root: EXTERNAL_ROOT,
  bundledRoot: BUNDLED_ROOT,
  uiDir: resolveUiDir(),
  configPath: path.join(EXTERNAL_ROOT, 'config.json'),
  getConfig,
  saveConfig,
  mc: {
    host: str('MC_HOST', file.mc && file.mc.host, 'localhost'),
    port: num('MC_PORT', file.mc && file.mc.port, 25565),
    username: str('MC_USERNAME', file.mc && file.mc.username, 'MyBot'),
    ownerName: str('MC_OWNER_NAME', file.mc && file.mc.ownerName, ''),
    password: str('MC_PASSWORD', file.mc && file.mc.password, ''),
    auth: str('MC_AUTH', file.mc && file.mc.auth, 'offline'),
    version: str('MC_VERSION', file.mc && file.mc.version, undefined),
    pluginPassword: str('MC_PLUGIN_PASSWORD', file.mc && file.mc.pluginPassword, ''),
    pluginLoginCommands: str('MC_PLUGIN_LOGIN_COMMANDS', file.mc && file.mc.pluginLoginCommands, '/login {password}'),
    pluginRegisterCommands: str('MC_PLUGIN_REGISTER_COMMANDS', file.mc && file.mc.pluginRegisterCommands, ''),
    pluginAuthDelayMs: num('MC_PLUGIN_AUTH_DELAY_MS', file.mc && file.mc.pluginAuthDelayMs, 1500),
    commandPrefix: str('MC_COMMAND_PREFIX', file.mc && file.mc.commandPrefix, '!'),
    reconnect: bool('MC_RECONNECT', file.mc && file.mc.reconnect, true),
    reconnectBaseDelayMs: num('MC_RECONNECT_BASE_DELAY_MS', file.mc && file.mc.reconnectBaseDelayMs, 2000),
    reconnectMaxDelayMs: num('MC_RECONNECT_MAX_DELAY_MS', file.mc && file.mc.reconnectMaxDelayMs, 15000),
    reconnectMaxAttempts: num('MC_RECONNECT_MAX_ATTEMPTS', file.mc && file.mc.reconnectMaxAttempts, -1),
    connectTimeoutMs: num('MC_CONNECT_TIMEOUT_MS', file.mc && file.mc.connectTimeoutMs, 20000),
    reconnectAfterEmergencyLogout: bool('MC_RECONNECT_AFTER_EMERGENCY', file.mc && file.mc.reconnectAfterEmergencyLogout, false)
  },
  ai: {
    enabled: bool('AI_ENABLED', file.ai && file.ai.enabled, true),
    baseUrl: str('AI_BASE_URL', file.ai && file.ai.baseUrl, 'https://api.openai.com/v1'),
    apiKey: str('AI_API_KEY', file.ai && file.ai.apiKey === 'sk-xxx' ? '' : (file.ai && file.ai.apiKey), ''),
    model: str('AI_MODEL', file.ai && file.ai.model, 'gpt-4o-mini'),
    temperature: num('AI_TEMPERATURE', file.ai && file.ai.temperature, 0.2),
    maxTokens: num('AI_MAX_TOKENS', file.ai && file.ai.maxTokens, 1200),
    intervalMs: num('AI_INTERVAL_MS', file.ai && file.ai.intervalMs, 4000),
    planAhead: bool('AI_PLAN_AHEAD', file.ai && file.ai.planAhead, true),
    memoryFile: str('AI_MEMORY_FILE', file.ai && file.ai.memoryFile, ''),
    memoryMaxMessages: num('AI_MEMORY_MAX_MESSAGES', file.ai && file.ai.memoryMaxMessages, 40),
    memoryMaxChars: num('AI_MEMORY_MAX_CHARS', file.ai && file.ai.memoryMaxChars, 32000)
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
    fleeCloseRepathDistance: num('REACTIVE_FLEE_CLOSE_REPATH_DISTANCE', file.reactive && file.reactive.fleeCloseRepathDistance, 3),
    fleeCloseRepathMs: num('REACTIVE_FLEE_CLOSE_REPATH_MS', file.reactive && file.reactive.fleeCloseRepathMs, 500),
    fleeReplanThresholdBlocks: num('REACTIVE_FLEE_REPLAN_THRESHOLD', file.reactive && file.reactive.fleeReplanThresholdBlocks, 4),
    maxInterruptionsPerTarget: num('REACTIVE_MAX_INTERRUPTIONS', file.reactive && file.reactive.maxInterruptionsPerTarget, 3),
    resumeDebounceMs: num('REACTIVE_RESUME_DEBOUNCE', file.reactive && file.reactive.resumeDebounceMs, 1000),
    autoEatStartAt: num('REACTIVE_AUTO_EAT_START', file.reactive && file.reactive.autoEatStartAt, 18),
    reactiveConsumablesEnabled: bool('REACTIVE_CONSUMABLES', file.reactive && file.reactive.reactiveConsumablesEnabled, true),
    meleeStrafeEnabled: bool('REACTIVE_MELEE_STRAFE_ENABLED', file.reactive && file.reactive.meleeStrafeEnabled, true),
    meleeStrafeIntervalMs: num('REACTIVE_MELEE_STRAFE_INTERVAL_MS', file.reactive && file.reactive.meleeStrafeIntervalMs, 900),
    meleeAttackRange: num('REACTIVE_MELEE_ATTACK_RANGE', file.reactive && file.reactive.meleeAttackRange, 3.5),
    meleeAttackIntervalMs: num('REACTIVE_MELEE_ATTACK_INTERVAL_MS', file.reactive && file.reactive.meleeAttackIntervalMs, 500),
    defendWhenAttackedWindowMs: num('REACTIVE_DEFEND_WHEN_ATTACKED_WINDOW_MS', file.reactive && file.reactive.defendWhenAttackedWindowMs, 2000),
    defensiveAttackRange: num('REACTIVE_DEFENSIVE_ATTACK_RANGE', file.reactive && file.reactive.defensiveAttackRange, 4)
  },
  logging: {
    file: bool('LOG_FILE', file.logging && file.logging.file, true),
    dir: str('LOG_DIR', file.logging && file.logging.dir, 'logs'),
    name: str('LOG_NAME', file.logging && file.logging.name, 'agent.log')
  },
  executor: {
    skillTimeoutMs: num('EXECUTOR_SKILL_TIMEOUT', file.executor && file.executor.skillTimeoutMs, 120000),
    resumeGateTimeoutMs: num('EXECUTOR_RESUME_TIMEOUT', file.executor && file.executor.resumeGateTimeoutMs, 30000)
  }
}