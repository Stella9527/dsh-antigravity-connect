/**
 * Cloud Code Assist streaming for Antigravity.
 *
 * Derived from dsh-gemini-connect's cloud-code.js (Apache-2.0); see NOTICE.
 * The wire protocol is Gemini-style for every model Antigravity serves, which
 * is why Claude and GPT-OSS reuse the same payload and SSE parser.
 */
import { randomUUID } from 'node:crypto'
import { createAssistantMessageEventStream, getCurrentSystemPrompt, getCurrentTools } from '@earendil-works/pi-ai'
import {
  convertMessages,
  convertTools,
  isThinkingPart,
  mapStopReasonString,
  retainThoughtSignature,
} from '@earendil-works/pi-ai/api/google-shared'

const ENDPOINTS = [
  'https://daily-cloudcode-pa.googleapis.com',
  'https://daily-cloudcode-pa.sandbox.googleapis.com',
  'https://cloudcode-pa.googleapis.com',
]
const API_VERSION = 'v1internal'
let toolCallCounter = 0

function emptyUsage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  }
}

function textInstruction(text) {
  return text === undefined ? undefined : { role: 'system', parts: [{ text }] }
}

const DROPPED_SCHEMA_KEYS = new Set([
  '$schema', '$id', '$comment', '$defs', 'definitions', 'additionalProperties',
  'patternProperties', 'unevaluatedProperties', 'dependentRequired', 'dependentSchemas',
  'if', 'then', 'else', 'not', 'const', 'default', 'examples', 'title',
  'contentMediaType', 'contentEncoding', 'writeOnly', 'readOnly', 'deprecated',
])

/** Gemini rejects several JSON Schema keywords that zod emits by default. */
function sanitizeSchema(value) {
  if (Array.isArray(value)) return value.map(sanitizeSchema)
  if (!value || typeof value !== 'object') return value
  const result = {}
  for (const [key, entry] of Object.entries(value)) {
    if (DROPPED_SCHEMA_KEYS.has(key)) continue
    result[key] = sanitizeSchema(entry)
  }
  if (Array.isArray(result.required) && result.required.length === 0) delete result.required
  return result
}

function toolsFor(model, tools) {
  if (!Array.isArray(tools) || tools.length === 0) return undefined
  const converted = convertTools(tools)
  if (!model.id.startsWith('gemini')) return converted
  for (const declaration of converted?.functionDeclarations ?? []) {
    if (declaration.parameters !== undefined) declaration.parameters = sanitizeSchema(declaration.parameters)
  }
  return converted
}

function payloadFor(model, context, options, projectId) {
  const generationConfig = {}
  if (options?.temperature !== undefined) generationConfig.temperature = options.temperature
  if (options?.maxTokens !== undefined) generationConfig.maxOutputTokens = options.maxTokens
  if (options?.thinking && model.id.startsWith('gemini')) {
    generationConfig.thinkingConfig = {
      includeThoughts: options.thinking.enabled,
      ...(options.thinking.budgetTokens === undefined ? {} : { thinkingBudget: options.thinking.budgetTokens }),
      ...(options.thinking.level === undefined ? {} : { thinkingLevel: options.thinking.level }),
    }
  }
  const transcript = Array.isArray(context?.messages) ? context.messages : []
  const systemPrompt = context?.systemPrompt ?? getCurrentSystemPrompt(transcript)
  const tools = context?.tools ?? getCurrentTools(transcript)
  const contents = transcript.filter(message => message.role !== 'system')
  const request = {
    contents: convertMessages(model, { messages: contents }),
    systemInstruction: textInstruction(systemPrompt),
    tools: toolsFor(model, tools),
    generationConfig,
  }
  return {
    model: model.id,
    ...(projectId === undefined ? {} : { project: projectId }),
    user_prompt_id: randomUUID(),
    request,
  }
}

function finishOpenBlock(stream, output, current) {
  if (!current) return
  const index = output.content.length - 1
  if (current.type === 'text') {
    stream.push({ type: 'text_end', contentIndex: index, content: current.text, partial: output })
  } else {
    stream.push({ type: 'thinking_end', contentIndex: index, content: current.thinking, partial: output })
  }
}

