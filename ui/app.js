const $ = (id) => document.getElementById(id)

let ws = null
let currentConfig = null

const seenChatKeys = new Set()
const seenEventKeys = new Set()

const SECTION_LABELS = {
  mc: 'Minecraft 连接',
  ai: 'AI 模型',
  api: '控制面板',
  logging: '日志',
  reactive: '生存 / 战斗',
  executor: '执行器'
}

const FIELD_LABELS = {
  'mc.host': '服务器地址',
  'mc.port': '端口',
  'mc.username': '机器人用户名',
  'mc.ownerName': '主人游戏名（多个用英文逗号分隔；留空则关闭听主人聊天指令）',
  'mc.password': '离线/微软密码（可选）',
  'mc.auth': '认证模式',
  'mc.version': '版本（留空自动）',
  'mc.reconnect': '自动重连',
  'mc.reconnectBaseDelayMs': '重连基础延迟(ms)',
  'mc.reconnectMaxDelayMs': '重连最大延迟(ms)',
  'mc.reconnectMaxAttempts': '最大重连次数(-1 无限)',
  'mc.connectTimeoutMs': '连接握手超时(ms)',
  'mc.reconnectAfterEmergencyLogout': '紧急下线后重连',
  'mc.pluginPassword': '插件服登录密码',
  'mc.pluginLoginCommands': '登录指令（例如 /login {password}，多个用 | 分隔）',
  'mc.pluginRegisterCommands': '首次注册指令（例如 /register {password} {password}，多个用 | 分隔）',
  'mc.pluginAuthDelayMs': '认证延迟(ms)',
  'mc.aiCommands': '\u4E3B\u4EBA\u6307\u4EE4\u4EA4\u7ED9 AI \u51B3\u7B56\uFF08\u4E0D\u786C\u7F16\u7801\u780D\u6811/\u8DDF\u968F\u7B49\uFF09',
  'mc.commandPrefix': 'AI 自由任务前缀（默认 !；跟随/挖矿等明确命令无需前缀）',
  'ai.enabled': '启用 AI',
  'ai.baseUrl': 'API 地址',
  'ai.apiKey': 'API Key',
  'ai.model': '模型',
  'ai.temperature': '温度',
  'ai.maxTokens': '最大 Token',
  'ai.intervalMs': '决策间隔(ms)',
  'ai.planAhead': '规划前推',
  'ai.memoryFile': '长期记忆文件路径（留空自动 logs/brain-memory.json）',
  'ai.memoryMaxMessages': '长期记忆保留消息数',
  'ai.memoryMaxChars': '长期记忆保留字符数',
  'api.host': '监听地址',
  'api.port': '面板端口',
  'logging.file': '写日志文件',
  'logging.dir': '日志目录',
  'logging.name': '日志文件名',
  'reactive.lowHealthFleeThreshold': '低血逃跑阈值',
  'reactive.criticalHealthLogoutThreshold': '极低血下线阈值',
  'reactive.hostileScanRadius': '敌对扫描半径',
  'reactive.hostileExitRadius': '脱离敌对半径',
  'reactive.hostileExitDebounceMs': '敌对脱战延迟(ms)',
  'reactive.engageOverFlee': '优先迎战而非逃跑',
  'reactive.requireShieldToEngage': '必须有盾才迎战',
  'reactive.maxMeleeEngageThreatCount': '近战迎击最大敌人数量',
  'reactive.minArmorScoreToEngage': '迎战最低护甲分',
  'reactive.fleeRange': '逃跑目标距离',
  'reactive.fleeMinThreatDistance': '逃跑最小威胁距离',
  'reactive.fleeMinPathLength': '逃跑最小路径长度',
  'reactive.fleeEscapeTestDistance': '逃生验证距离',
  'reactive.fleeCloseRepathDistance': '近距离重规划距离',
  'reactive.fleeCloseRepathMs': '近距离重规划间隔(ms)',
  'reactive.fleeReplanThresholdBlocks': '重规划距离阈值(格)',
  'reactive.maxInterruptionsPerTarget': '每个目标最大打断次数',
  'reactive.resumeDebounceMs': '恢复任务间隔(ms)',
  'reactive.autoEatStartAt': '自动进食饥饿阈值',
  'reactive.reactiveConsumablesEnabled': '自动使用消耗品',
  'reactive.meleeStrafeEnabled': '近战走位',
  'reactive.meleeStrafeIntervalMs': '近战走位间隔(ms)',
  'reactive.meleeAttackRange': '近战攻击距离',
  'reactive.meleeAttackIntervalMs': '近战攻击间隔(ms)',
  'reactive.defendWhenAttackedWindowMs': '受击防守窗口(ms)',
  'reactive.defensiveAttackRange': '防守反击距离',
  'executor.skillTimeoutMs': '技能超时(ms)',
  'executor.resumeGateTimeoutMs': '恢复闸门超时(ms)'
}

