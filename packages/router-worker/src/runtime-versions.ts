import { InvalidJsonBodyError } from './errors'
import type { Store } from './types'

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' }
const CACHE_TTL_MS = 10 * 60 * 1000
const GITHUB_USER_AGENT = 'codeflare-inference-mesh-router'

export const DEFAULT_MESHLLM_VERSION = 'v0.72.2'
export const DEFAULT_LLAMACPP_VERSION = 'b9912'

/** The `owner/repo` fork configured in MESHLLM_RELEASE_REPOSITORY (REQ-NODE-014):
 * a valid value makes an overlay-hardened fork *available* as a binary source;
 * anything else leaves upstream as the only source. This is the option, not the
 * active choice — {@link activeMeshllmRepository} applies the operator's pick. */
export function meshllmReleaseRepository(env: MeshllmSourceEnv): string | undefined {
  const value = (env.MESHLLM_RELEASE_REPOSITORY ?? '').trim()
  return /^[\w.-]+\/[\w.-]+$/.test(value) ? value : undefined
}

export interface MeshllmSourceEnv {
  readonly MESHLLM_RELEASE_REPOSITORY?: string
}

export interface RuntimeRepositoryOverrides {
  readonly meshllm?: string | undefined
}

/** Config key holding the operator's mesh-llm binary source choice. */
const MESHLLM_SOURCE_KEY = 'meshllm_release_source'
export type MeshllmSource = 'official' | 'fork'

/** The mesh-llm release repository that is currently active: the configured fork
 * when one exists and the operator has not switched to official, otherwise
 * `undefined` (upstream). When no fork is configured the choice is inert. */
export async function activeMeshllmRepository(env: MeshllmSourceEnv, store: Store): Promise<string | undefined> {
  const fork = meshllmReleaseRepository(env)
  if (!fork) return undefined
  const choice = await store.getConfig<string>(MESHLLM_SOURCE_KEY)
  return choice === 'official' ? undefined : fork
}

export interface MeshllmReleaseSourceView {
  /** Which source is active: defaults to `fork` when a fork is configured. */
  readonly source: MeshllmSource
  /** The configured fork's `owner/repo`, absent when none is configured. */
  readonly forkRepository?: string
  /** The upstream `owner/repo` the official option always points at. */
  readonly officialRepository: string
}

/** The source picture the console renders: whether a fork option exists, its
 * repo, and which source is active. */
export async function meshllmReleaseSource(env: MeshllmSourceEnv, store: Store): Promise<MeshllmReleaseSourceView> {
  const fork = meshllmReleaseRepository(env)
  const choice = await store.getConfig<string>(MESHLLM_SOURCE_KEY)
  const source: MeshllmSource = fork && choice !== 'official' ? 'fork' : 'official'
  return { source, ...(fork ? { forkRepository: fork } : {}), officialRepository: SOURCES.meshllm.repository }
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

export async function handleRuntimeVersionsList(request: Request, store: Store, fetcher: typeof fetch = globalThis.fetch, env: MeshllmSourceEnv = {}): Promise<Response> {
  void request
  const overrides = { meshllm: await activeMeshllmRepository(env, store) }
  const [meshllm, llamacpp, source] = await Promise.all([
    runtimeList('meshllm', store, fetcher, overrides),
    runtimeList('llamacpp', store, fetcher),
    meshllmReleaseSource(env, store)
  ])
  return json({ meshllm: { ...meshllm, ...source }, llamacpp }, 200)
}

export async function handleRuntimeVersionsSelect(request: Request, store: Store, fetcher: typeof fetch = globalThis.fetch, actor = 'admin', env: MeshllmSourceEnv = {}): Promise<Response> {
  let body: { meshllm?: unknown; llamacpp?: unknown; meshllmSource?: unknown } | null
  try {
    body = await request.json() as { meshllm?: unknown; llamacpp?: unknown; meshllmSource?: unknown } | null
  } catch {
    throw new InvalidJsonBodyError()
  }
  // Source selection is its own operation: switching the repository changes which
  // version tags are valid, so the console posts it as a separate call and reloads.
  if (body?.meshllmSource !== undefined) return await selectMeshllmSource(body.meshllmSource, store, env, actor)
  const meshllm = body?.meshllm
  const llamacpp = body?.llamacpp
  const overrides = { meshllm: await activeMeshllmRepository(env, store) }
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

// Persists the operator's mesh-llm binary source. `fork` is only accepted when a
// fork is actually configured, so the console can never strand the fleet on a
// repository the worker has no address for.
async function selectMeshllmSource(value: unknown, store: Store, env: MeshllmSourceEnv, actor: string): Promise<Response> {
  if (value !== 'official' && value !== 'fork') return json({ error: 'invalid_meshllm_source' }, 400)
  if (value === 'fork' && !meshllmReleaseRepository(env)) return json({ error: 'meshllm_fork_unavailable' }, 400)
  await store.putConfig(MESHLLM_SOURCE_KEY, value)
  await store.appendAudit({ id: crypto.randomUUID(), type: 'runtime_source_selected', at: Date.now(), actor, detail: { meshllm: value } })
  return json({ ok: true, source: value }, 200)
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
