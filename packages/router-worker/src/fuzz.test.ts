import { describe, expect, it } from 'vitest'
import { isSafeMeshTarget } from './scheduler'

describe('bounded router fuzz corpus', () => {
  it('REQ-RTR-004 rejects URL-like, public, off-CIDR, or off-port destinations across malformed corpus', () => {
    const samples = [
      ['https://100.64.1.10', 443],
      ['http://10.0.0.1', 80],
      ['8.8.8.8', 8080],
      ['127.0.0.1', 8080],
      ['::1', 8080],
      ['100.64.1.10/path', 8080],
      ['100.64.1.10', 0],
      ['100.64.1.10', 70000],
      ['10.1.2.3', 8080],
      ['172.16.0.1', 8080],
      ['192.168.1.5', 8080],
      ['100.64.1.10', 443]
    ] as const

    for (const [host, port] of samples) {
      expect(isSafeMeshTarget(host, port)).toBe(false)
    }
  })

  it('REQ-RTR-004 accepts configured CGNAT Mesh destinations on allowed proxy ports', () => {
    const samples = [
      ['100.64.1.10', 8080],
      ['100.96.0.26', 11434]
    ] as const

    for (const [host, port] of samples) {
      expect(isSafeMeshTarget(host, port)).toBe(true)
    }
  })
})
