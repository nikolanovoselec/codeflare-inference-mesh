/** Model profiles: the catalogue, its rollout state, and per-profile configuration. */
import { buildCustomProfile, buildDuplicateProfile, llamaCppQuantError, parseLlamaCppModelRef, profileMeshId } from '../profiles'
import { configureLlamaCppProfile, configureVllmProfile, INVALID_MAX_VRAM, resolveCallNameAliases, resolveMaxVram, resolveMeshReassignment, resolveMeshllmTunables, resolveRuntime, type ModelConfigBody } from '../profile-config'
import { json, readJson } from '../http'
import { listMeshes } from '../meshes'
import type { ModelProfile } from '../types'
import type { RouterDeps } from '../deps'
import { singleActiveActivation } from '../store'

export async function handleProfileRollout(request: Request, deps: RouterDeps, requestId: string, now: number, actor: string): Promise<Response> {
  const body = await readJson<{ profileId: string; rolloutPercent: number }>(request)
  if (!body || typeof body.profileId !== 'string' || typeof body.rolloutPercent !== 'number') return json({ error: 'invalid_rollout' }, 400, requestId)
  if (body.rolloutPercent > 0) {
    // Alias-exclusive invariant: rollout activation must never leave an alias with two active owners.
    const activation = singleActiveActivation(await deps.store.listProfiles(), body.profileId)
    for (const profile of activation?.deactivated ?? []) await deps.store.setProfile(profile)
  }
  await deps.store.setActiveProfile(body.profileId, body.rolloutPercent)
  await deps.store.appendAudit({ id: requestId, type: 'profile_rollout', at: now, actor, target: body.profileId, detail: { rolloutPercent: body.rolloutPercent } })
  return json({ ok: true }, 200, requestId)
}

export async function handleProfileActivate(request: Request, deps: RouterDeps, requestId: string, now: number, actor: string): Promise<Response> {
  const body = await readJson<{ profileId?: string }>(request)
  if (!body || typeof body.profileId !== 'string') return json({ error: 'invalid_activation', requestId }, 400, requestId)
  const activation = singleActiveActivation(await deps.store.listProfiles(), body.profileId)
  if (!activation) return json({ error: 'unknown_profile', requestId }, 404, requestId)
  for (const profile of activation.deactivated) await deps.store.setProfile(profile)
  await deps.store.setProfile(activation.activated)
  const deactivatedIds = activation.deactivated.map((profile) => profile.id)
  await deps.store.appendAudit({ id: requestId, type: 'profile_activated', at: now, actor, target: body.profileId, detail: { deactivated: deactivatedIds } })
  return json({ ok: true, activated: activation.activated.id, deactivated: deactivatedIds }, 200, requestId)
}

