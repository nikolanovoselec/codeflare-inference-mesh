/**
 * Route table types and matching.
 *
 * The router's dispatch used to be a chain of ~76 sequential
 * `if (pathname === X && method === Y) return handleZ(...)` branches, which made
 * the auth matrix impossible to read: the credential a route required was
 * private to each handler's first two lines. Modelling routes as data puts
 * method, path, and required credential in one inspectable list.
 *
 * Leaf module with no router imports, so `router.ts` can depend on it without a
 * cycle. `Route` is generic over the handler context for the same reason.
 */

export type HttpMethod = 'GET' | 'HEAD' | 'POST' | 'PUT' | 'DELETE'

/**
 * The credential class a route requires. These are the classes the handlers
 * actually enforce, not a tidier set: `/node/claim` reads as public but requires
 * a one-time setup token, and `/admin/setup` is open only until the first admin
 * token exists. Naming them separately keeps the table honest.
 *
 * Every non-`open` value is proven by the auth-matrix test in `router-routing.test.ts`,
 * which drives each route with no credential and asserts 401.
 */
export type RouteGate =
  /** No credential. Health and the public install scripts. */
  | 'open'
  /** AI Gateway provider token on the data plane. */
  | 'provider'
  /** One-time enrollment token, presented once by a node at claim. */
  | 'setup'
  /** Per-node bearer token issued at claim. */
  | 'node'
  /** The `ADMIN_RECOVERY_TOKEN` environment secret. */
  | 'recovery'
  /** Open while no active admin token exists, admin once the deployment is claimed. */
  | 'bootstrapOrAdmin'
  /** Console admin role. */
  | 'admin'
  /** Any verified console role, admin or read-only user. */
  | 'user'
  /** Console admin, or the bootstrap admin token, for automation-key management. */
  | 'keyAdmin'
  /** Scoped automation key on the `/api/v1` control plane. */
  | 'automation'
  /** Either a console admin or an automation key. */
  | 'adminOrAutomation'

export interface Route<Context> {
  readonly method: HttpMethod
  /** Exact pathname, or a pattern tested against the pathname. */
  readonly path: string | RegExp
  readonly gate: RouteGate
  readonly handler: (context: Context) => Promise<Response>
}

/**
 * First match wins, preserving the order semantics of the `if` chain this
 * replaced. Callers must keep the table in the intended precedence order.
 */
export function matchRoute<Context>(
  routes: readonly Route<Context>[],
  method: string,
  pathname: string
): Route<Context> | undefined {
  return routes.find(
    (route) => route.method === method && (typeof route.path === 'string' ? route.path === pathname : route.path.test(pathname))
  )
}
