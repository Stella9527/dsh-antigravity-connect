/**
 * Automatic authentication for Antigravity.
 *
 * Instead of asking the user to create an OAuth desktop client in Google Cloud
 * Console, this module reuses the OAuth session that the locally installed
 * Antigravity app already created (`~/.gemini/jetski-standalone-oauth-token`).
 * Access tokens are refreshed with the desktop client that Antigravity itself
 * ships, discovered from the installed binary; no client secret is stored in
 * this repository.
 *
 * Derived from dsh-gemini-connect (Apache-2.0); see NOTICE.
 */
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const ANTIGRAVITY_PROVIDER = 'antigravity'
export const ANTIGRAVITY_AUTH_FILENAME = '.antigravity-auth.json'
export const ANTIGRAVITY_DEFAULT_PROJECT_ID = 'aicode-consumers'

const AUTH_VERSION = 1
const AUTH_CLIENT = 'antigravity'
// Public installed-app client id; the matching secret is read from the
// installed Antigravity bundle, never committed.
const PUBLIC_CLIENT_ID = '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com'
const SECRET_PATTERN = /GOCSPX-[A-Za-z0-9_-]{28}/g
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const CODE_ASSIST_URL = 'https://daily-cloudcode-pa.googleapis.com'
const CODE_ASSIST_METADATA = {
  ideType: 'IDE_UNSPECIFIED',
  platform: 'PLATFORM_UNSPECIFIED',
  pluginType: 'GEMINI',
}

function isMissing(error) {
  return error?.code === 'ENOENT'
}

export function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

export function antigravityAuthPath() {
  return join(dshHome(), ANTIGRAVITY_AUTH_FILENAME)
}

/** The token file maintained by the Antigravity desktop app. */
export function antigravityLocalTokenPaths() {
  const explicit = process.env.ANTIGRAVITY_TOKEN_FILE
  const home = homedir()
  const paths = explicit ? [explicit] : []
  paths.push(join(home, '.gemini', 'jetski-standalone-oauth-token'))
  paths.push(join(home, '.gemini', 'antigravity-cli', 'oauth-token'))
  return paths
}

/** Installed Antigravity bundles that embed the desktop OAuth client. */
function antigravityBinaryPaths() {
  const explicit = process.env.ANTIGRAVITY_CLIENT_BINARY
  const home = homedir()
  const paths = explicit ? [explicit] : []
  if (process.platform === 'darwin') {
    paths.push('/Applications/Antigravity.app/Contents/Resources/bin/language_server')
    paths.push('/Applications/Antigravity IDE.app/Contents/Resources/bin/language_server')
    paths.push(join(home, 'Applications', 'Antigravity.app', 'Contents', 'Resources', 'bin', 'language_server'))
  } else if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA || join(home, 'AppData', 'Local')
    paths.push(join(local, 'Programs', 'Antigravity', 'resources', 'bin', 'language_server.exe'))
  } else {
    paths.push('/opt/Antigravity/resources/bin/language_server')
    paths.push('/usr/share/antigravity/resources/bin/language_server')
  }
  return paths
}

function parseExpiry(value, fallbackSeconds) {
  const parsed = typeof value === 'string' ? Date.parse(value) : Number(value)
  if (Number.isFinite(parsed) && parsed > 0) return parsed
  const seconds = Number(fallbackSeconds)
  return Date.now() + (Number.isFinite(seconds) && seconds > 0 ? seconds : 3600) * 1000
}

function validateStored(value, filename) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid Antigravity credential document: ${filename}`)
  }
  const credential = value.credential ?? value
  if (!credential || credential.type !== 'oauth') {
    throw new Error(`Antigravity credential document has no OAuth credential: ${filename}`)
  }
  for (const key of ['access', 'refresh']) {
    if (typeof credential[key] !== 'string' || credential[key].length === 0) {
      throw new Error(`Antigravity OAuth credential is missing ${key}`)
    }
  }
  if (!Number.isFinite(credential.expires) || credential.expires <= 0) {
    throw new Error('Antigravity OAuth credential has an invalid expiry')
  }
  return {
    type: 'oauth',
    access: credential.access,
    refresh: credential.refresh,
    expires: credential.expires,
    client: AUTH_CLIENT,
    ...(typeof credential.email === 'string' && credential.email.length > 0 ? { email: credential.email } : {}),
    ...(typeof credential.projectId === 'string' && credential.projectId.length > 0 ? { projectId: credential.projectId } : {}),
    ...(typeof credential.clientId === 'string' && credential.clientId.length > 0 ? { clientId: credential.clientId } : {}),
    ...(typeof credential.clientSecret === 'string' && credential.clientSecret.length > 0 ? { clientSecret: credential.clientSecret } : {}),
  }
}

async function readJson(filename, validate) {
  let text
  try {
    text = await readFile(filename, 'utf8')
  } catch (error) {
    if (isMissing(error)) return undefined
    throw error
  }
  let value
  try {
    value = JSON.parse(text)
  } catch {
    throw new Error(`Credential document is not valid JSON: ${filename}`)
  }
  return validate(value, filename)
}

async function saveJson(filename, document) {
  await mkdir(dirname(filename), { recursive: true, mode: 0o700 })
  const temporary = `${filename}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 })
  await rename(temporary, filename)
  if (process.platform !== 'win32') await chmod(filename, 0o600).catch(() => {})
}

