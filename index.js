/**
 * Antigravity Connect — use the local Antigravity session as DSH models.
 *
 * There is no OAuth client to create and no Google Cloud Console step: the
 * plugin adopts the sign-in that the Antigravity app already stored on this
 * machine, then refreshes it with the desktop client Antigravity ships.
 */
import { createProvider } from '@earendil-works/pi-ai'
import { resolveRetryPolicy, LlmError } from '@deepseek-ai/dsh-llm'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import z from '@deepseek-ai/schemastery'
import { AntigravityCredentialStore, ANTIGRAVITY_PROVIDER } from './src/auth.js'
import { antigravityStream } from './src/cloud-code.js'
import { ANTIGRAVITY_MODELS } from './src/models.js'

export const name = 'llm-antigravity'
export const inject = ['llm']
export const Config = z.object({
  projectId: z.string().default(''),
})

function makeProfile(store, resolveConfig) {
  const resolveProject = async (accessToken, signal) => {
    const configured = resolveConfig()?.projectId || process.env.ANTIGRAVITY_PROJECT_ID
    const stored = await store.getProjectId(accessToken, signal)
    return configured || stored
  }
  const stream = antigravityStream(resolveProject)
  const provider = createProvider({
    id: ANTIGRAVITY_PROVIDER,
    name: 'Antigravity',
    baseUrl: 'https://daily-cloudcode-pa.googleapis.com/v1internal',
    auth: {
      apiKey: {
        name: 'Antigravity local session',
        resolve: async ({ credential }) => credential?.key
          ? { auth: { apiKey: credential.key }, source: 'Antigravity local session' }
          : undefined,
      },
    },
    models: ANTIGRAVITY_MODELS,
    api: { stream, streamSimple: stream },
  })
  return {
    provider: ANTIGRAVITY_PROVIDER,
    displayName: 'Antigravity',
    streamIdleTimeoutMs: 300_000,
    retryPolicy: resolveRetryPolicy(undefined, 'dsh-antigravity-connect retryPolicy'),
    configuredMaxTokens: new Map(),
    modelErrors: new Map(),
    maxRequestImageBytes: 20 * 1024 * 1024,
    maxRequestImages: 50,
    imageOffloadCountQuantum: 10,
    requestImagePixelBudget: 4 * 1024 * 1024,
    requestImageMaxBytes: 1024 * 1024,
    piProvider: provider,
  }
}

export function apply(ctx, config = {}) {
  const store = new AntigravityCredentialStore(undefined, {
    projectId: config.projectId || '',
  })
  const profile = makeProfile(store, () => config)
  const profiles = new Map([[ANTIGRAVITY_PROVIDER, profile]])
  if (ctx.llm.listProviders().some(provider => provider.id === ANTIGRAVITY_PROVIDER)) {
    throw new LlmError(`Antigravity provider already registered: ${ANTIGRAVITY_PROVIDER}`, 'DUPLICATE_ADAPTER')
  }
  const adapter = new PiAiAdapter({
    profiles: () => profiles,
    resolveApiKey: async () => store.getAccessToken(),
    resolveAttachments: () => ctx.get('attachments'),
  })
  ctx.llm.registerAdapter([ANTIGRAVITY_PROVIDER], adapter)
  ctx.llm.registerConfigurableProviders([{
    provider: ANTIGRAVITY_PROVIDER,
    displayName: 'Antigravity',
    settingsNs: 'llm-antigravity',
    settingsPath: [],
    declared: false,
  }])
}

export {
  ANTIGRAVITY_PROVIDER,
  AntigravityCredentialStore,
  antigravityAuthPath,
  readAntigravityLocalToken,
} from './src/auth.js'
export { ANTIGRAVITY_MODELS } from './src/models.js'