// A per-model VRAM budget in GB (0 = no cap; the node agent renders --max-vram
// only for a positive value). Returns undefined when the caller omits the field
// (leave the current setting), or INVALID_MAX_VRAM when it is present but not a
// finite number >= 0. Shared by the admin and automation model-config endpoints.
export async function handleProfileConfig(request: Request, deps: RouterDeps, requestId: string, now: number, actor: string): Promise<Response> {
  const body = await readJson<ModelConfigBody>(request)
  if (!body || typeof body.profileId !== 'string') return json({ error: 'invalid_profile_config', requestId }, 400, requestId)
  const profiles = await deps.store.listProfiles()
  const found = profiles.find((profile) => profile.id === body.profileId)
  if (!found) return json({ error: 'unknown_profile', requestId }, 404, requestId)
  const reassignment = await resolveMeshReassignment(deps, found, body.meshId)
  if ('error' in reassignment) return json({ error: reassignment.error, requestId }, 400, requestId)
  const existing = reassignment.profile
  const runtime = resolveRuntime(body.runtime)
  if (runtime === 'invalid_runtime') return json({ error: 'invalid_runtime', requestId }, 400, requestId)
  if (body.llamacpp !== undefined && runtime !== 'llamacpp' && existing.runtime !== 'llamacpp') return json({ error: 'invalid_model_config', requestId }, 400, requestId)
  if (body.vllm !== undefined && runtime !== 'vllm' && existing.runtime !== 'vllm') return json({ error: 'invalid_model_config', requestId }, 400, requestId)
  if (runtime === 'llamacpp' || existing.runtime === 'llamacpp') {
    const direct = configureLlamaCppProfile(existing, profiles, body)
    if ('error' in direct) return json({ error: direct.error, requestId }, direct.status, requestId)
    await deps.store.setProfile(direct.profile)
    if (reassignment.change) await deps.store.appendAudit({ id: crypto.randomUUID(), type: 'model_mesh_assigned', at: now, actor, target: direct.profile.id, detail: { ...reassignment.change } })
    await deps.store.appendAudit({ id: requestId, type: 'profile_configured', at: now, actor, target: direct.profile.id, detail: { contextWindow: direct.settings.contextWindow, modelRef: direct.settings.modelRef, runtime: 'llamacpp' } })
    return json({ ok: true, profileId: direct.profile.id, contextWindow: direct.settings.contextWindow, modelRef: direct.settings.modelRef, displayName: direct.profile.displayName, callableNames: direct.profile.publicAliases, runtime: 'llamacpp', model: toApiModel(direct.profile) }, 200, requestId)
  }
  if (runtime === 'vllm' || existing.runtime === 'vllm') {
    const direct = configureVllmProfile(existing, profiles, body)
    if ('error' in direct) return json({ error: direct.error, requestId }, direct.status, requestId)
    await deps.store.setProfile(direct.profile)
    if (reassignment.change) await deps.store.appendAudit({ id: crypto.randomUUID(), type: 'model_mesh_assigned', at: now, actor, target: direct.profile.id, detail: { ...reassignment.change } })
    await deps.store.appendAudit({ id: requestId, type: 'profile_configured', at: now, actor, target: direct.profile.id, detail: { contextWindow: direct.settings.contextWindow, modelRef: direct.settings.hfRepo, runtime: 'vllm' } })
    return json({ ok: true, profileId: direct.profile.id, contextWindow: direct.settings.contextWindow, modelRef: direct.settings.hfRepo, displayName: direct.profile.displayName, callableNames: direct.profile.publicAliases, runtime: 'vllm', model: toApiModel(direct.profile) }, 200, requestId)
  }
  const contextWindow = body.contextWindow ?? existing.contextWindow
  if (!Number.isInteger(contextWindow) || contextWindow < 0) return json({ error: 'invalid_context_window', requestId }, 400, requestId)
  const maxVram = resolveMaxVram(body.maxVramGb)
  if (maxVram === INVALID_MAX_VRAM) return json({ error: 'invalid_max_vram', requestId }, 400, requestId)
  if (existing.runtime !== 'meshllm' || !existing.meshllm) return json({ error: 'invalid_model_config', requestId }, 400, requestId)
  let meshllm = existing.meshllm
  let upstreamModel = existing.upstreamModel
  if (body.modelRef !== undefined) {
    const modelRef = typeof body.modelRef === 'string' ? body.modelRef.trim() : ''
    if (!modelRef) return json({ error: 'invalid_model_ref', requestId }, 400, requestId)
    meshllm = { ...meshllm, modelRef }
    upstreamModel = modelRef
  }
  if (maxVram !== undefined) meshllm = { ...meshllm, maxVramGb: maxVram }
  const tunables = resolveMeshllmTunables(meshllm, body)
  if ('error' in tunables) return json({ error: tunables.error, requestId }, 400, requestId)
  meshllm = tunables.meshllm
  // Optional rename. The display name is the human label shown in the console; the
  // call name is this model's own public alias, kept alongside the shared
  // codeflare-mesh alias. A call name must slugify to a non-empty token, cannot be
  // the reserved shared alias, and cannot collide with another model's alias.
  let displayName = existing.displayName
  if (body.name !== undefined) {
    const name = typeof body.name === 'string' ? body.name.trim() : ''
    if (!name) return json({ error: 'invalid_display_name', requestId }, 400, requestId)
    displayName = name
  }
  let publicAliases = existing.publicAliases
  if (body.callName !== undefined) {
    const resolved = resolveCallNameAliases(existing, body.callName, profiles)
    if (!Array.isArray(resolved)) return json({ error: (resolved as { error: string }).error, requestId }, (resolved as { status: number }).status, requestId)
    publicAliases = resolved
  }
  // Bump the version so a stored row edited by an operator is never mistaken for a
  // shipped default row by any future seeding logic.
  const updated: ModelProfile = { ...existing, contextWindow, upstreamModel, meshllm, displayName, publicAliases, version: existing.version + 1 }
  await deps.store.setProfile(updated)
  if (reassignment.change) await deps.store.appendAudit({ id: crypto.randomUUID(), type: 'model_mesh_assigned', at: now, actor, target: updated.id, detail: { ...reassignment.change } })
  await deps.store.appendAudit({ id: requestId, type: 'profile_configured', at: now, actor, target: updated.id, detail: { contextWindow, modelRef: meshllm.modelRef, maxVramGb: meshllm.maxVramGb ?? 0 } })
  return json({ ok: true, profileId: updated.id, contextWindow, modelRef: meshllm.modelRef, maxVramGb: meshllm.maxVramGb ?? 0, displayName: updated.displayName, callableNames: updated.publicAliases, meshId: profileMeshId(updated) }, 200, requestId)
}