function consumeResponse(stream, output, response, state) {
  const candidate = response?.candidates?.[0]
  if (response?.responseId) output.responseId ||= response.responseId
  if (candidate?.content?.parts) {
    for (const part of candidate.content.parts) {
      if (part.text !== undefined) {
        const thinking = isThinkingPart(part)
        if (!state.current || (thinking && state.current.type !== 'thinking') || (!thinking && state.current.type !== 'text')) {
          finishOpenBlock(stream, output, state.current)
          state.current = thinking ? { type: 'thinking', thinking: '' } : { type: 'text', text: '' }
          output.content.push(state.current)
          const index = output.content.length - 1
          stream.push({ type: thinking ? 'thinking_start' : 'text_start', contentIndex: index, partial: output })
        }
        const index = output.content.length - 1
        if (state.current.type === 'thinking') {
          state.current.thinking += part.text
          state.current.thinkingSignature = retainThoughtSignature(state.current.thinkingSignature, part.thoughtSignature)
          stream.push({ type: 'thinking_delta', contentIndex: index, delta: part.text, partial: output })
        } else {
          state.current.text += part.text
          state.current.textSignature = retainThoughtSignature(state.current.textSignature, part.thoughtSignature)
          stream.push({ type: 'text_delta', contentIndex: index, delta: part.text, partial: output })
        }
      }
      if (part.functionCall) {
        finishOpenBlock(stream, output, state.current)
        state.current = undefined
        const call = part.functionCall
        const id = call.id || `${call.name || 'tool'}_${Date.now()}_${++toolCallCounter}`
        const toolCall = {
          type: 'toolCall',
          id,
          name: call.name || '',
          arguments: call.args || {},
          ...(part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {}),
        }
        output.content.push(toolCall)
        const index = output.content.length - 1
        stream.push({ type: 'toolcall_start', contentIndex: index, partial: output })
        stream.push({ type: 'toolcall_delta', contentIndex: index, delta: JSON.stringify(toolCall.arguments), partial: output })
        stream.push({ type: 'toolcall_end', contentIndex: index, toolCall, partial: output })
      }
    }
  }
  if (candidate?.finishReason) {
    output.stopReason = mapStopReasonString(candidate.finishReason)
    if (output.content.some(block => block.type === 'toolCall')) output.stopReason = 'toolUse'
  }
  const usage = response?.usageMetadata
  if (usage) {
    output.usage.input = usage.promptTokenCount || 0
    output.usage.output = usage.candidatesTokenCount || 0
    output.usage.reasoning = usage.thoughtsTokenCount || undefined
    output.usage.totalTokens = usage.totalTokenCount || output.usage.input + output.usage.output
  }
}

async function* sseEvents(body) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const events = buffer.split(/\r?\n\r?\n/)
    buffer = events.pop() || ''
    for (const event of events) {
      const data = event.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n')
      if (!data || data === '[DONE]') continue
      try { yield JSON.parse(data) } catch { /* ignore malformed keep-alive frames */ }
    }
  }
  const data = buffer.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n')
  if (data && data !== '[DONE]') {
    try { yield JSON.parse(data) } catch { /* ignore truncated frame */ }
  }
}

export function antigravityStream(resolveProject) {
  return (model, context, options = {}) => {
    const stream = createAssistantMessageEventStream()
    const output = {
      role: 'assistant',
      content: [],
      api: 'google-generative-ai',
      provider: model.provider,
      model: model.id,
      usage: emptyUsage(),
      stopReason: 'stop',
      timestamp: Date.now(),
    }
    ;(async () => {
      stream.push({ type: 'start', partial: output })
      const token = options.apiKey
      if (!token) throw new Error('Antigravity access token is unavailable; sign in to Antigravity and retry')
      const projectId = await resolveProject(token, options.signal)
      const requestBody = JSON.stringify(payloadFor(model, context, options, projectId))
      const requestHeaders = {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        'User-Agent': 'antigravity/1.104.0 darwin/arm64',
      }
      let response
      let lastFailure
      for (const endpoint of ENDPOINTS) {
        response = await fetch(`${endpoint}/${API_VERSION}:streamGenerateContent?alt=sse`, {
          method: 'POST',
          headers: requestHeaders,
          body: requestBody,
          signal: options.signal,
        })
        if (response.ok) break
        const detail = await response.text().catch(() => '')
        let message = ''
        try { message = JSON.parse(detail)?.error?.message || '' } catch { /* keep status-only fallback */ }
        lastFailure = new Error(`Antigravity request failed (${response.status})${message ? `: ${message}` : ''}`)
        if (response.status !== 403 && response.status !== 404 && response.status <= 499 && response.status !== 429) throw lastFailure
      }
      if (!response?.ok) throw lastFailure || new Error('Antigravity request failed')
      if (!response.body) throw new Error('Antigravity returned an empty stream')
      const state = { current: undefined }
      for await (const frame of sseEvents(response.body)) {
        const result = frame.response || frame
        consumeResponse(stream, output, result, state)
      }
      finishOpenBlock(stream, output, state.current)
      stream.push({ type: 'done', reason: output.stopReason === 'length' ? 'length' : output.stopReason === 'toolUse' ? 'toolUse' : 'stop', message: output })
      stream.end(output)
    })().catch(error => {
      output.stopReason = options.signal?.aborted ? 'aborted' : 'error'
      output.errorMessage = error instanceof Error ? error.message : String(error)
      stream.push({ type: 'error', reason: output.stopReason, error: output })
      stream.end(output)
    })
    return stream
  }
}
