export type InstallerPlatform = 'linux' | 'macos' | 'windows'

type InstallerArch = 'amd64' | 'arm64'

export interface InstallerInput {
  readonly platform: InstallerPlatform
  readonly workerUrl: string
  readonly setupToken: string
  readonly repository: string
}

export interface InstallScriptInput {
  readonly platform: InstallerPlatform
  readonly repository: string
  readonly releaseTag?: string
}

export interface InstallerPlan {
  readonly assetName: string
  readonly extractedBinary: string
  readonly installedBinary: string
  readonly checksumFile: 'checksums.txt'
}

export function installerCommand(input: InstallerInput): string {
  const workerUrl = input.workerUrl.replace(/\/$/, '')
  if (input.platform === 'windows') {
    return `$env:ROUTER_URL=${powershellQuote(workerUrl)}; $env:SETUP_TOKEN=${powershellQuote(input.setupToken)}; iwr ${workerUrl}/install.ps1 -UseBasicParsing | iex`
  }
  const script = input.platform === 'macos' ? 'install.sh?platform=macos' : 'install.sh?platform=linux'
  return `curl -fsSL ${workerUrl}/${script} | ROUTER_URL=${shellQuote(workerUrl)} SETUP_TOKEN=${shellQuote(input.setupToken)} sh`
}

export function installScript(input: InstallScriptInput): string {
  return input.platform === 'windows' ? windowsInstallScript(input.repository, input.releaseTag) : unixInstallScript(input.platform, input.repository, input.releaseTag)
}

export function installerPlan(platform: InstallerPlatform, arch: InstallerArch): InstallerPlan {
  if (platform === 'windows') {
    return {
      assetName: `inference-mesh-agent-windows-${arch}.zip`,
      extractedBinary: `inference-mesh-agent-windows-${arch}.exe`,
      installedBinary: 'inference-mesh-agent.exe',
      checksumFile: 'checksums.txt'
    }
  }
  const os = platform === 'macos' ? 'darwin' : 'linux'
  return {
    assetName: `inference-mesh-agent-${os}-${arch}.tar.gz`,
    extractedBinary: `inference-mesh-agent-${os}-${arch}`,
    installedBinary: 'inference-mesh-agent',
    checksumFile: 'checksums.txt'
  }
}

export function validateCustomDomain(hostname: string): boolean {
  return /^(?!-)(?:[a-z0-9-]{1,63}\.)+[a-z]{2,63}$/i.test(hostname)
}

function unixInstallScript(platform: 'linux' | 'macos', repository: string, releaseTag?: string): string {
  const archExpression = platform === 'macos' ? '$(uname -m | sed s/x86_64/amd64/ | sed s/arm64/arm64/)' : '$(uname -m | sed s/x86_64/amd64/ | sed s/aarch64/arm64/)'
  const platformLiteral = platform === 'macos' ? 'macos' : 'linux'
  return `#!/bin/sh
set -eu
: "\${ROUTER_URL:?ROUTER_URL is required}"
: "\${SETUP_TOKEN:?SETUP_TOKEN is required}"
ARCH="${archExpression}"
PLATFORM="${platformLiteral}"
if [ "$PLATFORM" = "macos" ]; then OS="darwin"; else OS="linux"; fi
ASSET="inference-mesh-agent-$OS-$ARCH.tar.gz"
BIN="inference-mesh-agent-$OS-$ARCH"
BASE_URL="${releaseDownloadBase(repository, releaseTag)}"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
cd "$TMP_DIR"
curl -fsSLO "$BASE_URL/$ASSET"
curl -fsSLO "$BASE_URL/checksums.txt"
if command -v sha256sum >/dev/null 2>&1; then
  grep " $ASSET$" checksums.txt | sha256sum -c -
else
  EXPECTED="$(grep " $ASSET$" checksums.txt | awk '{print $1}')"
  ACTUAL="$(shasum -a 256 "$ASSET" | awk '{print $1}')"
  test "$EXPECTED" = "$ACTUAL"
fi
tar -xzf "$ASSET"
install -m 0755 "$BIN" /usr/local/bin/inference-mesh-agent
/usr/local/bin/inference-mesh-agent install --router "$ROUTER_URL" --setup-token "$SETUP_TOKEN"
if command -v systemctl >/dev/null 2>&1; then
  cat >/etc/systemd/system/inference-mesh-agent.service <<'UNIT'
[Unit]
Description=Codeflare Inference Mesh Agent
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/usr/local/bin/inference-mesh-agent run
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT
  systemctl daemon-reload
  systemctl enable --now inference-mesh-agent.service
elif command -v launchctl >/dev/null 2>&1; then
  cat >/Library/LaunchDaemons/com.codeflare.inference-mesh-agent.plist <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>Label</key><string>com.codeflare.inference-mesh-agent</string><key>ProgramArguments</key><array><string>/usr/local/bin/inference-mesh-agent</string><string>run</string></array><key>RunAtLoad</key><true/><key>KeepAlive</key><true/></dict></plist>
PLIST
  launchctl bootstrap system /Library/LaunchDaemons/com.codeflare.inference-mesh-agent.plist || launchctl load /Library/LaunchDaemons/com.codeflare.inference-mesh-agent.plist
fi
`
}

