/**
 * read-only user console contracts.
 *
 * One slice of the console dashboard suite; shared fixtures live in
 * `./admin-ui-test-support`.
 */
import { dashboardHarness, statusFixture } from './admin-ui-test-support'
import { describe, expect, it } from 'vitest'

describe('read-only user console contracts', () => {

  it('REQ-ADM-017 hides every configuration section and keeps only overview and playground for the user role', async () => {
    const harness = await dashboardHarness({ status: statusFixture({ viewerRole: 'user' }) })
    expect(harness.byId('overview').hidden).toBe(false)
    expect(harness.byId('playground').hidden).toBe(false)
    for (const section of ['nodes', 'models', 'routing', 'settings']) {
      expect(harness.byId(section).hidden).toBe(true)
    }
  })


  it('REQ-ADM-017 leaves every section visible for the admin role', async () => {
    const harness = await dashboardHarness({ status: statusFixture({ viewerRole: 'admin' }) })
    for (const section of ['overview', 'nodes', 'models', 'routing', 'playground', 'settings']) {
      expect(harness.byId(section).hidden).toBe(false)
    }
  })
})
