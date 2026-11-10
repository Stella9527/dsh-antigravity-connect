/**
 * Models exposed by the Antigravity Cloud Code Assist service.
 *
 * The catalog mirrors what the installed Antigravity app reports from
 * `v1internal:fetchAvailableModels`; ids are the request ids that service
 * accepts. Pricing is zero because the subscription owns the quota.
 */

const API = 'google-generative-ai'
const BASE_URL = 'https://daily-cloudcode-pa.googleapis.com/v1internal'

function model(id, name, { contextWindow, maxTokens, input = ['text', 'image'], reasoning = true }) {
  return {
    id,
    name,
    api: API,
    provider: 'antigravity',
    baseUrl: BASE_URL,
    reasoning,
    input,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens,
  }
}

export const ANTIGRAVITY_MODELS = [
  model('gemini-3.8-flash-tiered', 'Gemini 3.8 Flash', { contextWindow: 1_048_576, maxTokens: 65_536 }),
  model('gemini-3.5-flash-lite', 'Gemini 3.5 Flash Lite', { contextWindow: 1_048_576, maxTokens: 65_535 }),
  model('gemini-3-flash', 'Gemini 3 Flash', { contextWindow: 1_048_576, maxTokens: 65_536 }),
  model('claude-sonnet-4-6', 'Claude Sonnet 4.6', { contextWindow: 250_000, maxTokens: 64_000 }),
  model('claude-opus-4-6-thinking', 'Claude Opus 4.6', { contextWindow: 250_000, maxTokens: 64_000 }),
  model('gpt-oss-120b-medium', 'GPT-OSS 120B', { contextWindow: 131_072, maxTokens: 32_768, input: ['text'] }),
]

export const ANTIGRAVITY_MODEL_IDS = new Set(ANTIGRAVITY_MODELS.map(entry => entry.id))