// handleProfileAdd creates a new inactive model profile from an operator-supplied
// model reference, serving mode, and runtime, so a model beyond the seeded set joins
// the catalog for rollout and activation without redeploying the Worker. The reference
// is trimmed and must be non-empty; mode "split" builds a MeshLLM layer-package profile,
// while direct llama.cpp is allowed only for single-machine profiles. A reference whose
// derived id collides with an existing profile is refused rather than overwriting it.
export async function handleProfileAdd(request: Request, deps: RouterDeps, requestId: string, now: number, actor: string): Promise<Response> {
  const body = await readJson<{ modelRef?: string; mode?: string; runtime?: unknown; name?: string; meshId?: unknown }>(request)
  const modelRef = typeof body?.modelRef === 'string' ? body.modelRef.trim() : ''
  if (!modelRef) return json({ error: 'invalid_model_ref', requestId }, 400, requestId)
  const split = body?.mode === 'split'
  const runtime = resolveRuntime(body?.runtime)
  if (runtime === 'invalid_runtime') return json({ error: 'invalid_runtime', requestId }, 400, requestId)
  if (split && runtime !== 'meshllm') return json({ error: 'split_requires_meshllm', requestId }, 400, requestId)
  // A vLLM reference is a bare HF safetensors repo: a llama-style :quant file
  // tag names a GGUF file vLLM does not load in-tree.
  if (runtime === 'vllm' && parseLlamaCppModelRef(modelRef).quant !== undefined) return json({ error: 'invalid_model_ref', requestId }, 400, requestId)
  const meshId = await resolveOnboardingMesh(deps, body?.meshId)
  if (meshId === undefined) return json({ error: 'unknown_mesh', requestId }, 400, requestId)
  const name = typeof body?.name === 'string' ? body.name : undefined
  const existing = await deps.store.listProfiles()
  const profile = buildCustomProfile({ modelRef, split, existing, name, runtime, meshId })
  // A quant tag that resolves no Hugging Face file (trailing dot, whitespace) is
  // refused before it can cost an outage; the node would only fail at load time.
  if (runtime === 'llamacpp') {
    const quantError = llamaCppQuantError(profile.llamacpp?.quant)
    if (quantError) return json({ error: quantError, requestId }, 400, requestId)
  }
  if (existing.some((candidate) => candidate.id === profile.id)) return json({ error: 'duplicate_profile', profileId: profile.id, requestId }, 409, requestId)
  await deps.store.setProfile(profile)
  await deps.store.appendAudit({ id: requestId, type: 'profile_added', at: now, actor, target: profile.id, detail: { modelRef, split, runtime, meshId } })
  return json({ ok: true, profileId: profile.id, displayName: profile.displayName, split, runtime, model: toApiModel(profile) }, 201, requestId)
}