function getPath (obj, path) {
  return path.split('.').reduce((cur, key) => (cur == null ? cur : cur[key]), obj)
}

function setPath (obj, path, value) {
  const keys = path.split('.')
  const last = keys.pop()
  const target = keys.reduce((cur, key) => {
    if (cur[key] == null || typeof cur[key] !== 'object') cur[key] = {}
    return cur[key]
  }, obj)
  target[last] = value
}

function isSecret (path) {
  return path === 'ai.apiKey' || path === 'mc.password' || path === 'mc.pluginPassword'
}

async function fetchModels (event) {
  const baseInput = document.querySelector('#configForm input[data-path="ai.baseUrl"]')
  const keyInput = document.querySelector('#configForm input[data-path="ai.apiKey"]')
  const baseUrl = baseInput ? baseInput.value.trim() : ''
  const apiKey = keyInput ? keyInput.value.trim() : ''
  const btn = event && event.currentTarget ? event.currentTarget : null
  if (!baseUrl) {
    $('configMsg').textContent = '\u8bf7\u5148\u586b\u5199 API \u5730\u5740'
    $('configMsg').className = 'err'
    return
  }
  if (btn) { btn.disabled = true; btn._oldText = btn.textContent; btn.textContent = '\u83b7\u53d6\u4e2d...' }
  try {
    const data = await api('/models', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseUrl, apiKey })
    })
    const models = Array.isArray(data.models) ? data.models : []
    const dl = document.getElementById('modelList')
    if (dl) {
      dl.innerHTML = ''
      for (const m of models) {
        const opt = document.createElement('option')
        opt.value = m
        dl.appendChild(opt)
      }
    }
    $('configMsg').textContent = models.length
      ? '\u83b7\u53d6\u5230 ' + models.length + '\u4e2a\u6a21\u578b\uff0c\u53ef\u5728\u6a21\u578b\u8f93\u5165\u6846\u4e2d\u9009\u62e9\uff1a' + models.slice(0, 8).join(', ') + (models.length > 8 ? '...' : '')
      : '\u6ca1\u6709\u83b7\u53d6\u5230\u6a21\u578b'
    $('configMsg').className = 'muted'
  } catch (e) {
    $('configMsg').textContent = '\u83b7\u53d6\u6a21\u578b\u5931\u8d25: ' + e.message
    $('configMsg').className = 'err'
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = btn._oldText || '\u83b7\u53d6\u6a21\u578b' }
  }
}

function renderConfig (config) {
  const form = $('configForm')
  form.innerHTML = ''
  const order = ['mc', 'ai', 'api', 'logging', 'reactive', 'executor']

  for (const section of order) {
    const sectionObj = config[section] || {}
    const h3 = document.createElement('h3')
    h3.textContent = SECTION_LABELS[section] || section
    form.appendChild(h3)

    const grid = document.createElement('div')
    grid.className = 'config-grid'
    form.appendChild(grid)

    for (const [key, value] of Object.entries(sectionObj)) {
      if (value !== null && typeof value === 'object') continue
      const path = `${section}.${key}`
      const label = document.createElement('label')
      label.className = 'field'
      const text = document.createElement('span')
      text.textContent = FIELD_LABELS[path] || key

      if (path === 'ai.model') {
        const wrap = document.createElement('div')
        wrap.className = 'field model-field'
        wrap.appendChild(text)
        const row = document.createElement('div')
        row.className = 'model-row'
        const input = document.createElement('input')
        input.type = 'text'
        input.value = value ?? ''
        input.dataset.path = path
        input.dataset.type = typeof value
        input.setAttribute('list', 'modelList')
        row.appendChild(input)
        const btn = document.createElement('button')
        btn.type = 'button'
        btn.className = 'ghost'
        btn.textContent = '\u83b7\u53d6\u6a21\u578b'
        btn.onclick = fetchModels
        row.appendChild(btn)
        const dl = document.createElement('datalist')
        dl.id = 'modelList'
        wrap.appendChild(row)
        wrap.appendChild(dl)
        grid.appendChild(wrap)
        continue
      }

      label.appendChild(text)

      let input
      if (typeof value === 'boolean') {
        input = document.createElement('input')
        input.type = 'checkbox'
        input.checked = !!value
      } else if (typeof value === 'number') {
        input = document.createElement('input')
        input.type = 'number'
        input.step = 'any'
        input.value = value
      } else if (isSecret(path)) {
        input = document.createElement('input')
        input.type = 'password'
        input.value = ''
        input.placeholder = value ? '已配置（留空保持不变）' : '未配置'
        input.autocomplete = 'new-password'
      } else {
        input = document.createElement('input')
        input.type = 'text'
        input.value = value ?? ''
        if (path === 'mc.pluginLoginCommands') input.placeholder = '/login {password}'
        if (path === 'mc.pluginRegisterCommands') input.placeholder = '/register {password} {password}'
      }

      input.dataset.path = path
      input.dataset.type = typeof value
      label.appendChild(input)
      grid.appendChild(label)
    }
  }
}

