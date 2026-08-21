const { TOOL_NAMES } = require('./tools')

// 单次请求（带超时）
async function chatCompletionOnce ({ baseUrl, apiKey, model, messages, tools, temperature, maxTokens }) {
  const url = String(baseUrl).replace(/\/+$/, '') + '/chat/completions'
  const body = { model, messages, temperature, max_tokens: maxTokens }
  if (tools && tools.length) body.tools = tools
  const headers = { 'Content-Type': 'application/json' }
  if (apiKey) headers.Authorization = 'Bearer ' + apiKey

  const controller = new AbortController()
  const timeoutMs = 90000
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  let res
  try {
    res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal })
  } catch (e) {
    clearTimeout(timer)
    throw new Error('AI API 请求超时或失败: ' + e.message)
  }
  clearTimeout(timer)
  const text = await res.text()
  if (process.env.DEBUG_AI) console.log('[AI_DEBUG]', res.status, text.slice(0, 600))
  if (!res.ok) throw new Error('AI API ' + res.status + ': ' + text.slice(0, 400))
  return JSON.parse(text)
}

// 串行队列：matchfit 账户有并发上限，串行化所有 AI 请求，避免并发 429。
let chain = Promise.resolve()
function serialize (fn) {
  const run = chain.then(fn, fn)
  chain = run.then(() => {}, () => {})
  return run
}

async function chatCompletion (opts) {
  return serialize(async () => {
    let lastErr
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await chatCompletionOnce(opts)
      } catch (e) {
        lastErr = e
        const msg = String(e && e.message ? e.message : '')
        if (!/\b429\b/.test(msg) || attempt >= 2) break
        await new Promise(r => setTimeout(r, 2000 * (attempt + 1)))
      }
    }
    const fb = opts.fallback
    if (fb && fb.baseUrl && String(fb.baseUrl).replace(/\/+$/, '') !== String(opts.baseUrl || '').replace(/\/+$/, '')) {
      if (process.env.DEBUG_AI) console.log('[AI_FALLBACK]', (lastErr && lastErr.message) || '', '→ 切换到备用 API')
      return await chatCompletionOnce({
        baseUrl: fb.baseUrl,
        apiKey: fb.apiKey,
        model: fb.model,
        messages: opts.messages,
        tools: opts.tools,
        temperature: opts.temperature,
        maxTokens: opts.maxTokens
      })
    }
    throw lastErr
  })
}

async function listModels ({ baseUrl, apiKey }) {
  const url = String(baseUrl).replace(/\/+$/, '') + '/models'
  const headers = {}
  if (apiKey) headers.Authorization = 'Bearer ' + apiKey
  const res = await fetch(url, { headers })
  const text = await res.text()
  if (!res.ok) throw new Error('API ' + res.status + ': ' + text.slice(0, 300))
  const data = JSON.parse(text)
  const list = data.data || data.models || data
  return Array.isArray(list) ? list.map(m => m.id || m.name || m.model).filter(Boolean) : []
}

function effectiveContent (message) {
  if (message && typeof message.content === 'string' && message.content.trim()) return message.content
  if (message && typeof message.reasoning_content === 'string' && message.reasoning_content.trim()) return message.reasoning_content
  if (message && typeof message.reasoning === 'string' && message.reasoning.trim()) return message.reasoning
  return ''
}

function stripFence (text) {
  let t = String(text || '').trim()
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fence) t = fence[1].trim()
  return t
}

function findBalanced (text, open, close) {
  const out = []
  const n = text.length
  let i = 0
  while (i < n) {
    if (text[i] !== open) { i++; continue }
    let depth = 0
    let inString = false
    let esc = false
    let j = i
    for (; j < n; j++) {
      const ch = text[j]
      if (inString) {
        if (esc) { esc = false }
        else if (ch === '\\') { esc = true }
        else if (ch === '"') { inString = false }
        continue
      }
      if (ch === '"') { inString = true; continue }
      if (ch === open) { depth++ }
      else if (ch === close) {
        depth--
        if (depth === 0) {
          out.push(text.slice(i, j + 1))
          i = j + 1
          break
        }
      }
    }
    if (j === n) { i = n }
  }
  return out
}

function pushTool (arr, obj) {
  if (!obj || typeof obj !== 'object') return
  if (obj.name) arr.push({ type: 'tool', name: obj.name, args: obj.args || {} })
  else if (obj.message) arr.push({ type: 'chat', message: obj.message })
}

function extractActions (text) {
  const t = stripFence(text)
  const actions = []
  for (const chunk of findBalanced(t, '[', ']')) {
    try {
      const arr = JSON.parse(chunk)
      if (Array.isArray(arr)) {
        for (const item of arr) pushTool(actions, item)
      }
    } catch (e) { /* ignore */ }
  }
  return actions
}

function extractSingleObjects (text) {
  const t = stripFence(text)
  const actions = []
  for (const chunk of findBalanced(t, '{', '}')) {
    try {
      const obj = JSON.parse(chunk)
      pushTool(actions, obj)
    } catch (e) { /* ignore */ }
  }
  return actions
}

function extractNamedObjects (text) {
  const t = stripFence(text)
  const out = []
  const re = /([A-Za-z_][A-Za-z0-9_]*)\s*:\s*\{/g
  let m
  while ((m = re.exec(t)) !== null) {
    const name = m[1]
    if (!TOOL_NAMES.has(name)) continue
    const start = m.index + m[0].length - 1
    const chunks = findBalanced(t.slice(start), '{', '}')
    if (!chunks.length) continue
    try {
      const args = JSON.parse(chunks[0])
      out.push({ type: 'tool', name, args: args && typeof args === 'object' ? args : {} })
      re.lastIndex = start + chunks[0].length
    } catch (e) { /* ignore */ }
  }
  return out
}

function parseActions (data) {
  const message = data && data.choices && data.choices[0] && data.choices[0].message
  if (!message) return []
  const actions = []
  const hasToolCalls = Array.isArray(message.tool_calls) && message.tool_calls.length > 0

  if (hasToolCalls) {
    for (const tc of message.tool_calls) {
      let args = {}
      try { args = JSON.parse(tc.function && tc.function.arguments || '{}') } catch {}
      actions.push({ type: 'tool', name: tc.function && tc.function.name, args, id: tc.id })
    }
  }

  const content = (typeof message.content === 'string' && message.content.trim())
    ? message.content
    : (hasToolCalls ? '' : effectiveContent(message))
  if (content) {
    const cleaned = stripFence(content)
    let direct = null
    try { direct = JSON.parse(cleaned) } catch (e) {}

    if (direct && (Array.isArray(direct) || typeof direct === 'object')) {
      const list = Array.isArray(direct)
        ? direct
        : (Array.isArray(direct.actions) ? direct.actions : [direct])
      for (const item of list) pushTool(actions, item)
    } else {
      const fromNamed = extractNamedObjects(content)
      if (fromNamed.length) {
        actions.push(...fromNamed)
      } else {
        const fromArrays = extractActions(content)
        if (fromArrays.length) {
          actions.push(...fromArrays)
        } else {
          const fromObjects = extractSingleObjects(content)
          if (fromObjects.length) {
            actions.push(...fromObjects)
          } else {
            actions.push({ type: 'chat', message: content.trim() })
          }
        }
      }
    }
  }

  return actions
}

module.exports = { chatCompletion, parseActions, listModels }
