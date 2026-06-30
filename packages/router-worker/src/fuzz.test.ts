import { describe, expect, it } from 'vitest'
import { isSafeMeshTarget } from './scheduler'

describe('bounded router fuzz corpus', () => {
  it('REQ-RTR-004 rejects URL-like or public destinations across malformed corpus', () => {
    const samples = [
      ['https://100.64.1.10', 443],
      ['http://10.0.0.1', 80],
      ['8.8.8.8', 8080],
      ['127.0.0.1', 8080],
      ['::1', 8080],
      ['100.64.1.10/path', 8080],
      ['100.64.1.10', 0],
      ['100.64.1.10', 70000]
    ] as const

    for (const [host, port] of samples) {
      expect(isSafeMeshTarget(host, port)).toBe(false)
    }
  })

  it('REQ-RTR-004 accepts private IPv4 and CGNAT Mesh destinations within valid port range', () => {
    const samples = [
      ['100.64.1.10', 8080],
      ['10.1.2.3', 1],
      ['172.16.0.1', 443],
      ['172.31.255.254', 65535],
      ['192.168.1.5', 17777]
    ] as const

    for (const [host, port] of samples) {
      expect(isSafeMeshTarget(host, port)).toBe(true)
    }
  })
})
