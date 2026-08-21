// 单次请求（带超时）
async function chatCompletionOnce ({ baseUrl, apiKey, model, messages, tools, temperature, maxTokens }) {
  const url = String(baseUrl).replace(/\/+$/, '') + '/chat/completions'
  const body = { model, messages, temperature, max_tokens: maxTokens }
  if (tools && tools.length) body.tools = tools
  const headers = { 'Content-Type': 'application/json' }
  if (apiKey) headers.Authorization = 'Bearer ' + apiKey

  // 请求超时（防止 AI API 响应慢导致 tick 卡死）
  const controller = new AbortController()
  const timeoutMs = 90000
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  let res
  try {
    res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal
    })
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

// 主 API + 备用降级：主失败（网络/5xx/429）时自动重试，再尝试备用
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

// 从文本中提取所有 JSON 数组元素（兼容 markdown 代码块、多数组、纯文本混排）
function extractActions (text) {
  if (!text) return []
  let t = String(text).trim()
  // 去掉 markdown 代码块包裹
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fence) t = fence[1].trim()

  const actions = []
  // 用正则匹配所有独立的 JSON 数组 [ ... ]（非贪婪，允许嵌套对象）
  const arrayRe = /\[[\s\S]*?\]/g
  let m
  while ((m = arrayRe.exec(t)) !== null) {
    try {
      const arr = JSON.parse(m[0])
      if (Array.isArray(arr)) {
        for (const item of arr) {
          if (item && typeof item === 'object') {
            if (item.name) actions.push({ type: 'tool', name: item.name, args: item.args || {} })
            else if (item.message) actions.push({ type: 'chat', message: item.message })
          }
        }
      }
    } catch (e) { /* 忽略单个数组解析失败 */ }
  }
  return actions
}

// 从文本中提取单个 JSON 对象 {name, args}（兼容多对象）
function extractSingleObjects (text) {
  if (!text) return []
  const actions = []
  const objRe = /\{[\s\S]*?\}/g
  let m
  while ((m = objRe.exec(text)) !== null) {
    try {
      const obj = JSON.parse(m[0])
      if (obj && obj.name) actions.push({ type: 'tool', name: obj.name, args: obj.args || {} })
      else if (obj && obj.message) actions.push({ type: 'chat', message: obj.message })
    } catch (e) {}
  }
  return actions
}

function parseActions (data) {
  const message = data && data.choices && data.choices[0] && data.choices[0].message
  if (!message) return []
  const actions = []

  // 1. 标准 function calling
  if (Array.isArray(message.tool_calls)) {
    for (const tc of message.tool_calls) {
      let args = {}
      try { args = JSON.parse(tc.function && tc.function.arguments || '{}') } catch {}
      actions.push({ type: 'tool', name: tc.function && tc.function.name, args, id: tc.id })
    }
  }

  // 2. 文本内容解析（JSON 数组 / 对象 / 聊天）
  const content = message.content
  if (typeof content === 'string' && content.trim()) {
    const fromArrays = extractActions(content)
    if (fromArrays.length) {
      actions.push(...fromArrays)
    } else {
      const fromObjects = extractSingleObjects(content)
      if (fromObjects.length) {
        actions.push(...fromObjects)
      } else if (content.trim().startsWith('{') === false) {
        // 非 JSON 文本 → 视为聊天
        actions.push({ type: 'chat', message: content.trim() })
      }
    }
  }

  return actions
}

module.exports = { chatCompletion, parseActions }