function collectConfig () {
  if (!currentConfig) return {}
  const next = JSON.parse(JSON.stringify(currentConfig))
  const inputs = Array.from(document.querySelectorAll('#configForm input[data-path]'))
  for (const input of inputs) {
    const path = input.dataset.path
    const type = input.dataset.type
    let value
    if (type === 'boolean') value = input.checked
    else if (type === 'number') {
      if (input.value.trim() === '') continue
      const n = Number(input.value)
      if (!Number.isFinite(n)) continue
      value = n
    } else {
      value = input.value
      if (isSecret(path) && value === '' && getPath(next, path)) continue
    }
    setPath(next, path, value)
  }
  return next
}

async function loadConfig () {
  try {
    currentConfig = await api('/config')
    renderConfig(currentConfig)
    $('configMsg').textContent = ''
    $('configMsg').className = 'muted'
  } catch (e) {
    $('configMsg').textContent = '加载配置失败: ' + e.message
    $('configMsg').className = 'err'
  }
}

async function saveConfig () {
  const btn = $('saveConfig')
  btn.disabled = true
  try {
    const payload = collectConfig()
    const data = await api('/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
    currentConfig = data.config || payload
    renderConfig(currentConfig)
    $('configMsg').textContent = '已保存。修改服务器/AI/插件服配置后，请关闭窗口重新打开以重新连接'
    $('configMsg').className = 'muted'
  } catch (e) {
    $('configMsg').textContent = '保存失败: ' + e.message
    $('configMsg').className = 'err'
  } finally {
    btn.disabled = false
  }
}

function connectWs () {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  ws = new WebSocket(`${proto}://${location.host}/ws`)
  ws.onmessage = (e) => {
    try { handle(JSON.parse(e.data)) } catch {}
  }
  ws.onclose = () => setTimeout(connectWs, 2000)
}

function handle (msg) {
  if (msg.type === 'status') renderStatus(msg.data)
  else if (msg.type === 'chat') addChat(msg.data)
  else if (msg.type === 'observation') renderObs(msg.data)
  else if (msg.type === 'log') addEvent('log', msg.data)
  else if (msg.type === 'aiResult') addEvent('ai', msg.data)
}

function renderStatus (s) {
  const dot = $('dot')
  dot.className = 'dot ' + (s.connected ? 'on' : 'off')
  $('statusText').textContent = [
    `状态: ${s.connected ? '已连接' : '未连接'}${s.reason ? ' (' + s.reason + ')' : ''}`,
    `AI: ${s.aiRunning ? '运行中' : '已停止'}${s.aiEnabled ? '' : ' (未配置 API Key)'}`,
    `目标: ${s.goal || '-'}`,
    s.lastError ? `错误: ${s.lastError}` : ''
  ].filter(Boolean).join('\n')

  if (s.bot) {
    $('botInfo').textContent = [
      `名字: ${s.bot.username}`,
      `血量: ${s.bot.health}  饥饿: ${s.bot.food}`,
      `坐标: ${fmtVec(s.bot.position)}`,
      `维度: ${s.bot.dimension || '-'}  模式: ${s.bot.gamemode || '-'}`
    ].join('\n')
  } else {
    $('botInfo').textContent = '未生成'
  }

  $('aiInfo').textContent = [
    s.ownerName ? `主人: ${s.ownerName}` : `主人: 未设置（游戏聊天不会听指令）`,
    `已启用: ${s.aiEnabled ? '是' : '否'}`,
    `目标: ${s.goal || '-'}`,
    s.lastError ? `最近错误: ${s.lastError}` : ''
  ].filter(Boolean).join('\n')
}

function fmtVec (v) {
  if (!v) return '-'
  return `${v.x}, ${v.y}, ${v.z}`
}

function addChat (item) {
  appendLog('chat', item)
}
function addEvent (kind, item) {
  appendLog('event', item)
}

async function loadLogs () {
  try {
    const data = await api('/logs?limit=200')
    const el = $('events')
    el.innerHTML = ''
    seenEventKeys.clear()
    for (const item of data.logs) appendLog('event', item)
    $('logPath').textContent = data.path ? `日志文件: ${data.path}` : '日志文件未启用'
  } catch (e) {
    $('logPath').textContent = '日志加载失败: ' + e.message
  }
}

function appendLog (target, item) {
  const el = target === 'chat' ? $('chat') : $('events')
  const key = target === 'chat'
    ? [item.username, item.message, item.time].map(String).join('|')
    : [item.level, item.message, item.time, item.action, item.result, item.error].map(v => String(v ?? '')).join('|')
  const seen = target === 'chat' ? seenChatKeys : seenEventKeys
  if (seen.has(key)) return
  seen.add(key)
  const row = document.createElement('div')
  const time = new Date(item.time || Date.now()).toLocaleTimeString()
  if (target === 'chat') {
    row.innerHTML = `<span class="time">${time}</span><span class="name">${esc(item.username)}</span> ${esc(item.message)}`
  } else if (item.level === 'warn' || item.level === 'error') {
    row.innerHTML = `<span class="time">${time}</span><span class="${item.level === 'error' ? 'err' : 'warn'}">${esc(item.message || item.error || '')}</span>`
  } else if (item.action) {
    row.innerHTML = `<span class="time">${time}</span>${esc(item.action)}: ${esc(item.result || item.error || '')}`
  } else {
    row.innerHTML = `<span class="time">${time}</span>${esc(item.message || '')}`
  }
  el.appendChild(row)
  while (el.children.length > 200) el.removeChild(el.firstChild)
  el.scrollTop = el.scrollHeight
}

function renderObs (data) {
  $('obs').textContent = JSON.stringify(data, null, 2)
}

function esc (s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]))
}

