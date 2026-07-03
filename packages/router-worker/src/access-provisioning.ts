export const ADMIN_APP_NAME = 'inference-mesh-admin'
export const BYPASS_APP_NAME = 'inference-mesh-machine-bypass'
export const MACHINE_BYPASS_SUFFIXES = ['/v1/*', '/node/*', '/health', '/install.sh', '/install.ps1'] as const

export interface AccessProvisionRequest {
  readonly accountId: string
  readonly hostname: string
  readonly adminEmails: readonly string[]
}

export interface AccessProvisionResult {
  readonly teamDomain: string
  readonly audience: string
  readonly appId: string
  readonly bypassAppId: string
  readonly adminEmails: readonly string[]
}

interface AccessAppRecord {
  readonly id: string
  readonly aud?: string
  readonly name?: string
  readonly domain?: string
}

interface AccessPolicyRecord {
  readonly id: string
  readonly name?: string
  readonly decision?: string
}

interface OrganizationRecord {
  readonly auth_domain?: string
}

export class CloudflareAccessClient {
  constructor(private readonly token: string, private readonly fetcher: typeof fetch = fetch) {}

  async provisionAccess(input: AccessProvisionRequest): Promise<AccessProvisionResult> {
    const teamDomain = await this.teamDomain(input.accountId)
    const apps = await this.listApps(input.accountId)

    const adminApp = await this.upsertApp(input.accountId, apps, {
      name: ADMIN_APP_NAME,
      domain: input.hostname,
      type: 'self_hosted',
      session_duration: '24h',
      skip_interstitial: true
    })
    await this.upsertPolicy(input.accountId, adminApp.app.id, {
      name: 'Allow admins',
      decision: 'allow',
      include: input.adminEmails.map((email) => ({ email: { email } }))
    })

    const bypassApp = await this.upsertApp(input.accountId, apps, {
      name: BYPASS_APP_NAME,
      domain: `${input.hostname}${MACHINE_BYPASS_SUFFIXES[0]}`,
      destinations: MACHINE_BYPASS_SUFFIXES.map((suffix) => ({ uri: `${input.hostname}${suffix}` })),
      type: 'self_hosted',
      session_duration: '24h',
      skip_interstitial: true
    })
    try {
      await this.upsertPolicy(input.accountId, bypassApp.app.id, {
        name: 'Machine bypass',
        decision: 'bypass',
        include: [{ everyone: {} }]
      })
    } catch (error) {
      if (bypassApp.created) {
        await this.accountRequest(input.accountId, `/access/apps/${bypassApp.app.id}`, 'DELETE')
      }
      throw error
    }

    return {
      teamDomain,
      audience: adminApp.app.aud ?? '',
      appId: adminApp.app.id,
      bypassAppId: bypassApp.app.id,
      adminEmails: input.adminEmails
    }
  }

  private async teamDomain(accountId: string): Promise<string> {
    const organization = await this.accountRequest<OrganizationRecord>(accountId, '/access/organizations', 'GET')
    const domain = organization.auth_domain
    if (!domain) throw new Error('Cloudflare Access organization has no auth domain')
    return domain
  }

  private async listApps(accountId: string): Promise<readonly AccessAppRecord[]> {
    const result = await this.accountRequest<unknown>(accountId, '/access/apps', 'GET')
    return Array.isArray(result) ? result as readonly AccessAppRecord[] : []
  }

  private async upsertApp(
    accountId: string,
    apps: readonly AccessAppRecord[],
    body: Record<string, unknown> & { readonly name: string }
  ): Promise<{ readonly app: AccessAppRecord; readonly created: boolean }> {
    const existing = apps.find((app) => app.name === body.name)
    if (existing) {
      const app = await this.accountRequest<AccessAppRecord>(accountId, `/access/apps/${existing.id}`, 'PUT', body)
      return { app, created: false }
    }
    const app = await this.accountRequest<AccessAppRecord>(accountId, '/access/apps', 'POST', body)
    return { app, created: true }
  }

  private async upsertPolicy(
    accountId: string,
    appId: string,
    body: { readonly name: string; readonly decision: string; readonly include: readonly unknown[] }
  ): Promise<AccessPolicyRecord> {
    const result = await this.accountRequest<unknown>(accountId, `/access/apps/${appId}/policies`, 'GET')
    const policies = Array.isArray(result) ? result as readonly AccessPolicyRecord[] : []
    const existing = policies.find((policy) => policy.decision === body.decision)
    if (existing) {
      return await this.accountRequest<AccessPolicyRecord>(accountId, `/access/apps/${appId}/policies/${existing.id}`, 'PUT', body)
    }
    return await this.accountRequest<AccessPolicyRecord>(accountId, `/access/apps/${appId}/policies`, 'POST', body)
  }

  private async accountRequest<T>(accountId: string, path: string, method: string, body?: unknown): Promise<T> {
    const response = await this.fetcher(`https://api.cloudflare.com/client/v4/accounts/${accountId}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {})
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {})
    })
    const payload = await response.json() as { readonly success: boolean; readonly result: T }
    if (!response.ok || payload.success === false) throw new Error(`Cloudflare Access API failed: ${response.status}`)
    return payload.result
  }
}

export const ACCESS_PROVISIONING_ANCHORS = {
  REQ_ADM_012: 'REQ-ADM-012'
} as const