/** Read the OAuth session that the Antigravity app already signed in with. */
export async function readAntigravityLocalToken() {
  for (const filename of antigravityLocalTokenPaths()) {
    const value = await readJson(filename, (document, file) => {
      if (!document || typeof document !== 'object') throw new Error(`Invalid Antigravity token file: ${file}`)
      const token = document.token ?? document
      if (typeof token.access_token !== 'string' || token.access_token.length === 0) {
        throw new Error(`Antigravity token file has no access_token: ${file}`)
      }
      return {
        access: token.access_token,
        refresh: typeof token.refresh_token === 'string' ? token.refresh_token : '',
        expires: parseExpiry(token.expiry, token.expires_in),
        email: typeof document.id_token_email === 'string' ? document.id_token_email : undefined,
      }
    })
    if (value !== undefined) return { ...value, filename }
  }
  return undefined
}

/** Extract the desktop client secret from the locally installed app. */
export async function discoverAntigravityClient() {
  if (process.env.ANTIGRAVITY_CLIENT_ID && process.env.ANTIGRAVITY_CLIENT_SECRET) {
    return [{ clientId: process.env.ANTIGRAVITY_CLIENT_ID, clientSecret: process.env.ANTIGRAVITY_CLIENT_SECRET }]
  }
  const secrets = new Set()
  for (const filename of antigravityBinaryPaths()) {
    try {
      const content = await readFile(filename, 'latin1')
      for (const match of content.match(SECRET_PATTERN) ?? []) secrets.add(match)
    } catch (error) {
      if (!isMissing(error)) continue
    }
  }
  return [...secrets].map(clientSecret => ({ clientId: PUBLIC_CLIENT_ID, clientSecret }))
}

async function refreshToken(refresh, client, signal) {
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refresh,
      client_id: client.clientId,
      client_secret: client.clientSecret,
    }),
    signal,
  })
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    let message = ''
    try {
      message = JSON.parse(detail)?.error_description || JSON.parse(detail)?.error || ''
    } catch { /* status-only fallback */ }
    throw new Error(`Antigravity OAuth refresh failed (${response.status})${message ? `: ${message}` : ''}`)
  }
  const json = await response.json()
  if (typeof json.access_token !== 'string' || typeof json.expires_in !== 'number') {
    throw new Error('Antigravity OAuth refresh returned an invalid response')
  }
  return {
    access: json.access_token,
    refresh: typeof json.refresh_token === 'string' && json.refresh_token.length > 0 ? json.refresh_token : refresh,
    expires: Date.now() + json.expires_in * 1000,
  }
}

/** Ask Code Assist which managed project this account should use. */
async function discoverProject(accessToken, signal) {
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
    'User-Agent': 'antigravity/1.104.0 darwin/arm64',
    'X-Goog-Api-Client': 'gl-node/22.17.0',
    'Client-Metadata': JSON.stringify(CODE_ASSIST_METADATA),
  }
  try {
    const response = await fetch(`${CODE_ASSIST_URL}/v1internal:loadCodeAssist`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ metadata: CODE_ASSIST_METADATA }),
      signal,
    })
    if (!response.ok) return undefined
    const payload = await response.json()
    const value = payload.cloudaicompanionProject
    if (typeof value === 'string' && value.length > 0) return value
    if (value && typeof value.id === 'string' && value.id.length > 0) return value.id
  } catch { /* fall back to the default managed project */ }
  return undefined
}

let queue = Promise.resolve()
function serialize(task) {
  const run = queue.then(task, task)
  queue = run.catch(() => {})
  return run
}

export class AntigravityCredentialStore {
  constructor(filename = antigravityAuthPath(), options = {}) {
    this.filename = filename
    this.configProjectId = options.projectId
    this.clients = undefined
  }

  async clientCandidates(cached) {
    if (this.clients !== undefined) return this.clients
    const discovered = await discoverAntigravityClient()
    const candidates = []
    if (cached?.clientId && cached?.clientSecret) candidates.push({ clientId: cached.clientId, clientSecret: cached.clientSecret })
    for (const candidate of discovered) {
      if (!candidates.some(entry => entry.clientSecret === candidate.clientSecret)) candidates.push(candidate)
    }
    this.clients = candidates
    return candidates
  }

  async read() {
    const credential = await readJson(this.filename, validateStored)
    return credential ? { credential, filename: this.filename } : undefined
  }