async function api (path, options) {
  const res = await fetch('/api' + path, options)
  const data = await res.json()
  if (!res.ok) throw new Error(data.error || res.status)
  return data
}

$('startAi').onclick = async () => { await api('/ai/start', { method: 'POST' }) }
$('stopAi').onclick = async () => { await api('/ai/stop', { method: 'POST' }) }
$('applyGoal').onclick = async () => {
  await api('/ai/goal', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ goal: $('goal').value }) })
}
$('connectBot').onclick = async () => {
  try {
    const data = await api('/bot/connect', { method: 'POST' })
    if (data.status) renderStatus(data.status)
    $('actionResult').textContent = '\u5df2\u6267\u884c'
  } catch (e) {
    $('actionResult').textContent = '\u8fdb\u5165\u670d\u52a1\u5668\u5931\u8d25: ' + e.message
  }
}
$('disconnectBot').onclick = async () => {
  try {
    const data = await api('/bot/disconnect', { method: 'POST' })
    if (data.status) renderStatus(data.status)
    $('actionResult').textContent = '\u5df2\u6267\u884c'
  } catch (e) {
    $('actionResult').textContent = '\u9000\u51fa\u670d\u52a1\u5668\u5931\u8d25: ' + e.message
  }
}

$('sendAction').onclick = async () => {
  let args = {}
  try { args = $('actionArgs').value.trim() ? JSON.parse($('actionArgs').value) : {} } catch {
    $('actionResult').textContent = '参数 JSON 格式错误'
    return
  }
  try {
    const data = await api('/actions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: $('actionName').value.trim(), args }) })
    $('actionResult').textContent = '成功: ' + JSON.stringify(data.result)
  } catch (e) {
    $('actionResult').textContent = '失败: ' + e.message
  }
}

$('saveConfig').onclick = saveConfig
$('reloadConfig').onclick = loadConfig
$('reloadLogs').onclick = loadLogs

;(async function init () {
  connectWs()
  loadConfig()
  loadLogs()
  try {
    renderStatus(await api('/status'))
    renderObs(await api('/observations'))
  } catch (e) {
    $('statusText').textContent = '无法连接后端: ' + e.message
  }
})()