// Resolves an optional onboarding mesh: absent means the default mesh; a present
// value must name an existing mesh (undefined result = unknown_mesh).
async function resolveOnboardingMesh(deps: RouterDeps, rawMeshId: unknown): Promise<string | undefined> {
  if (rawMeshId === undefined || rawMeshId === null || rawMeshId === '') return 'default'
  if (typeof rawMeshId !== 'string') return undefined
  return (await listMeshes(deps.store)).some((mesh) => mesh.id === rawMeshId) ? rawMeshId : undefined
}

/** Machine-facing model projection: identity, the names callers use, and rollout state. */
export function toApiModel(profile: ModelProfile) {
  const m = profile.meshllm
  const l = profile.llamacpp
  const v = profile.vllm
  return {
    id: profile.id,
    displayName: profile.displayName,
    callableNames: profile.publicAliases,
    active: profile.active,
    rolloutPercent: profile.rolloutPercent,
    contextWindow: profile.contextWindow,
    runtime: profile.runtime,
    modelRef: l?.modelRef ?? v?.hfRepo ?? m?.modelRef ?? profile.upstreamModel,
    split: m?.split ?? false,
    meshId: profileMeshId(profile),
    maxVramGb: m?.maxVramGb ?? 0,
    tunables: m ? {
      parallel: m.parallel ?? null,
      cacheTypeK: m.cacheTypeK ?? null,
      cacheTypeV: m.cacheTypeV ?? null,
      batch: m.batch ?? null,
      ubatch: m.ubatch ?? null,
      flashAttn: m.flashAttn ?? null,
      maxOutputTokens: m.maxOutputTokens ?? null,
      reasoning: m.reasoning ?? null,
      prefixCache: m.prefixCache ?? null,
      toolEmulation: m.toolEmulation ?? null,
      wireDtype: m.wireDtype ?? null,
      prefillChunking: m.prefillChunking ?? null,
      prefillChunkSize: m.prefillChunkSize ?? null
    } : null,
    ...(l ? { llamacpp: l } : {}),
    ...(v ? { vllm: v } : {})
  }
}

export async function handleApiModelList(deps: RouterDeps, requestId: string): Promise<Response> {
  const profiles = await deps.store.listProfiles()
  return json({ models: profiles.map(toApiModel) }, 200, requestId)
}

