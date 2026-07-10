import { formatCloudflareApiErrors, type CloudflareApiError } from './cloudflare-api'

export const ADMIN_APP_NAME = 'inference-mesh-admin'
export const BYPASS_APP_NAME = 'inference-mesh-machine-bypass'
// Cloudflare Access caps the destinations per app; keep this at or below 5. The two
// installer paths (/install.sh, /install.ps1) collapse into one /install* wildcard so the
// control-plane /api/v1/* bypass fits without exceeding the limit.
export const MACHINE_BYPASS_SUFFIXES = ['/v1/*', '/api/v1/*', '/node/*', '/health', '/install*'] as const

export interface AccessProvisionRequest {
  readonly accountId: string
  readonly hostname: string
  readonly workerName: string
  readonly adminEmails: readonly string[]
  readonly adminGroups: readonly string[]
  readonly userEmails: readonly string[]
  readonly userGroups: readonly string[]
}

export interface AccessProvisionResult {
  readonly teamDomain: string
  readonly audience: string
  readonly appId: string
  readonly bypassAppId: string
  readonly adminEmails: readonly string[]
  readonly adminGroups: readonly string[]
  readonly userEmails: readonly string[]
  readonly userGroups: readonly string[]
  /** True when no user set is configured: the console is open to everyone in the Access org as read-only. */
  readonly usersOpen: boolean
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

interface AccessGroupRecord {
  readonly id: string
  readonly name?: string
}

interface OrganizationRecord {
  readonly auth_domain?: string
}

export class CloudflareAccessClient {
  constructor(private readonly token: string, private readonly fetcher: typeof fetch = fetch) {}

  /**
   * REQ-ADM-012 / REQ-SEC-010: provision the console Access app with an allow
   * policy covering the admin AND user sets. Emails become managed Access groups
   * (`<worker>-admins` / `<worker>-users`); named groups are referenced by the
   * operator's existing Access groups. When no user set is configured the policy
   * opens to everyone — the mesh's own role check then grants read-only `user` to
   * whoever passes Access. Upserts by managed name so re-runs are idempotent.
   */
  async provisionAccess(input: AccessProvisionRequest): Promise<AccessProvisionResult> {
    const teamDomain = await this.teamDomain(input.accountId)
    const apps = await this.listApps(input.accountId)
    const groups = await this.listGroups(input.accountId)

    const adminGroupIds: string[] = []
    const userGroupIds: string[] = []
    if (input.adminEmails.length > 0) adminGroupIds.push(await this.upsertGroup(input.accountId, groups, `${input.workerName}-admins`, input.adminEmails))
    if (input.userEmails.length > 0) userGroupIds.push(await this.upsertGroup(input.accountId, groups, `${input.workerName}-users`, input.userEmails))
    for (const name of input.adminGroups) {
      const id = groups.find((group) => group.name === name)?.id
      if (id) adminGroupIds.push(id)
    }
    for (const name of input.userGroups) {
      const id = groups.find((group) => group.name === name)?.id
      if (id) userGroupIds.push(id)
    }
    if (adminGroupIds.length === 0) throw new Error('No admin Access group resolved: configure at least one admin email or an existing Access group name')

    const usersOpen = input.userEmails.length === 0 && input.userGroups.length === 0
    const include = usersOpen
      ? [{ everyone: {} }]
      : [...adminGroupIds, ...userGroupIds].map((id) => ({ group: { id } }))

    const adminApp = await this.upsertApp(input.accountId, apps, {
      name: ADMIN_APP_NAME,
      domain: input.hostname,
      type: 'self_hosted',
      session_duration: '24h',
      skip_interstitial: true
    })
    await this.upsertPolicy(input.accountId, adminApp.app.id, {
      name: 'Allow console',
      decision: 'allow',
      include
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

    const audience = adminApp.app.aud
    if (!audience) throw new Error('Cloudflare Access application returned no audience')
    return {
      teamDomain,
      audience,
      appId: adminApp.app.id,
      bypassAppId: bypassApp.app.id,
      adminEmails: input.adminEmails,
      adminGroups: input.adminGroups,
      userEmails: input.userEmails,
      userGroups: input.userGroups,
      usersOpen
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

  private async listGroups(accountId: string): Promise<readonly AccessGroupRecord[]> {
    const result = await this.accountRequest<unknown>(accountId, '/access/groups', 'GET')
    return Array.isArray(result) ? result as readonly AccessGroupRecord[] : []
  }

  /** Upsert a managed email Access group by name, returning its id. */
  private async upsertGroup(
    accountId: string,
    groups: readonly AccessGroupRecord[],
    name: string,
    emails: readonly string[]
  ): Promise<string> {
    const body = { name, include: emails.map((email) => ({ email: { email } })) }
    const existing = groups.find((group) => group.name === name)
    if (existing) {
      await this.accountRequest(accountId, `/access/groups/${existing.id}`, 'PUT', body)
      return existing.id
    }
    const created = await this.accountRequest<AccessGroupRecord>(accountId, '/access/groups', 'POST', body)
    return created.id
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
    // Free-call the fetcher: invoking the global fetch as a method (this.fetcher(...)) throws
    // "illegal invocation" on Workers because fetch must keep its native receiver.
    const fetcher = this.fetcher
    const response = await fetcher(`https://api.cloudflare.com/client/v4/accounts/${accountId}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {})
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {})
    })
    const payload = await response.json() as { readonly success: boolean; readonly result: T; readonly errors?: readonly CloudflareApiError[] }
    if (!response.ok || payload.success === false) throw new Error(`Cloudflare Access API failed: ${response.status}${formatCloudflareApiErrors(payload.errors)}`)
    return payload.result
  }
}

export const ACCESS_PROVISIONING_ANCHORS = {
  REQ_ADM_012: 'REQ-ADM-012',
  REQ_SEC_010: 'REQ-SEC-010'
} as const
