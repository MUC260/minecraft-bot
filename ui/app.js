const $ = (id) => document.getElementById(id)

let ws = null

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
    `运行: ${s.aiRunning ? '是' : '否'}`,
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

function appendLog (target, item) {
  const el = target === 'chat' ? $('chat') : $('events')
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

;(async function init () {
  connectWs()
  try {
    renderStatus(await api('/status'))
    renderObs(await api('/observations'))
  } catch (e) {
    $('statusText').textContent = '无法连接后端: ' + e.message
  }
})()