// handleApiModelAdd is the automation-facing twin of handleProfileAdd: a fleet
// manager adds a model to the catalog with an automation key instead of an Access
// session, wrapping the same buildCustomProfile lever so the API and console never
// diverge. The new model is inactive and reaches production only through the enable path.
export async function handleApiModelAdd(request: Request, deps: RouterDeps, requestId: string, now: number, actor: string): Promise<Response> {
  const body = await readJson<{ modelRef?: string; mode?: string; runtime?: unknown; name?: string; meshId?: unknown }>(request)
  const modelRef = typeof body?.modelRef === 'string' ? body.modelRef.trim() : ''
  if (!modelRef) return json({ error: 'invalid_model_ref', requestId }, 400, requestId)
  const split = body?.mode === 'split'
  const runtime = resolveRuntime(body?.runtime)
  if (runtime === 'invalid_runtime') return json({ error: 'invalid_runtime', requestId }, 400, requestId)
  if (split && runtime !== 'meshllm') return json({ error: 'split_requires_meshllm', requestId }, 400, requestId)
  // Same bare-HF-repo validation as the console add path: the automation API
  // and the console share buildCustomProfile and must share the door too.
  if (runtime === 'vllm' && parseLlamaCppModelRef(modelRef).quant !== undefined) return json({ error: 'invalid_model_ref', requestId }, 400, requestId)
  const meshId = await resolveOnboardingMesh(deps, body?.meshId)
  if (meshId === undefined) return json({ error: 'unknown_mesh', requestId }, 400, requestId)
  const name = typeof body?.name === 'string' ? body.name : undefined
  const existing = await deps.store.listProfiles()
  const profile = buildCustomProfile({ modelRef, split, existing, name, runtime, meshId })
  if (runtime === 'llamacpp') {
    const quantError = llamaCppQuantError(profile.llamacpp?.quant)
    if (quantError) return json({ error: quantError, requestId }, 400, requestId)
  }
  if (existing.some((candidate) => candidate.id === profile.id)) return json({ error: 'duplicate_profile', profileId: profile.id, requestId }, 409, requestId)
  await deps.store.setProfile(profile)
  await deps.store.appendAudit({ id: requestId, type: 'profile_added', at: now, actor: actor, target: profile.id, detail: { modelRef, split, runtime } })
  return json({ ok: true, model: toApiModel(profile) }, 201, requestId)
}

// classifyModelDeletion is the single deletion rule the console and API both obey so
// they never diverge: any switched-off model can be removed, including the seed-once
// starter (REQ-RUN-012). Deleting the active model would 404 its mesh's stable route,
// so that alone is refused.
function classifyModelDeletion(profiles: readonly ModelProfile[], profileId: string): { profile: ModelProfile } | { error: string; status: number } {
  const profile = profiles.find((candidate) => candidate.id === profileId)
  if (!profile) return { error: 'unknown_profile', status: 404 }
  if (profile.active) return { error: 'model_active', status: 409 }
  return { profile }
}

export async function handleApiModelDelete(deps: RouterDeps, url: URL, requestId: string, now: number, actor: string): Promise<Response> {
  const profileId = decodeURIComponent(url.pathname.split('/').pop() ?? '')
  const outcome = classifyModelDeletion(await deps.store.listProfiles(), profileId)
  if ('error' in outcome) return json({ error: outcome.error, requestId }, outcome.status, requestId)
  await deps.store.deleteProfile(profileId)
  await deps.store.appendAudit({ id: requestId, type: 'profile_deleted', at: now, actor: actor, target: profileId, detail: {} })
  return json({ ok: true, id: profileId }, 200, requestId)
}

// handleProfileDelete is the Access-session twin of handleApiModelDelete: the console
// removes a custom, switched-off model through the same shared deletion rules.
export async function handleProfileDelete(request: Request, deps: RouterDeps, requestId: string, now: number, actor: string): Promise<Response> {
  const body = await readJson<{ profileId?: string }>(request)
  const profileId = typeof body?.profileId === 'string' ? body.profileId.trim() : ''
  const outcome = classifyModelDeletion(await deps.store.listProfiles(), profileId)
  if ('error' in outcome) return json({ error: outcome.error, requestId }, outcome.status, requestId)
  await deps.store.deleteProfile(profileId)
  await deps.store.appendAudit({ id: requestId, type: 'profile_deleted', at: now, actor, target: profileId, detail: {} })
  return json({ ok: true, profileId }, 200, requestId)
}

// Duplication clones a profile into an inactive same-mesh sibling with a derived
// call name so the operator tunes a variant without touching the original (REQ-RUN-017).
export async function duplicateProfileCore(deps: RouterDeps, profileId: string, actor: string, requestId: string, now: number): Promise<Response> {
  const profiles = await deps.store.listProfiles()
  const source = profiles.find((profile) => profile.id === profileId)
  if (!source) return json({ error: 'unknown_profile', requestId }, 404, requestId)
  const copy = buildDuplicateProfile(source, profiles)
  await deps.store.setProfile(copy)
  await deps.store.appendAudit({ id: requestId, type: 'model_duplicated', at: now, actor, target: copy.id, detail: { from: source.id } })
  return json({ ok: true, profileId: copy.id, model: toApiModel(copy) }, 201, requestId)
}

