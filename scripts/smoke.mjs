/**
 * Standalone smoke test for the Antigravity auth + streaming path.
 *
 *   node scripts/smoke.mjs [model]
 *
 * It touches only src/auth.js and the network, so it runs outside DSH and
 * proves that no Google Cloud Console OAuth client is needed.
 */
import { AntigravityCredentialStore } from '../src/auth.js'

const model = process.argv[2] || 'claude-sonnet-4-6'
const store = new AntigravityCredentialStore()

const status = await store.status()
console.log('status:', JSON.stringify(status))
if (status.state === 'signed-out') {
  console.error('No Antigravity session found. Sign in to the Antigravity app first.')
  process.exit(1)
}

const token = await store.getAccessToken()
const project = await store.getProjectId(token)
console.log('project:', project)

const response = await fetch(`https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse`, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
    'User-Agent': 'antigravity/1.104.0 darwin/arm64',
  },
  body: JSON.stringify({
    model,
    project,
    request: {
      contents: [{ role: 'user', parts: [{ text: 'Reply with exactly: ANTIGRAVITY OK' }] }],
      generationConfig: {},
    },
  }),
})
if (!response.ok) {
  console.error('request failed:', response.status, (await response.text()).slice(0, 400))
  process.exit(1)
}

let text = ''
let buffer = ''
const decoder = new TextDecoder()
for await (const chunk of response.body) {
  buffer += decoder.decode(chunk, { stream: true })
  const frames = buffer.split(/\r?\n\r?\n/)
  buffer = frames.pop() || ''
  for (const frame of frames) {
    const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n')
    if (!data || data === '[DONE]') continue
    try {
      const payload = JSON.parse(data)
      const parts = payload.response?.candidates?.[0]?.content?.parts || []
      for (const part of parts) if (typeof part.text === 'string') text += part.text
    } catch { /* ignore keep-alive frames */ }
  }
  if (text.length > 40) break
}
console.log(`${model}:`, JSON.stringify(text.trim()))
