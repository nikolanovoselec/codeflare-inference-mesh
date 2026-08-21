/**
 * setup token and installer contracts.
 *
 * One slice of the router's admin suite; shared fixtures live in
 * `./router-test-support`.
 */
import { bearer, routerFixture } from './router-test-support'
import { createTokenRecord } from './auth'
import { describe, expect, it } from 'vitest'
import { installerPlan, SETUP_TOKEN_PLACEHOLDER } from './installers'

describe('setup token and installer contracts', () => {

  it('REQ-ADM-003 creates setup tokens with a 24h expiration', async () => {
    const { router, store } = routerFixture()
    const setupResponse = await router(new Request('https://router.test/admin/setup', { method: 'POST' }))
    const setup = await setupResponse.json() as { adminToken: string }

    const response = await router(new Request('https://router.test/admin/setup-tokens', { method: 'POST', headers: bearer(setup.adminToken) }))
    const body = await response.json() as { setupToken: string; expiresAt: number }
    const activeSetupTokens = store.tokens.filter((token) => token.kind === 'setup' && token.active)

    expect(response.status).toBe(201)
    expect(body.setupToken).toMatch(/^setup_/)
    expect(body.expiresAt).toBe(1_700_086_400_000)
    // Claim no longer mints a setup token, so only the one created here is active.
    expect(activeSetupTokens.map((token) => token.expiresAt)).toEqual([1_700_086_400_000])
  })



  it('REQ-ADM-001 REQ-ADM-003 consumes setup tokens during node claim', async () => {
    // FirstRunSetupTokenTestAnchor
    const { router, store } = routerFixture()
    const expiredRecord = await createTokenRecord('setup', 'expired-setup', 1_699_913_599_999, undefined, 1_700_000_000_000)
    await store.putToken(expiredRecord)
    const expired = await router(new Request('https://router.test/node/claim', {
      method: 'POST',
      headers: { ...bearer('expired-setup'), 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: 'Expired Node', meshIp: '100.64.1.9', inferencePort: 8080, publicModels: ['codeflare-mesh'], activeProfileIds: ['mesh-default-qwen36-35b'], capacity: 1 })
    }))
    const setupResponse = await router(new Request('https://router.test/admin/setup', { method: 'POST' }))
    const claimAdmin = (await setupResponse.json() as { adminToken: string }).adminToken
    const setup = await (await router(new Request('https://router.test/admin/setup-tokens', { method: 'POST', headers: bearer(claimAdmin) }))).json() as { setupToken: string }
    const claim = await router(new Request('https://router.test/node/claim', {
      method: 'POST',
      headers: { ...bearer(setup.setupToken), 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: 'Node A', meshIp: '100.64.1.10', inferencePort: 8080, publicModels: ['codeflare-mesh'], activeProfileIds: ['mesh-default-qwen36-35b'], capacity: 2 })
    }))
    const consumed = await router(new Request('https://router.test/node/claim', {
      method: 'POST',
      headers: { ...bearer(setup.setupToken), 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: 'Node B', meshIp: '100.64.1.11', inferencePort: 8080, publicModels: ['codeflare-mesh'], activeProfileIds: ['mesh-default-qwen36-35b'], capacity: 2 })
    }))

    expect(expired.status).toBe(401)
    expect(claim.status).toBe(201)
    expect(consumed.status).toBe(401)
    expect(store.tokens.find((token) => token.id === expiredRecord.id)?.active).toBe(true)
    expect(store.tokens.filter((token) => token.kind === 'setup' && token.id !== expiredRecord.id).every((token) => token.active === false)).toBe(true)
    expect(store.nodes.has('node-a-100-64-1-10')).toBe(true)
  })



  it('REQ-ADM-004 returns installer commands backed by release-tagged platform artifact plans', async () => {
    const { router, store } = routerFixture({ env: { AGENT_RELEASE_TAG: 'v0.1.0-dev.1782860991', WORKER_BASE_URL: 'https://codeflare-inference-mesh-router.<your-subdomain>.workers.dev' } })
    const commandResponse = await router(new Request('https://router.test/admin/installers/linux', { headers: bearer('admin-secret') }))
    const command = await commandResponse.text()
    const scriptUrl = new URL(command.split(/\s+/).find((part) => part.startsWith('https://'))!)
    const scriptResponse = await router(new Request('https://router.test/install.sh?platform=linux'))
    const script = await scriptResponse.text()
    const fallbackScript = await (await routerFixture().router(new Request('https://router.test/install.sh?platform=linux'))).text()
    const windowsScript = await (await router(new Request('https://router.test/install.ps1'))).text()
    const linuxPlan = installerPlan('linux', 'amd64')
    const windowsPlan = installerPlan('windows', 'amd64')

    expect(commandResponse.status).toBe(200)
    expect(scriptUrl.origin).toBe('https://router.test')
    expect(scriptUrl.pathname).toBe('/install.sh')
    expect(scriptUrl.searchParams.get('platform')).toBe('linux')
    expect(script).toContain('https://github.com/nikolanovoselec/codeflare-inference-mesh/releases/download/v0.1.0-dev.1782860991')
    expect(fallbackScript).toContain('https://github.com/nikolanovoselec/codeflare-inference-mesh/releases/latest/download')
    expect(windowsScript).toContain('Register-ScheduledTask')
    expect(windowsScript).not.toContain('New-Service')
    // Windows install and its scheduled task resolve an explicit config path under ProgramData.
    expect(windowsScript).toContain('--config $ConfigPath --data-dir $StateDir')
    expect(windowsScript).toContain('-Argument "run --config $ConfigPath"')
    expect(linuxPlan).toEqual({ assetName: 'inference-mesh-agent-linux-amd64.tar.gz', extractedBinary: 'inference-mesh-agent-linux-amd64', installedBinary: 'inference-mesh-agent', checksumFile: 'checksums.txt' })
    expect(windowsPlan).toEqual({ assetName: 'inference-mesh-agent-windows-amd64.zip', extractedBinary: 'inference-mesh-agent-windows-amd64.exe', installedBinary: 'inference-mesh-agent.exe', checksumFile: 'checksums.txt' })
    // Fetching a command never mints: no orphan setup token is created on view.
    expect(store.tokens.filter((token) => token.kind === 'setup').length).toBe(0)
  })



  it('REQ-ADM-004 unix install wrapper runs the agent from an explicit config path and system state dir', async () => {
    const { router } = routerFixture({ env: { AGENT_RELEASE_TAG: 'v0.1.0-dev.test' } })
    const script = await (await router(new Request('https://router.test/install.sh?platform=linux'))).text()

    // The service resolves the same config the install step wrote, independent of $HOME.
    expect(script).toContain('mkdir -p /var/lib/inference-mesh')
    expect(script).toContain('INFERENCE_MESH_CONFIG=/var/lib/inference-mesh/config.json /usr/local/bin/inference-mesh-agent install')
    expect(script).toContain('--config /var/lib/inference-mesh/config.json --data-dir /var/lib/inference-mesh')
    expect(script).toContain('Environment=INFERENCE_MESH_CONFIG=/var/lib/inference-mesh/config.json')
    expect(script).toContain('WorkingDirectory=/var/lib/inference-mesh')
    expect(script).toContain('ExecStart=/usr/local/bin/inference-mesh-agent run --config /var/lib/inference-mesh/config.json')
    // Distro-agnostic: enrollment uses a static binary + systemd only, no distribution package manager.
    expect(script).not.toMatch(/\b(apt-get|apt|yum|dnf|pacman|zypper)\b/)
  })



  it('REQ-ADM-003 does not mint a setup token when an install command is fetched', async () => {
    const { router, store } = routerFixture()
    const first = await router(new Request('https://router.test/admin/installers/linux', { headers: bearer('admin-secret') }))
    const command = await first.text()
    // Repeat views must not accumulate tokens either.
    await router(new Request('https://router.test/admin/installers/windows', { headers: bearer('admin-secret') }))

    expect(first.status).toBe(200)
    // The command carries the placeholder, not a live setup_ token.
    expect(command).toContain(SETUP_TOKEN_PLACEHOLDER)
    expect(command).not.toMatch(/setup_[A-Za-z0-9]/)
    expect(store.tokens.filter((token) => token.kind === 'setup').length).toBe(0)
  })


})
