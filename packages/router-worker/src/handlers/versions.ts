/**
 * Agent and runtime version selection.
 *
 * Each operation is one function serving two routes. The console and the automation API
 * differ only in the credential that opens them, which the route table declares.
 */
import { handleAgentVersionSelect, handleAgentVersionsList } from '../agent-versions'
import { handleRuntimeVersionsList, handleRuntimeVersionsSelect } from '../runtime-versions'
import type { RouterDeps } from '../deps'

/**
 * The console and the automation API expose the same four version operations, and
 * before this each pair was a separate one-line wrapper with a byte-identical body.
 * They differ only in the credential that opens them, which the route table declares,
 * so one function per operation now serves both routes.
 */
export async function agentVersionsList(request: Request, deps: RouterDeps): Promise<Response> {
  return await handleAgentVersionsList(request, deps.store, deps.env, deps.releasesFetcher)
}

export async function agentVersionSelect(request: Request, deps: RouterDeps, actor: string): Promise<Response> {
  return await handleAgentVersionSelect(request, deps.store, deps.env, deps.releasesFetcher ?? globalThis.fetch, actor)
}

export async function runtimeVersionsList(request: Request, deps: RouterDeps): Promise<Response> {
  return await handleRuntimeVersionsList(request, deps.store, deps.releasesFetcher ?? globalThis.fetch, deps.env)
}

export async function runtimeVersionSelect(request: Request, deps: RouterDeps, actor: string): Promise<Response> {
  return await handleRuntimeVersionsSelect(request, deps.store, deps.releasesFetcher ?? globalThis.fetch, actor, deps.env)
}
