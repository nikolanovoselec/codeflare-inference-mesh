import { describe, expect, it } from 'vitest'
import { CloudflareAccessClient, MACHINE_BYPASS_SUFFIXES, type AccessProvisionResult } from './access-provisioning'

const ACCOUNT = 'acct-1'
const HOSTNAME = 'mesh.example.com'
const EMAILS = ['owner@example.com', 'sre@example.com'] as const

interface RecordedCall {
  readonly method: string
  readonly url: string
  readonly body: unknown
}

interface FakeApiOptions {
  readonly existingApps?: readonly Record<string, unknown>[]
  readonly existingPolicies?: Readonly<Record<string, readonly Record<string, unknown>[]>>
  readonly failBypassPolicy?: boolean
}

function fakeAccessApi(calls: RecordedCall[], options: FakeApiOptions = {}): typeof fetch {
  let appCounter = 0
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

async function provision(calls: RecordedCall[], options: FakeApiOptions = {}): Promise<AccessProvisionResult> {
  const client = new CloudflareAccessClient('token', fakeAccessApi(calls, options))
  return await client.provisionAccess({ accountId: ACCOUNT, hostname: HOSTNAME, adminEmails: [...EMAILS] })
}

// AccessProvisioningTestAnchor
describe('access provisioning contracts', () => {
  it('REQ-ADM-012 creates the admin app with an allow policy containing exactly the captured emails', async () => {
    const calls: RecordedCall[] = []
    await provision(calls)
    const appCreate = calls.find((call) => call.method === 'POST' && call.url.endsWith('/access/apps') && (call.body as { domain?: string }).domain === HOSTNAME)
    expect(appCreate).toBeDefined()
    expect(appCreate?.body).toMatchObject({ type: 'self_hosted', domain: HOSTNAME })
    const policyCreate = calls.find((call) => call.method === 'POST' && call.url.includes('/policies') && (call.body as { decision?: string }).decision === 'allow')
    expect((policyCreate?.body as { include: unknown }).include).toEqual(EMAILS.map((email) => ({ email: { email } })))
  })

  it('REQ-ADM-012 creates bypass coverage for machine paths with an everyone bypass policy', async () => {
    const calls: RecordedCall[] = []
    await provision(calls)
    const bypassCreate = calls.find((call) => call.method === 'POST' && call.url.endsWith('/access/apps') && (call.body as { domain?: string }).domain !== HOSTNAME)
    expect(bypassCreate).toBeDefined()
    const destinations = (bypassCreate?.body as { destinations: readonly { uri: string }[] }).destinations.map((entry) => entry.uri)
    for (const suffix of MACHINE_BYPASS_SUFFIXES) expect(destinations).toContain(`${HOSTNAME}${suffix}`)
    const bypassPolicy = calls.find((call) => call.method === 'POST' && call.url.includes('/policies') && (call.body as { decision?: string }).decision === 'bypass')
    expect((bypassPolicy?.body as { include: unknown }).include).toEqual([{ everyone: {} }])
  })

  it('REQ-ADM-012 removes the bypass app when its bypass policy cannot be created', async () => {
    const calls: RecordedCall[] = []
    await expect(provision(calls, { failBypassPolicy: true })).rejects.toThrow()
    const bypassCreate = calls.find((call) => call.method === 'POST' && call.url.endsWith('/access/apps') && (call.body as { domain?: string }).domain !== HOSTNAME)
    const createdId = 'created-2'
    expect(bypassCreate).toBeDefined()
    const rollback = calls.find((call) => call.method === 'DELETE' && call.url.endsWith(`/access/apps/${createdId}`))
    expect(rollback).toBeDefined()
  })

  it('REQ-ADM-012 updates existing managed applications instead of duplicating them', async () => {
    const calls: RecordedCall[] = []
    await provision(calls, {
      existingApps: [
        { id: 'app-admin', aud: 'aud-admin', name: 'inference-mesh-admin', domain: HOSTNAME },
        { id: 'app-bypass', aud: 'aud-bypass', name: 'inference-mesh-machine-bypass', domain: `${HOSTNAME}/v1/*` }
      ],
      existingPolicies: {
        'app-admin': [{ id: 'pol-admin', name: 'Allow admins', decision: 'allow', include: [] }],
        'app-bypass': [{ id: 'pol-bypass', name: 'Machine bypass', decision: 'bypass', include: [{ everyone: {} }] }]
      }
    })
    expect(calls.filter((call) => call.method === 'POST' && call.url.endsWith('/access/apps'))).toHaveLength(0)
    const adminUpdate = calls.find((call) => call.method === 'PUT' && call.url.endsWith('/access/apps/app-admin'))
    expect(adminUpdate).toBeDefined()
    const policyUpdate = calls.find((call) => call.method === 'PUT' && call.url.includes('/access/apps/app-admin/policies/pol-admin'))
    expect((policyUpdate?.body as { include: unknown }).include).toEqual(EMAILS.map((email) => ({ email: { email } })))
  })

  it('REQ-ADM-012 returns the team domain, audience, and application identifiers for durable storage', async () => {
    const calls: RecordedCall[] = []
    const result = await provision(calls)
    expect(result.teamDomain).toBe('example-team.cloudflareaccess.com')
    expect(result.audience).toBe('aud-created-1')
    expect(result.appId).toBe('created-1')
    expect(result.bypassAppId).toBe('created-2')
    expect(result.adminEmails).toEqual([...EMAILS])
  })
})
