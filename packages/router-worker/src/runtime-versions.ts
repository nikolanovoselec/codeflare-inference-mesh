import { InvalidJsonBodyError } from './errors'
import type { Store } from './types'

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' }
const CACHE_TTL_MS = 10 * 60 * 1000
const GITHUB_USER_AGENT = 'codeflare-inference-mesh-router'

export const DEFAULT_MESHLLM_VERSION = 'v0.72.2'
export const DEFAULT_LLAMACPP_VERSION = 'b9912'

/** GitHub owner/repo override for mesh-llm releases (REQ-NODE-014): a valid
 * `owner/repo` in MESHLLM_RELEASE_REPOSITORY redirects release listing and the
 * fleet's binary downloads (e.g. to an overlay-hardened fork); anything else
 * falls back to upstream. */
export function meshllmReleaseRepository(env: { readonly MESHLLM_RELEASE_REPOSITORY?: string }): string | undefined {
  const value = (env.MESHLLM_RELEASE_REPOSITORY ?? '').trim()
  return /^[\w.-]+\/[\w.-]+$/.test(value) ? value : undefined
}

export interface RuntimeRepositoryOverrides {
  readonly meshllm?: string
}

const SOURCES = {
  meshllm: {
    repository: 'Mesh-LLM/mesh-llm',
    cacheKey: 'meshllm_versions_cache',
    desiredKey: 'desired_meshllm_version',
    defaultVersion: DEFAULT_MESHLLM_VERSION
  },
  llamacpp: {
    repository: 'ggml-org/llama.cpp',
    cacheKey: 'llamacpp_versions_cache',
    desiredKey: 'desired_llamacpp_version',
    defaultVersion: DEFAULT_LLAMACPP_VERSION
  }
} as const

type RuntimeKind = keyof typeof SOURCES

export interface RuntimeBinaryVersions {
  readonly meshllm: string
  readonly llamacpp: string
}

interface RuntimeVersionsCache {
  readonly fetchedAt: number
  readonly tags: readonly string[]
  /** Repository the tags came from; a repo switch invalidates the cache. */
  readonly repository?: string
}

interface RuntimeVersionList {
  readonly tags: readonly string[]
  readonly fetchedAt?: number
  readonly stale: boolean
  readonly desired: string
  readonly error?: string
}

export async function desiredRuntimeVersions(store: Store): Promise<RuntimeBinaryVersions> {
  const meshllm = await store.getConfig<string>(SOURCES.meshllm.desiredKey)
  const llamacpp = await store.getConfig<string>(SOURCES.llamacpp.desiredKey)
  return {
    meshllm: validVersionString(meshllm) ? meshllm : SOURCES.meshllm.defaultVersion,
    llamacpp: validVersionString(llamacpp) ? llamacpp : SOURCES.llamacpp.defaultVersion
  }
}

export async function handleRuntimeVersionsList(request: Request, store: Store, fetcher: typeof fetch = globalThis.fetch, overrides?: RuntimeRepositoryOverrides): Promise<Response> {
  void request
  const [meshllm, llamacpp] = await Promise.all([
    runtimeList('meshllm', store, fetcher, overrides),
    runtimeList('llamacpp', store, fetcher, overrides)
  ])
  return json({ meshllm, llamacpp }, 200)
}

export async function handleRuntimeVersionsSelect(request: Request, store: Store, fetcher: typeof fetch = globalThis.fetch, actor = 'admin', overrides?: RuntimeRepositoryOverrides): Promise<Response> {
  let body: { meshllm?: unknown; llamacpp?: unknown } | null
  try {
    body = await request.json() as { meshllm?: unknown; llamacpp?: unknown } | null
  } catch {
    throw new InvalidJsonBodyError()
  }
  const meshllm = body?.meshllm
  const llamacpp = body?.llamacpp
  if (meshllm !== undefined && !validVersionString(meshllm)) return json({ error: 'invalid_meshllm_version' }, 400)
  if (llamacpp !== undefined && !validVersionString(llamacpp)) return json({ error: 'invalid_llamacpp_version' }, 400)
  if (meshllm === undefined && llamacpp === undefined) return json({ error: 'invalid_runtime_versions' }, 400)

  const now = Date.now()
  const updates: { meshllm?: string; llamacpp?: string } = {}
  if (typeof meshllm === 'string') {
    const tags = await currentTags('meshllm', store, fetcher, now, overrides)
    if (!tags.includes(meshllm)) return json({ error: 'unknown_meshllm_version', version: meshllm }, 400)
    await store.putConfig(SOURCES.meshllm.desiredKey, meshllm)
    updates.meshllm = meshllm
  }
  if (typeof llamacpp === 'string') {
    const tags = await currentTags('llamacpp', store, fetcher, now)
    if (!tags.includes(llamacpp)) return json({ error: 'unknown_llamacpp_version', version: llamacpp }, 400)
    await store.putConfig(SOURCES.llamacpp.desiredKey, llamacpp)
    updates.llamacpp = llamacpp
  }
  const desired = await desiredRuntimeVersions(store)
  await store.appendAudit({ id: crypto.randomUUID(), type: 'runtime_versions_selected', at: now, actor, detail: updates })
  return json({ ok: true, desired }, 200)
}

