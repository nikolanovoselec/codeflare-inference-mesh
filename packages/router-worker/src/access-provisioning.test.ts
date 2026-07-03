import { describe, expect, it } from 'vitest'
import { CloudflareAccessClient, MACHINE_BYPASS_SUFFIXES, type AccessProvisionRequest, type AccessProvisionResult } from './access-provisioning'

const ACCOUNT = 'acct-1'
const HOSTNAME = 'mesh.example.com'
const WORKER = 'router'

interface RecordedCall {
  readonly method: string
  readonly url: string
  readonly body: unknown
}

interface FakeApiOptions {
  readonly existingApps?: readonly Record<string, unknown>[]
  readonly existingGroups?: readonly Record<string, unknown>[]
  readonly existingPolicies?: Readonly<Record<string, readonly Record<string, unknown>[]>>
  readonly failBypassPolicy?: boolean
}

function fakeAccessApi(calls: RecordedCall[], options: FakeApiOptions = {}): typeof fetch {
  let appCounter = 0
  let groupCounter = 0
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ method: request.method, url: request.url, body })
    const url = request.url

    if (url.endsWith('/access/organizations') && request.method === 'GET') {
      return Response.json({ success: true, result: { auth_domain: 'example-team.cloudflareaccess.com' } })
    }
    if (url.endsWith('/access/apps') && request.method === 'GET') {
      return Response.json({ success: true, result: options.existingApps ?? [] })
    }
    if (url.endsWith('/access/apps') && request.method === 'POST') {
      appCounter += 1
      return Response.json({ success: true, result: { id: `created-${appCounter}`, aud: `aud-created-${appCounter}` } })
    }
    if (/\/access\/apps\/[^/]+$/.test(url) && request.method === 'PUT') {
      const id = url.split('/').pop() ?? ''
      return Response.json({ success: true, result: { id, aud: `aud-${id}` } })
    }
    if (/\/access\/apps\/[^/]+$/.test(url) && request.method === 'DELETE') {
      return Response.json({ success: true, result: { id: url.split('/').pop() } })
    }
    if (url.endsWith('/access/groups') && request.method === 'GET') {
      return Response.json({ success: true, result: options.existingGroups ?? [] })
    }
    if (url.endsWith('/access/groups') && request.method === 'POST') {
      groupCounter += 1
      return Response.json({ success: true, result: { id: `group-created-${groupCounter}`, name: (body as { name?: string })?.name } })
    }
    if (/\/access\/groups\/[^/]+$/.test(url) && request.method === 'PUT') {
      return Response.json({ success: true, result: { id: url.split('/').pop() } })
    }
    if (url.includes('/policies') && request.method === 'GET') {
      const appId = url.split('/access/apps/')[1]?.split('/')[0] ?? ''
      return Response.json({ success: true, result: options.existingPolicies?.[appId] ?? [] })
    }
    if (url.includes('/policies') && (request.method === 'POST' || request.method === 'PUT')) {
      const decision = (body as { decision?: string } | undefined)?.decision
      if (options.failBypassPolicy && decision === 'bypass') {
        return Response.json({ success: false, errors: [{ message: 'policy rejected' }] }, { status: 400 })
      }
      return Response.json({ success: true, result: { id: 'pol-1' } })
    }
    return Response.json({ success: false }, { status: 404 })
  }) as typeof fetch
}

function baseRequest(overrides: Partial<AccessProvisionRequest> = {}): AccessProvisionRequest {
  return {
    accountId: ACCOUNT,
    hostname: HOSTNAME,
    workerName: WORKER,
    adminEmails: ['owner@example.com'],
    adminGroups: [],
    userEmails: [],
    userGroups: [],
    ...overrides
  }
}

async function provision(calls: RecordedCall[], request: Partial<AccessProvisionRequest> = {}, options: FakeApiOptions = {}): Promise<AccessProvisionResult> {
  const client = new CloudflareAccessClient('token', fakeAccessApi(calls, options))
  return await client.provisionAccess(baseRequest(request))
}

