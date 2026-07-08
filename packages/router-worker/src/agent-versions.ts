import { InvalidJsonBodyError } from './errors'
import type { RouterEnv, Store } from './types'

export type AgentVersionsEnv = Pick<Partial<RouterEnv>, 'GITHUB_REPOSITORY'>

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' }
const AGENT_VERSIONS_CACHE_KEY = 'agent_versions_cache'
const DESIRED_AGENT_VERSION_KEY = 'desired_agent_version'
const CACHE_TTL_MS = 10 * 60 * 1000
const DEFAULT_REPOSITORY = 'nikolanovoselec/codeflare-inference-mesh'
const GITHUB_USER_AGENT = 'codeflare-inference-mesh-router'

interface AgentVersionsCache {
  readonly fetchedAt: number
  readonly tags: readonly string[]
}

export async function handleAgentVersionsList(request: Request, store: Store, env: AgentVersionsEnv, fetcher: typeof fetch = globalThis.fetch): Promise<Response> {
  void request
  const now = Date.now()
  const desired = await desiredAgentVersion(store)
  const cached = await store.getConfig<AgentVersionsCache>(AGENT_VERSIONS_CACHE_KEY)
  const fresh = isCacheFresh(cached, now) ? cached : await refreshCache(store, env, fetcher, now)
  const served = fresh ?? cached
  if (!served) return json({ tags: [], stale: true, error: 'releases_fetch_failed', desired }, 200)
  return json({ tags: served.tags, fetchedAt: served.fetchedAt, stale: !fresh, desired }, 200)
}

export async function handleAgentVersionSelect(request: Request, store: Store, env: AgentVersionsEnv, fetcher: typeof fetch = globalThis.fetch, actor = 'admin'): Promise<Response> {
  let body: { version?: unknown } | null
  try {
    body = await request.json() as { version?: unknown } | null
  } catch {
    // Route a malformed body through the shared boundary error so the router's top-level catch
    // answers 400 invalid_json here too (this handler parses directly, not via readJson).
    throw new InvalidJsonBodyError()
  }
  const version = typeof body?.version === 'string' ? body.version : ''
  if (!version) return json({ error: 'invalid_version' }, 400)
  const now = Date.now()
  const cached = await store.getConfig<AgentVersionsCache>(AGENT_VERSIONS_CACHE_KEY)
  const cacheFresh = isCacheFresh(cached, now)
  let current = cacheFresh ? cached : (await refreshCache(store, env, fetcher, now)) ?? cached
  if (cacheFresh && current && !current.tags.includes(version)) {
    current = await refreshCache(store, env, fetcher, now) ?? current
  }
  if (!current || !current.tags.includes(version)) return json({ error: 'unknown_version', version }, 400)
  await store.putConfig(DESIRED_AGENT_VERSION_KEY, version)
  await store.appendAudit({ id: crypto.randomUUID(), type: 'agent_version_selected', at: now, actor, target: version, detail: { version } })
  return json({ ok: true, desired: version }, 200)
}

export function desiredAgentVersion(store: Store): Promise<string | undefined> {
  return store.getConfig<string>(DESIRED_AGENT_VERSION_KEY)
}

function isCacheFresh(cache: AgentVersionsCache | undefined, now: number): cache is AgentVersionsCache {
  return cache !== undefined && now - cache.fetchedAt < CACHE_TTL_MS
}

function extractReleaseTags(payload: unknown): readonly string[] | undefined {
  if (!Array.isArray(payload)) return undefined
  return payload.flatMap((release) => {
    const tag = release && typeof release === 'object' ? (release as { tag_name?: unknown }).tag_name : undefined
    return typeof tag === 'string' && tag ? [tag] : []
  })
}

async function refreshCache(store: Store, env: AgentVersionsEnv, fetcher: typeof fetch, now: number): Promise<AgentVersionsCache | undefined> {
  const tags = await fetchReleaseTags(env, fetcher)
  if (!tags) return undefined
  const cache: AgentVersionsCache = { fetchedAt: now, tags }
  await store.putConfig(AGENT_VERSIONS_CACHE_KEY, cache)
  return cache
}

async function fetchReleaseTags(env: AgentVersionsEnv, fetcher: typeof fetch): Promise<readonly string[] | undefined> {
  const repository = env.GITHUB_REPOSITORY ?? DEFAULT_REPOSITORY
  try {
    const response = await fetcher(`https://api.github.com/repos/${repository}/releases?per_page=100`, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': GITHUB_USER_AGENT }
    })
    if (!response.ok) return undefined
    return extractReleaseTags(await response.json())
  } catch {
    return undefined
  }
}

function json(body: unknown, status: number): Response {
  return Response.json(body, { status, headers: JSON_HEADERS })
}

export const AGENT_VERSIONS_ANCHORS = {
  REQ_ADM_008: 'REQ-ADM-008'
} as const