export async function handleProfileDuplicate(request: Request, deps: RouterDeps, requestId: string, now: number, actor: string): Promise<Response> {
  const body = await readJson<{ profileId?: unknown }>(request)
  if (!body || typeof body.profileId !== 'string') return json({ error: 'invalid_profile_config', requestId }, 400, requestId)
  return duplicateProfileCore(deps, body.profileId, actor, requestId, now)
}

export async function handleApiModelConfigure(request: Request, deps: RouterDeps, url: URL, requestId: string, now: number, actor: string): Promise<Response> {
  const profileId = decodeURIComponent(url.pathname.split('/')[4] ?? '')
  const body = await readJson<ModelConfigBody>(request)
  if (!body) return json({ error: 'invalid_model_config', requestId }, 400, requestId)
  const profiles = await deps.store.listProfiles()
  const found = profiles.find((profile) => profile.id === profileId)
  if (!found) return json({ error: 'unknown_profile', requestId }, 404, requestId)
  const reassignment = await resolveMeshReassignment(deps, found, body.meshId)
  if ('error' in reassignment) return json({ error: reassignment.error, requestId }, 400, requestId)
  const existing = reassignment.profile
  const runtime = resolveRuntime(body.runtime)
  if (runtime === 'invalid_runtime') return json({ error: 'invalid_runtime', requestId }, 400, requestId)
  if (body.llamacpp !== undefined && runtime !== 'llamacpp' && existing.runtime !== 'llamacpp') return json({ error: 'invalid_model_config', requestId }, 400, requestId)
  if (body.vllm !== undefined && runtime !== 'vllm' && existing.runtime !== 'vllm') return json({ error: 'invalid_model_config', requestId }, 400, requestId)
  if (runtime === 'llamacpp' || existing.runtime === 'llamacpp') {
    const direct = configureLlamaCppProfile(existing, profiles, body)
    if ('error' in direct) return json({ error: direct.error, requestId }, direct.status, requestId)
    await deps.store.setProfile(direct.profile)
    if (reassignment.change) await deps.store.appendAudit({ id: crypto.randomUUID(), type: 'model_mesh_assigned', at: now, actor: actor, target: direct.profile.id, detail: { ...reassignment.change } })
    await deps.store.appendAudit({ id: requestId, type: 'profile_configured', at: now, actor: actor, target: direct.profile.id, detail: { contextWindow: direct.settings.contextWindow, modelRef: direct.settings.modelRef, runtime: 'llamacpp' } })
    return json({ ok: true, model: toApiModel(direct.profile) }, 200, requestId)
  }
  if (runtime === 'vllm' || existing.runtime === 'vllm') {
    const direct = configureVllmProfile(existing, profiles, body)
    if ('error' in direct) return json({ error: direct.error, requestId }, direct.status, requestId)
    await deps.store.setProfile(direct.profile)
    if (reassignment.change) await deps.store.appendAudit({ id: crypto.randomUUID(), type: 'model_mesh_assigned', at: now, actor: actor, target: direct.profile.id, detail: { ...reassignment.change } })
    await deps.store.appendAudit({ id: requestId, type: 'profile_configured', at: now, actor: actor, target: direct.profile.id, detail: { contextWindow: direct.settings.contextWindow, modelRef: direct.settings.hfRepo, runtime: 'vllm' } })
    return json({ ok: true, model: toApiModel(direct.profile) }, 200, requestId)
  }
  const contextWindow = body.contextWindow ?? existing.contextWindow
  if (!Number.isInteger(contextWindow) || contextWindow < 0) return json({ error: 'invalid_context_window', requestId }, 400, requestId)
  const maxVram = resolveMaxVram(body.maxVramGb)
  if (maxVram === INVALID_MAX_VRAM) return json({ error: 'invalid_max_vram', requestId }, 400, requestId)
  if (existing.runtime !== 'meshllm' || !existing.meshllm) return json({ error: 'invalid_model_config', requestId }, 400, requestId)
  let meshllm = existing.meshllm
  let upstreamModel = existing.upstreamModel
  if (body.modelRef !== undefined) {
    const modelRef = typeof body.modelRef === 'string' ? body.modelRef.trim() : ''
    if (!modelRef) return json({ error: 'invalid_model_ref', requestId }, 400, requestId)
    meshllm = { ...meshllm, modelRef }
    upstreamModel = modelRef
  }
  if (maxVram !== undefined) meshllm = { ...meshllm, maxVramGb: maxVram }
  const tunables = resolveMeshllmTunables(meshllm, body)
  if ('error' in tunables) return json({ error: tunables.error, requestId }, 400, requestId)
  meshllm = tunables.meshllm
  // Rename parity with the console: name sets the display name; callName sets this
  // model's own public alias (kept alongside the shared codeflare-mesh alias), with
  // the same non-empty / not-reserved / no-collision rules.
  let displayName = existing.displayName
  if (body.name !== undefined) {
    const name = typeof body.name === 'string' ? body.name.trim() : ''
    if (!name) return json({ error: 'invalid_display_name', requestId }, 400, requestId)
    displayName = name
  }
  let publicAliases = existing.publicAliases
  if (body.callName !== undefined) {
    const resolved = resolveCallNameAliases(existing, body.callName, profiles)
    if (!Array.isArray(resolved)) return json({ error: (resolved as { error: string }).error, requestId }, (resolved as { status: number }).status, requestId)
    publicAliases = resolved
  }
  const updated: ModelProfile = { ...existing, contextWindow, upstreamModel, meshllm, displayName, publicAliases, version: existing.version + 1 }
  await deps.store.setProfile(updated)
  if (reassignment.change) await deps.store.appendAudit({ id: crypto.randomUUID(), type: 'model_mesh_assigned', at: now, actor: actor, target: updated.id, detail: { ...reassignment.change } })
  await deps.store.appendAudit({ id: requestId, type: 'profile_configured', at: now, actor: actor, target: updated.id, detail: { contextWindow, modelRef: meshllm.modelRef } })
  return json({ ok: true, model: toApiModel(updated) }, 200, requestId)
}