function windowsInstallScript(repository: string, releaseTag?: string): string {
  return `$ErrorActionPreference = 'Stop'
if (-not $env:ROUTER_URL) { throw 'ROUTER_URL is required' }
if (-not $env:SETUP_TOKEN) { throw 'SETUP_TOKEN is required' }
$Arch = if ([Environment]::Is64BitOperatingSystem) { 'amd64' } else { throw 'unsupported architecture' }
$Asset = "inference-mesh-agent-windows-$Arch.zip"
$Bin = "inference-mesh-agent-windows-$Arch.exe"
$BaseUrl = "${releaseDownloadBase(repository, releaseTag)}"
$Tmp = Join-Path ([IO.Path]::GetTempPath()) ([Guid]::NewGuid().ToString())
New-Item -ItemType Directory -Path $Tmp | Out-Null
try {
  Invoke-WebRequest "$BaseUrl/$Asset" -OutFile (Join-Path $Tmp $Asset)
  Invoke-WebRequest "$BaseUrl/checksums.txt" -OutFile (Join-Path $Tmp 'checksums.txt')
  $Expected = (Get-Content (Join-Path $Tmp 'checksums.txt') | Where-Object { $_ -like "* $Asset" } | ForEach-Object { ($_ -split '\\s+')[0] })
  $Actual = (Get-FileHash (Join-Path $Tmp $Asset) -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($Expected -ne $Actual) { throw 'checksum mismatch' }
  $InstallDir = Join-Path $env:ProgramFiles 'Codeflare Inference Mesh'
  New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
  Expand-Archive (Join-Path $Tmp $Asset) -DestinationPath $InstallDir -Force
  Copy-Item (Join-Path $InstallDir $Bin) (Join-Path $InstallDir 'inference-mesh-agent.exe') -Force
  & (Join-Path $InstallDir 'inference-mesh-agent.exe') install --router $env:ROUTER_URL --setup-token $env:SETUP_TOKEN
  if (-not (Get-Service inference-mesh-agent -ErrorAction SilentlyContinue)) {
    $BinaryPath = '"' + (Join-Path $InstallDir 'inference-mesh-agent.exe') + '" run'
    New-Service -Name inference-mesh-agent -DisplayName 'Codeflare Inference Mesh Agent' -BinaryPathName $BinaryPath -StartupType Automatic
  }
  Start-Service inference-mesh-agent
} finally {
  Remove-Item -Recurse -Force $Tmp -ErrorAction SilentlyContinue
}
`
}

function releaseDownloadBase(repository: string, releaseTag?: string): string {
  if (!releaseTag || releaseTag === 'latest' || releaseTag === 'agent-release-tag-placeholder') {
    return `https://github.com/${repository}/releases/latest/download`
  }
  return `https://github.com/${repository}/releases/download/${releaseTag}`
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`
}

function powershellQuote(value: string): string {
  return `'${value.replace(/'/g, `''`)}'`
}

export const INSTALLER_ANCHORS = {
  REQ_ADM_004: 'REQ-ADM-004',
  REQ_ADM_005: 'REQ-ADM-005'
} as const
