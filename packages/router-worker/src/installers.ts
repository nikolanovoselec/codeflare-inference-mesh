export type InstallerPlatform = 'linux' | 'macos' | 'windows'

export interface InstallerInput {
  readonly platform: InstallerPlatform
  readonly workerUrl: string
  readonly setupToken: string
  readonly repository: string
}

export function installerCommand(input: InstallerInput): string {
  const baseUrl = `https://github.com/${input.repository}/releases/latest/download`
  if (input.platform === 'windows') {
    return `powershell -NoProfile -ExecutionPolicy Bypass -Command "iwr ${baseUrl}/inference-mesh-agent-windows-amd64.zip -OutFile agent.zip; Expand-Archive agent.zip -DestinationPath agent; .\\agent\\inference-mesh-agent.exe install --router ${input.workerUrl} --setup-token ${input.setupToken}"`
  }
  if (input.platform === 'macos') {
    return `curl -fsSL ${baseUrl}/inference-mesh-agent-darwin-arm64.tar.gz | tar -xz && ./inference-mesh-agent install --router ${input.workerUrl} --setup-token ${input.setupToken}`
  }
  return `curl -fsSL ${baseUrl}/inference-mesh-agent-linux-amd64.tar.gz | tar -xz && ./inference-mesh-agent install --router ${input.workerUrl} --setup-token ${input.setupToken}`
}

export function validateCustomDomain(hostname: string): boolean {
  return /^(?!-)(?:[a-z0-9-]{1,63}\.)+[a-z]{2,63}$/i.test(hostname)
}

export const INSTALLER_ANCHORS = {
  REQ_ADM_004: 'REQ-ADM-004',
  REQ_ADM_005: 'REQ-ADM-005'
} as const