// AccessProvisioningTestAnchor
describe('access provisioning contracts', () => {
  it('REQ-SEC-010 turns admin emails into a managed Access group whose include lists exactly those emails', async () => {
    const calls: RecordedCall[] = []
    await provision(calls, { adminEmails: ['owner@example.com', 'sre@example.com'], userEmails: ['viewer@example.com'] })
    const adminGroup = calls.find((call) => call.method === 'POST' && call.url.endsWith('/access/groups') && (call.body as { name?: string }).name === `${WORKER}-admins`)
    expect(adminGroup).toBeDefined()
    expect((adminGroup?.body as { include: unknown }).include).toEqual([
      { email: { email: 'owner@example.com' } },
      { email: { email: 'sre@example.com' } }
    ])
    const userGroup = calls.find((call) => call.method === 'POST' && call.url.endsWith('/access/groups') && (call.body as { name?: string }).name === `${WORKER}-users`)
    expect((userGroup?.body as { include: unknown }).include).toEqual([{ email: { email: 'viewer@example.com' } }])
  })

  it('REQ-SEC-010 gates the console app on the admin and user Access groups when a user set exists', async () => {
    const calls: RecordedCall[] = []
    await provision(calls, { adminEmails: ['owner@example.com'], userEmails: ['viewer@example.com'] })
    const policyCreate = calls.find((call) => call.method === 'POST' && call.url.includes('/policies') && (call.body as { decision?: string }).decision === 'allow')
    expect((policyCreate?.body as { include: unknown }).include).toEqual([
      { group: { id: 'group-created-1' } },
      { group: { id: 'group-created-2' } }
    ])
  })

  it('REQ-SEC-010 references an operator-managed Access group by name for admins', async () => {
    const calls: RecordedCall[] = []
    await provision(
      calls,
      { adminEmails: [], adminGroups: ['platform-admins'], userGroups: ['platform-viewers'] },
      { existingGroups: [{ id: 'grp-admin', name: 'platform-admins' }, { id: 'grp-view', name: 'platform-viewers' }] }
    )
    // No managed email group is created when only named groups are supplied.
    expect(calls.filter((call) => call.method === 'POST' && call.url.endsWith('/access/groups'))).toHaveLength(0)
    const policyCreate = calls.find((call) => call.method === 'POST' && call.url.includes('/policies') && (call.body as { decision?: string }).decision === 'allow')
    expect((policyCreate?.body as { include: unknown }).include).toEqual([
      { group: { id: 'grp-admin' } },
      { group: { id: 'grp-view' } }
    ])
  })

  it('REQ-SEC-010 opens the console policy to everyone when no user set is configured', async () => {
    const calls: RecordedCall[] = []
    const result = await provision(calls, { adminEmails: ['owner@example.com'] })
    const policyCreate = calls.find((call) => call.method === 'POST' && call.url.includes('/policies') && (call.body as { decision?: string }).decision === 'allow')
    expect((policyCreate?.body as { include: unknown }).include).toEqual([{ everyone: {} }])
    expect(result.usersOpen).toBe(true)
  })

  it('REQ-SEC-010 refuses to provision when no admin email or group resolves', async () => {
    const calls: RecordedCall[] = []
    await expect(provision(calls, { adminEmails: [], adminGroups: ['missing-group'] })).rejects.toThrow()
  })

  it('REQ-ADM-012 creates the admin app and bypass coverage for machine paths with an everyone bypass policy', async () => {
    const calls: RecordedCall[] = []
    await provision(calls, { adminEmails: ['owner@example.com'] })
    const appCreate = calls.find((call) => call.method === 'POST' && call.url.endsWith('/access/apps') && (call.body as { domain?: string }).domain === HOSTNAME)
    expect(appCreate?.body).toMatchObject({ type: 'self_hosted', domain: HOSTNAME })
    const bypassCreate = calls.find((call) => call.method === 'POST' && call.url.endsWith('/access/apps') && (call.body as { domain?: string }).domain !== HOSTNAME)
    const destinations = (bypassCreate?.body as { destinations: readonly { uri: string }[] }).destinations.map((entry) => entry.uri)
    for (const suffix of MACHINE_BYPASS_SUFFIXES) expect(destinations).toContain(`${HOSTNAME}${suffix}`)
    const bypassPolicy = calls.find((call) => call.method === 'POST' && call.url.includes('/policies') && (call.body as { decision?: string }).decision === 'bypass')
    expect((bypassPolicy?.body as { include: unknown }).include).toEqual([{ everyone: {} }])
  })

  it('REQ-ADM-012 removes the bypass app when its bypass policy cannot be created', async () => {
    const calls: RecordedCall[] = []
    await expect(provision(calls, { adminEmails: ['owner@example.com'] }, { failBypassPolicy: true })).rejects.toThrow()
    const rollback = calls.find((call) => call.method === 'DELETE' && call.url.endsWith('/access/apps/created-2'))
    expect(rollback).toBeDefined()
  })

  it('REQ-ADM-012 updates existing managed applications instead of duplicating them', async () => {
    const calls: RecordedCall[] = []
    await provision(
      calls,
      { adminEmails: ['owner@example.com'] },
      {
        existingApps: [
          { id: 'app-admin', aud: 'aud-admin', name: 'inference-mesh-admin', domain: HOSTNAME },
          { id: 'app-bypass', aud: 'aud-bypass', name: 'inference-mesh-machine-bypass', domain: `${HOSTNAME}/v1/*` }
        ],
        existingGroups: [{ id: 'grp-existing-admins', name: `${WORKER}-admins` }],
        existingPolicies: {
          'app-admin': [{ id: 'pol-admin', name: 'Allow console', decision: 'allow', include: [] }],
          'app-bypass': [{ id: 'pol-bypass', name: 'Machine bypass', decision: 'bypass', include: [{ everyone: {} }] }]
        }
      }
    )
    expect(calls.filter((call) => call.method === 'POST' && call.url.endsWith('/access/apps'))).toHaveLength(0)
    expect(calls.filter((call) => call.method === 'POST' && call.url.endsWith('/access/groups'))).toHaveLength(0)
    const groupUpdate = calls.find((call) => call.method === 'PUT' && call.url.endsWith('/access/groups/grp-existing-admins'))
    expect(groupUpdate).toBeDefined()
    const adminUpdate = calls.find((call) => call.method === 'PUT' && call.url.endsWith('/access/apps/app-admin'))
    expect(adminUpdate).toBeDefined()
  })

  it('REQ-ADM-012 returns the team domain, audience, identifiers, and captured role sets for durable storage', async () => {
    const calls: RecordedCall[] = []
    const result = await provision(calls, { adminEmails: ['owner@example.com'], userEmails: ['viewer@example.com'] })
    expect(result.teamDomain).toBe('example-team.cloudflareaccess.com')
    expect(result.audience).toBe('aud-created-1')
    expect(result.appId).toBe('created-1')
    expect(result.bypassAppId).toBe('created-2')
    expect(result.adminEmails).toEqual(['owner@example.com'])
    expect(result.userEmails).toEqual(['viewer@example.com'])
    expect(result.usersOpen).toBe(false)
  })
})
