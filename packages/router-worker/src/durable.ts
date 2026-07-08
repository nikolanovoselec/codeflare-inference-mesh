import { decideDirectSession, type DirectSessionDecisionRequest } from './direct-affinity'
import { electSeedIfAbsent } from './mesh-state'
import { D1Store } from './store'
import type { RouterEnv } from './types'

export class RegistryDO implements DurableObject {
  constructor(private readonly state: DurableObjectState, private readonly env: RouterEnv) {}

  async fetch(request: Request): Promise<Response> {
    await this.state.blockConcurrencyWhile(async () => undefined)
    const url = new URL(request.url)
    if (request.method === 'POST' && url.pathname === '/mesh-election') {
      const body = await request.json() as { profileId: string; nodeId: string; now: number }
      return Response.json(await electSeedIfAbsent(new D1Store(this.env.DB), this.env, body.profileId, body.nodeId, body.now))
    }
    return Response.json({ error: 'not_found' }, { status: 404 })
  }
}

export class SessionAffinityDO implements DurableObject {
  constructor(private readonly state: DurableObjectState, private readonly env: RouterEnv) {}

  async fetch(request: Request): Promise<Response> {
    await this.state.blockConcurrencyWhile(async () => undefined)
    const url = new URL(request.url)
    if (request.method === 'POST' && url.pathname === '/direct-session') {
      const body = await request.json() as DirectSessionDecisionRequest
      return Response.json(await decideDirectSession(new D1Store(this.env.DB), body))
    }
    return Response.json({ error: 'not_found' }, { status: 404 })
  }
}

export const DURABLE_ANCHORS = {
  REQ_SCH_002: 'REQ-SCH-002',
  REQ_SCH_004: 'REQ-SCH-004'
} as const
