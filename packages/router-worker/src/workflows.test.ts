import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import YAML from 'yaml'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

type Step = {
  readonly name?: string
  readonly run?: string
  readonly uses?: string
  readonly with?: Record<string, unknown>
  readonly 'working-directory'?: string
}

type Job = {
  readonly if?: string
  readonly env?: Record<string, string>
  readonly permissions?: Record<string, string>
  readonly needs?: readonly string[]
  readonly 'timeout-minutes'?: number
  readonly steps: readonly Step[]
}

type Workflow = {
  readonly on: Record<string, unknown>
  readonly permissions?: Record<string, string>
  readonly jobs: Record<string, Job>
}

function workflow(name: string): Workflow {
  return YAML.parse(readFileSync(resolve(repoRoot, '.github/workflows', name), 'utf8')) as Workflow
}

function stepRuns(job: Job): readonly string[] {
  return job.steps.map((step) => step.run).filter((run): run is string => typeof run === 'string')
}

function runLines(job: Job): readonly string[] {
  return stepRuns(job).flatMap((run) => run.split('\n').map((line) => line.trim()).filter(Boolean))
}

function stepUses(job: Job): readonly string[] {
  return job.steps.map((step) => step.uses).filter((use): use is string => typeof use === 'string')
}

describe('workflow contract values', () => {
  it('REQ-REL-001 runs PR, main-push, manual, router, agent, packaging, security, and aggregate test checks', () => {
    const ci = workflow('ci.yml')

    expect(Object.keys(ci.on).sort()).toEqual(['pull_request', 'push', 'workflow_dispatch'])
    expect(ci.on.pull_request).toEqual({ branches: ['main'] })
    expect(ci.on.push).toEqual({ branches: ['main', 'develop'] })
    expect(Object.keys(ci.jobs).sort()).toEqual(['agent', 'dependency-review', 'packaging', 'router', 'test', 'vulnerability-checks'])
    expect(ci.jobs.test!.needs).toEqual(['router', 'agent', 'packaging', 'dependency-review', 'vulnerability-checks'])

    expect(stepUses(ci.jobs.router!)).toEqual(expect.arrayContaining(['actions/checkout@v7.0.0', 'actions/setup-node@v6.4.0']))
    expect(ci.jobs.router!.steps.find((step) => step.uses === 'actions/setup-node@v6.4.0')?.with).toEqual({ 'node-version': '24' })
    expect(stepRuns(ci.jobs.router!)).toEqual(expect.arrayContaining([
      'npm install',
      'npm run lint --workspace packages/router-worker',
      'npm run test --workspace packages/router-worker',
      'npm run typecheck --workspace packages/router-worker',
      'npm run cf-types --workspace packages/router-worker',
      'npm run dry-run --workspace packages/router-worker'
    ]))
    expect(stepUses(ci.jobs.agent!)).toEqual(expect.arrayContaining(['actions/checkout@v7.0.0', 'actions/setup-go@v6.5.0']))
    expect(ci.jobs.agent!.steps.find((step) => step.uses === 'actions/setup-go@v6.5.0')?.with).toEqual({ 'go-version': '1.26.4' })
    expect(stepRuns(ci.jobs.agent!)).toEqual(expect.arrayContaining(['go test ./...', 'go vet ./...', 'go test -race ./...', 'go build ./cmd/inference-mesh-agent']))
    expect(runLines(ci.jobs.packaging!)).toEqual(expect.arrayContaining(['sha256sum -c dist/checksums.txt']))
    expect(stepUses(ci.jobs.packaging!)).toEqual(expect.arrayContaining(['actions/upload-artifact@v7.0.1']))
    expect(stepUses(ci.jobs['dependency-review']!)).toEqual(expect.arrayContaining(['actions/dependency-review-action@v5.0.0']))
    expect(runLines(ci.jobs['vulnerability-checks']!)).toEqual(expect.arrayContaining(['govulncheck ./...']))
  })

  it('REQ-REL-002 deploys only from workflow_dispatch main and applies D1 before Worker deploy', () => {
    const deploy = workflow('deploy.yml')

    expect(Object.keys(deploy.on)).toEqual(['workflow_dispatch'])
    expect(deploy.jobs.deploy!['timeout-minutes']).toBe(45)
    expect(deploy.jobs.deploy!.steps.find((step) => step.uses === 'actions/checkout@v7.0.0')?.with).toEqual({ ref: 'main' })
    expect(deploy.jobs.deploy).toHaveProperty('env.CLOUDFLARE_API_TOKEN', '${{ secrets.CLOUDFLARE_API_TOKEN_DEPLOY }}')
    expect(runLines(deploy.jobs.deploy!)).toEqual(expect.arrayContaining([
      'test -n "$CLOUDFLARE_ACCOUNT_ID"',
      'test -n "$CLOUDFLARE_API_TOKEN"',
      'test -n "$CLOUDFLARE_API_TOKEN_RUNTIME"',
      'npm run lint --workspace packages/router-worker',
      'npm run test --workspace packages/router-worker',
      'npm run typecheck --workspace packages/router-worker',
      'go test ./...',
      'go vet ./...',
      'npx wrangler d1 migrations apply codeflare-inference-mesh --remote',
      "grep -qxF \"$ln\" wrangler.toml || { echo \"::error::Workers VPC Mesh binding line not enabled: $ln\"; exit 1; }",
      'printf \'%s\' "$CLOUDFLARE_ACCOUNT_ID" | npx wrangler secret put CLOUDFLARE_ACCOUNT_ID',
      'printf \'%s\' "$CLOUDFLARE_API_TOKEN_RUNTIME" | npx wrangler secret put CLOUDFLARE_API_TOKEN_RUNTIME',
      'npx wrangler deploy'
    ]))
  })

  it('REQ-REL-003 builds cross-platform release assets, manifest, optional signature, and GitHub Release', () => {
    const deploy = workflow('deploy.yml')

    expect(runLines(deploy.jobs.deploy!)).toEqual(expect.arrayContaining([
      'for target in linux/amd64 linux/arm64 windows/amd64 darwin/amd64 darwin/arm64; do',
      'sha256sum *.tar.gz *.zip > checksums.txt',
      'sha256sum -c checksums.txt',
      'cosign sign-blob --key env://COSIGN_PRIVATE_KEY --output-signature checksums.txt.sig checksums.txt',
      'gh release create "${{ inputs.version_tag }}" * --target "$GITHUB_SHA" --title "${{ inputs.version_tag }}" --notes-file release-notes.md $PRERELEASE'
    ]))
    expect(deploy.on.workflow_dispatch).toHaveProperty('inputs.version_tag.required', true)
    expect(stepUses(deploy.jobs.deploy!)).toEqual(expect.arrayContaining(['actions/upload-artifact@v7.0.1']))
  })

  it('REQ-REL-004 enables CodeQL, Scorecard, and bounded fuzz workflows with explicit timeouts', () => {
    const security = workflow('security.yml')
    const fuzz = workflow('fuzz.yml')

    expect(Object.keys(security.on).sort()).toEqual(['pull_request', 'push', 'schedule', 'workflow_dispatch'])
    expect(security.jobs['workflow-safety']!['timeout-minutes']).toBe(5)
    expect(security.jobs.codeql).toHaveProperty('strategy.matrix.language', ['javascript-typescript', 'go'])
    expect(security.jobs.codeql).toHaveProperty('if', "github.repository_visibility == 'public'")
    expect(security.jobs.codeql!['timeout-minutes']).toBe(20)
    expect(security.jobs.scorecard).toHaveProperty('if', "github.repository_visibility == 'public'")
    expect(security.jobs.scorecard!['timeout-minutes']).toBe(10)
    expect(stepUses(security.jobs.codeql!)).toEqual(expect.arrayContaining(['actions/checkout@v7.0.0', 'github/codeql-action/init@v4.36.2', 'github/codeql-action/analyze@v4.36.2']))
    expect(stepUses(security.jobs.scorecard!)).toEqual(expect.arrayContaining(['actions/checkout@v7.0.0', 'ossf/scorecard-action@v2.4.3', 'github/codeql-action/upload-sarif@v4.36.2']))
    expect(security.jobs.scorecard).toHaveProperty('permissions.security-events', 'write')
    expect(Object.keys(fuzz.jobs).sort()).toEqual(['agent-fuzz', 'router-fuzz'])
    expect(fuzz.jobs['router-fuzz']!['timeout-minutes']).toBe(10)
    expect(fuzz.jobs['agent-fuzz']!['timeout-minutes']).toBe(10)
    expect(stepRuns(fuzz.jobs['router-fuzz']!)).toEqual(expect.arrayContaining(['npx vitest run src/fuzz.test.ts']))
    expect(stepRuns(fuzz.jobs['agent-fuzz']!)).toEqual(expect.arrayContaining(['go test -run=^$ -fuzz=Fuzz -fuzztime=30s ./internal/agent']))
  })

  it('REQ-REL-004 avoids workflow_run head_sha checkout pattern from Codeflare alert 63', () => {
    const workflows = ['ci.yml', 'deploy.yml', 'security.yml', 'fuzz.yml'].map(workflow)

    for (const item of workflows) {
      expect(Object.hasOwn(item.on, 'workflow_run')).toBe(false)
      for (const job of Object.values(item.jobs)) {
        for (const step of job.steps) {
          if (step.uses?.startsWith('actions/checkout@')) {
            expect(step.with?.ref).not.toBe('${{ github.event.workflow_run.head_sha || github.ref }}')
          }
        }
      }
    }
    expect(workflow('deploy.yml').jobs.deploy!.steps.find((step) => step.uses === 'actions/checkout@v7.0.0')?.with).toEqual({ ref: 'main' })
  })
})
