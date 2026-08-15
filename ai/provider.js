async function chatCompletion ({ baseUrl, apiKey, model, messages, tools, temperature, maxTokens }) {
  const url = String(baseUrl).replace(/\/+$/, '') + '/chat/completions'
  const body = { model, messages, temperature, max_tokens: maxTokens }
  if (tools && tools.length) body.tools = tools
  const headers = { 'Content-Type': 'application/json' }
  if (apiKey) headers.Authorization = 'Bearer ' + apiKey

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body)
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`AI API ${res.status}: ${text.slice(0, 400)}`)
  return JSON.parse(text)
}

async function listModels ({ baseUrl, apiKey }) {
  const url = String(baseUrl).replace(/\/+$/, '') + '/models'
  const headers = {}
  if (apiKey) headers.Authorization = 'Bearer ' + apiKey

  const res = await fetch(url, { method: 'GET', headers })
  const text = await res.text()
  if (!res.ok) throw new Error(`AI API ${res.status}: ${text.slice(0, 400)}`)
  const data = JSON.parse(text)
  if (Array.isArray(data)) return data.map(m => (typeof m === 'string' ? m : m.id)).filter(Boolean)
  if (Array.isArray(data.data)) return data.data.map(m => (typeof m === 'string' ? m : m.id)).filter(Boolean)
  return []
}

function parseActions (data) {
  const message = data && data.choices && data.choices[0] && data.choices[0].message
  if (!message) return []
  const actions = []

  if (Array.isArray(message.tool_calls)) {
    for (const tc of message.tool_calls) {
      let args = {}
      try { args = JSON.parse(tc.function && tc.function.arguments || '{}') } catch {}
      actions.push({ type: 'tool', name: tc.function && tc.function.name, args, id: tc.id })
    }
  }

  const content = message.content
  if (typeof content === 'string' && content.trim()) {
    const t = content.trim()
    if (t.startsWith('[')) {
      try {
        const arr = JSON.parse(t)
        if (Array.isArray(arr)) {
          for (const item of arr) {
            if (item && item.name) actions.push({ type: 'tool', name: item.name, args: item.args || {} })
            else if (item && item.message) actions.push({ type: 'chat', message: item.message })
          }
        }
      } catch {}
    } else {
      actions.push({ type: 'chat', message: t })
    }
  }

  return actions
}

module.exports = { chatCompletion, listModels, parseActions }
