import { StoreScheduler } from './scheduler'
import { D1Store } from './store'
import type { RouterEnv } from './types'

export class RegistryDO implements DurableObject {
  constructor(private readonly state: DurableObjectState, private readonly env: RouterEnv) {}

  async fetch(request: Request): Promise<Response> {
    await this.state.blockConcurrencyWhile(async () => undefined)
    const url = new URL(request.url)
    const scheduler = new StoreScheduler(new D1Store(this.env.DB))
    if (request.method === 'POST' && url.pathname === '/reserve') {
      return Response.json(await scheduler.reserve(await request.json()))
    }
    if (request.method === 'POST' && url.pathname === '/release') {
      const body = await request.json() as { reservationId: string; now: number }
      await scheduler.release(body.reservationId, body.now)
      return Response.json({ ok: true })
    }
    if (request.method === 'POST' && url.pathname === '/failure') {
      const body = await request.json() as { reservationId: string; now: number }
      await scheduler.recordFailure(body.reservationId, body.now)
      return Response.json({ ok: true })
    }
    return Response.json({ error: 'not_found' }, { status: 404 })
  }
}

export const DURABLE_ANCHORS = {
  REQ_SCH_002: 'REQ-SCH-002'
} as const
