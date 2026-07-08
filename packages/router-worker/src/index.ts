import { RegistryDO, SessionAffinityDO } from './durable'
import { createRouter } from './router'
import { StoreScheduler } from './scheduler'
import { D1Store } from './store'
import type { RouterEnv } from './types'

export { RegistryDO, SessionAffinityDO }

export default {
  async fetch(request: Request, env: RouterEnv): Promise<Response> {
    const router = createRouter({
      store: new D1Store(env.DB),
      scheduler: new StoreScheduler(new D1Store(env.DB)),
      mesh: env.MESH,
      env
    })
    return await router(request)
  }
}

export const INDEX_ANCHORS = {
  REQ_GWY_001: 'REQ-GWY-001'
} as const