export async function handleApiModelEnable(deps: RouterDeps, url: URL, requestId: string, now: number, actor: string): Promise<Response> {
  const profileId = decodeURIComponent(url.pathname.split('/')[4] ?? '')
  const activation = singleActiveActivation(await deps.store.listProfiles(), profileId)
  if (!activation) return json({ error: 'unknown_profile', requestId }, 404, requestId)
  for (const profile of activation.deactivated) await deps.store.setProfile(profile)
  await deps.store.setProfile(activation.activated)
  const deactivatedIds = activation.deactivated.map((profile) => profile.id)
  await deps.store.appendAudit({ id: requestId, type: 'profile_activated', at: now, actor: actor, target: profileId, detail: { deactivated: deactivatedIds } })
  return json({ ok: true, activated: activation.activated.id, deactivated: deactivatedIds }, 200, requestId)
}

export async function handleApiModelDisable(deps: RouterDeps, url: URL, requestId: string, now: number, actor: string): Promise<Response> {
  const profileId = decodeURIComponent(url.pathname.split('/')[4] ?? '')
  const existing = (await deps.store.listProfiles()).find((profile) => profile.id === profileId)
  if (!existing) return json({ error: 'unknown_profile', requestId }, 404, requestId)
  await deps.store.setActiveProfile(profileId, 0)
  await deps.store.appendAudit({ id: requestId, type: 'profile_rollout', at: now, actor: actor, target: profileId, detail: { rolloutPercent: 0 } })
  return json({ ok: true, id: profileId }, 200, requestId)
}