  async status() {
    const current = await this.read()
    const local = await readAntigravityLocalToken()
    if (!current && !local) return { state: 'signed-out', source: 'none' }
    const expires = Math.max(current?.credential.expires ?? 0, local?.expires ?? 0)
    return {
      state: expires > Date.now() + 30_000 ? 'signed-in' : 'refreshable',
      source: current ? 'dsh' : 'antigravity',
      ...(current?.credential.email || local?.email ? { email: current?.credential.email || local?.email } : {}),
    }
  }

  /** One-time import of the Antigravity app session into DSH's own store. */
  async importFromAntigravity(signal) {
    return serialize(async () => {
      const local = await readAntigravityLocalToken()
      if (local === undefined) {
        throw new Error('No Antigravity sign-in found. Open Antigravity once and sign in with Google, then retry')
      }
      const credential = {
        type: 'oauth',
        access: local.access,
        refresh: local.refresh,
        expires: local.expires,
        client: AUTH_CLIENT,
        ...(local.email === undefined ? {} : { email: local.email }),
      }
      if (credential.expires <= Date.now() + 60_000) {
        const refreshed = await this.refreshWith(credential, signal)
        Object.assign(credential, refreshed)
      }
      await saveJson(this.filename, { version: AUTH_VERSION, credential })
      return credential
    })
  }

  async refreshWith(credential, signal, fallbackRefresh) {
    const refreshTokens = [...new Set([
      credential.refresh,
      fallbackRefresh,
    ].filter(value => typeof value === 'string' && value.length > 0))]
    const clients = await this.clientCandidates(credential)
    if (clients.length === 0) {
      throw new Error('Could not find the Antigravity OAuth client. Set ANTIGRAVITY_CLIENT_ID and ANTIGRAVITY_CLIENT_SECRET, or install Antigravity')
    }
    let lastFailure
    for (const refresh of refreshTokens) {
      for (const client of clients) {
        try {
          const refreshed = await refreshToken(refresh, client, signal)
          return { ...refreshed, clientId: client.clientId, clientSecret: client.clientSecret }
        } catch (error) {
          lastFailure = error
        }
      }
    }
    throw lastFailure ?? new Error('Antigravity is not signed in. Open Antigravity and sign in with Google, then retry')
  }

  async getAccessToken(signal) {
    return serialize(async () => {
      const current = await this.read()
      const local = await readAntigravityLocalToken()
      // Antigravity keeps its file fresh while it runs; adopt a newer session.
      if (local !== undefined && local.access.length > 0 && (current === undefined || local.expires > current.credential.expires + 5_000)) {
        const credential = {
          type: 'oauth',
          access: local.access,
          refresh: current?.credential.refresh || local.refresh,
          expires: local.expires,
          client: AUTH_CLIENT,
          ...(current?.credential.projectId === undefined ? {} : { projectId: current.credential.projectId }),
          ...(current?.credential.clientId === undefined ? {} : { clientId: current.credential.clientId, clientSecret: current.credential.clientSecret }),
          ...(local.email === undefined ? {} : { email: local.email }),
        }
        if (credential.expires > Date.now() + 60_000) {
          await saveJson(this.filename, { version: AUTH_VERSION, credential })
          return credential.access
        }
      }
      if (current !== undefined && current.credential.expires > Date.now() + 60_000) {
        return current.credential.access
      }
      const refreshed = await this.refreshWith(current?.credential ?? {
        refresh: local?.refresh ?? '',
        clientId: current?.credential.clientId,
        clientSecret: current?.credential.clientSecret,
      }, signal, local?.refresh)
      const credential = {
        type: 'oauth',
        access: refreshed.access,
        refresh: refreshed.refresh,
        expires: refreshed.expires,
        client: AUTH_CLIENT,
        clientId: refreshed.clientId,
        clientSecret: refreshed.clientSecret,
        ...(current?.credential.projectId === undefined ? {} : { projectId: current.credential.projectId }),
        ...(current?.credential.email || local?.email ? { email: current?.credential.email || local?.email } : {}),
      }
      await saveJson(this.filename, { version: AUTH_VERSION, credential })
      return credential.access
    })
  }

  async getProjectId(accessToken, signal) {
    if (this.configProjectId) return this.configProjectId
    const current = await this.read()
    if (current?.credential.projectId) return current.credential.projectId
    const discovered = accessToken ? await discoverProject(accessToken, signal) : undefined
    const projectId = discovered || ANTIGRAVITY_DEFAULT_PROJECT_ID
    if (current !== undefined) {
      const credential = { ...current.credential, projectId }
      await saveJson(this.filename, { version: AUTH_VERSION, credential }).catch(() => {})
    }
    return projectId
  }

  async logout() {
    await unlink(this.filename).catch(error => {
      if (!isMissing(error)) throw error
    })
  }
}

export async function antigravityAuthExists() {
  try {
    await readFile(antigravityAuthPath())
    return true
  } catch {
    return false
  }
}