function repositoryFor(kind: RuntimeKind, overrides?: RuntimeRepositoryOverrides): string {
  if (kind === 'meshllm' && overrides?.meshllm) return overrides.meshllm
  return SOURCES[kind].repository
}

// A cache row from a different repository never serves — not even as a stale
// fallback — so switching release sources can only show the new repo's tags.
function cacheMatchesRepository(cache: RuntimeVersionsCache | undefined, repository: string, defaultRepository: string): cache is RuntimeVersionsCache {
  if (cache === undefined) return false
  // Legacy rows carry no repository and can only have come from the default.
  return (cache.repository ?? defaultRepository) === repository
}

async function runtimeList(kind: RuntimeKind, store: Store, fetcher: typeof fetch, overrides?: RuntimeRepositoryOverrides): Promise<RuntimeVersionList> {
  const now = Date.now()
  const source = SOURCES[kind]
  const repository = repositoryFor(kind, overrides)
  const desired = (await desiredRuntimeVersions(store))[kind]
  const cachedRaw = await store.getConfig<RuntimeVersionsCache>(source.cacheKey)
  const cached = cacheMatchesRepository(cachedRaw, repository, source.repository) ? cachedRaw : undefined
  const fresh = isCacheFresh(cached, now) ? cached : await refreshCache(kind, store, fetcher, now, repository)
  const served = fresh ?? cached
  if (!served) return { tags: [source.defaultVersion], stale: true, desired, error: 'releases_fetch_failed' }
  return { tags: served.tags, fetchedAt: served.fetchedAt, stale: !fresh, desired }
}

async function currentTags(kind: RuntimeKind, store: Store, fetcher: typeof fetch, now: number, overrides?: RuntimeRepositoryOverrides): Promise<readonly string[]> {
  const source = SOURCES[kind]
  const repository = repositoryFor(kind, overrides)
  const cachedRaw = await store.getConfig<RuntimeVersionsCache>(source.cacheKey)
  const cached = cacheMatchesRepository(cachedRaw, repository, source.repository) ? cachedRaw : undefined
  const current = isCacheFresh(cached, now) ? cached : (await refreshCache(kind, store, fetcher, now, repository)) ?? cached
  return current?.tags ?? [source.defaultVersion]
}

function isCacheFresh(cache: RuntimeVersionsCache | undefined, now: number): cache is RuntimeVersionsCache {
  return cache !== undefined && now - cache.fetchedAt < CACHE_TTL_MS
}

async function refreshCache(kind: RuntimeKind, store: Store, fetcher: typeof fetch, now: number, repository: string): Promise<RuntimeVersionsCache | undefined> {
  const tags = await fetchReleaseTags(repository, fetcher)
  if (!tags) return undefined
  const cache = { fetchedAt: now, tags, repository }
  await store.putConfig(SOURCES[kind].cacheKey, cache)
  return cache
}

async function fetchReleaseTags(repository: string, fetcher: typeof fetch): Promise<readonly string[] | undefined> {
  try {
    const response = await fetcher(`https://api.github.com/repos/${repository}/releases?per_page=100`, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': GITHUB_USER_AGENT }
    })
    if (!response.ok) return undefined
    const payload = await response.json()
    if (!Array.isArray(payload)) return undefined
    return payload.flatMap((release) => {
      const tag = release && typeof release === 'object' ? (release as { tag_name?: unknown }).tag_name : undefined
      return validVersionString(tag) ? [tag] : []
    })
  } catch {
    return undefined
  }
}

function validVersionString(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value)
}

function json(body: unknown, status: number): Response {
  return Response.json(body, { status, headers: JSON_HEADERS })
}

export const RUNTIME_VERSIONS_ANCHORS = {
  REQ_ADM_033: 'REQ-ADM-033',
  REQ_NODE_013: 'REQ-NODE-013'
} as const
