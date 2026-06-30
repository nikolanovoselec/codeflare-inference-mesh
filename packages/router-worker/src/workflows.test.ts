import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
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
  readonly env?: Record<string, string>
  readonly 'working-directory'?: string
}

type Job = {
  readonly if?: string
  readonly env?: Record<string, string>
  readonly permissions?: Record<string, string>
  readonly needs?: readonly string[]
  readonly 'timeout-minutes'?: number
  readonly environment?: string
  readonly steps: readonly Step[]
}

type Workflow = {
  readonly name?: string
  readonly on: Record<string, unknown>
  readonly permissions?: Record<string, string>
  readonly jobs: Record<string, Job>
  readonly concurrency?: Record<string, string | boolean>
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

function allRunText(job: Job): string {
  return stepRuns(job).join('\n')
}

describe('workflow contract values', () => {
  it('REQ-REL-001 runs PR, main-push, manual, router, agent, packaging, security, and aggregate test checks', () => {
    const ci = workflow('ci.yml')

    expect(ci.name).toBe('PR Checks')
    expect(Object.keys(ci.on).sort()).toEqual(['pull_request', 'push', 'workflow_dispatch'])
    expect(ci.on.pull_request).toEqual({ branches: ['main', 'develop'] })
    expect(ci.on.push).toEqual({ branches: ['main'] })
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

  it('REQ-REL-002 auto-deploys production only after green main gates and allows manual integration from any branch', () => {
    const deploy = workflow('deploy.yml')
    const deployJob = deploy.jobs.deploy!
    const deployText = allRunText(deployJob)

    expect(Object.keys(deploy.on).sort()).toEqual(['workflow_dispatch', 'workflow_run'])
    expect(deploy.on.workflow_run).toEqual({ workflows: ['PR Checks'], types: ['completed'], branches: ['main'] })
    expect(deploy.on.workflow_dispatch).toHaveProperty('inputs.environment.default', 'integration')
    expect(deploy.on.workflow_dispatch).toHaveProperty('inputs.version_tag.required', false)
    expect(deploy.concurrency).toMatchObject({ 'cancel-in-progress': true })
    expect(deployJob['timeout-minutes']).toBe(45)
    expect(deployJob.if).toContain("github.event.workflow_run.conclusion == 'success'")
    expect(deployJob.if).toContain("github.event.workflow_run.event == 'push'")
    expect(deployJob.if).toContain('github.event.workflow_run.head_repository.full_name == github.repository')
    expect(deployJob.steps.find((step) => step.uses === 'actions/checkout@v7.0.0')?.with).toEqual({ ref: '${{ github.event.workflow_run.head_sha || github.ref }}' })
    expect(deployJob).toHaveProperty('env.CLOUDFLARE_API_TOKEN', '${{ secrets.CLOUDFLARE_API_TOKEN_DEPLOY }}')
    expect(deployText).toContain('Production deploys are only allowed from main')
    expect(deployText).toContain('for workflow in Security Fuzz; do')
    expect(deployJob.steps.find((step) => step.name === 'Resolve or create D1 database')).toMatchObject({ 'working-directory': 'packages/router-worker' })
    expect(runLines(deployJob)).toEqual(expect.arrayContaining([
      'npm exec -- wrangler d1 list --json > d1-list.json',
      'npm exec -- wrangler d1 create "$DB_NAME" > d1-create.txt',
      'DB_ID=$(node scripts/d1-database-id.mjs d1-create.txt)',
      '[ -n "$DB_ID" ] || { echo "::error::Could not resolve D1 database id"; exit 1; }'
    ]))
    expect(deployJob.steps.find((step) => step.name === 'Resolve or create D1 database')?.env).toEqual({ AGENT_RELEASE_TAG: '${{ steps.settings.outputs.version_tag }}' })
    expect(deployText).toContain("replaceAll('agent-release-tag-placeholder', process.env.AGENT_RELEASE_TAG)")
    expect(deployText).toContain('npm exec -- wrangler d1 migrations apply "${{ steps.settings.outputs.db_name }}" --remote "${args[@]}"')
    expect(deployText).toContain('printf \'%s\' "$CLOUDFLARE_ACCOUNT_ID" | npm exec -- wrangler secret put CLOUDFLARE_ACCOUNT_ID "${args[@]}"')
    expect(deployText).toContain('npm exec -- wrangler deploy "${args[@]}"')
    expect(deployText).toContain('worker_name="codeflare-inference-mesh-router-integration"')
  })

  it('REQ-REL-002 extracts Wrangler D1 create IDs and fails closed when the ID is absent', () => {
    const temp = mkdtempSync(resolve(tmpdir(), 'd1-id-'))
    try {
      const script = resolve(repoRoot, 'packages/router-worker/scripts/d1-database-id.mjs')
      const validPath = resolve(temp, 'valid.txt')
      const invalidPath = resolve(temp, 'invalid.txt')
      writeFileSync(validPath, '[[d1_databases]]\nbinding = "DB"\ndatabase_name = "codeflare-inference-mesh-integration"\ndatabase_id = "11111111-2222-4333-8444-555555555555"\n')
      writeFileSync(invalidPath, 'Created database without a stable identifier')

      const valid = spawnSync(process.execPath, [script, validPath], { encoding: 'utf8' })
      const invalid = spawnSync(process.execPath, [script, invalidPath], { encoding: 'utf8' })

      expect(valid.status).toBe(0)
      expect(valid.stdout).toBe('11111111-2222-4333-8444-555555555555')
      expect(invalid.status).toBe(1)
      expect(invalid.stdout).toBe('')
    } finally {
      rmSync(temp, { recursive: true, force: true })
    }
  })

  it('REQ-REL-003 builds cross-platform release assets, manifest, optional signature, and GitHub Release', () => {
    const deploy = workflow('deploy.yml')
    const deployText = allRunText(deploy.jobs.deploy!)

    expect(deployText).toContain('for target in linux/amd64 linux/arm64 windows/amd64 darwin/amd64 darwin/arm64; do')
    expect(deployText).toContain('sha256sum *.tar.gz *.zip > checksums.txt')
    expect(deployText).toContain('sha256sum -c checksums.txt')
    expect(deployText).toContain('cosign sign-blob --key env://COSIGN_PRIVATE_KEY --output-signature checksums.txt.sig checksums.txt')
    expect(deployText).toContain('gh release create "${{ steps.settings.outputs.version_tag }}" * --target "$GITHUB_SHA" --title "${{ steps.settings.outputs.version_tag }}" --notes-file release-notes.md $PRERELEASE')
    expect(stepUses(deploy.jobs.deploy!)).toEqual(expect.arrayContaining(['actions/upload-artifact@v7.0.1']))
  })

  it('REQ-REL-004 enables Security and Fuzz gates with stable aggregate checks and explicit timeouts', () => {
    const security = workflow('security.yml')
    const fuzz = workflow('fuzz.yml')

    expect(Object.keys(security.on).sort()).toEqual(['pull_request', 'push', 'schedule', 'workflow_dispatch'])
    expect(security.on.pull_request).toEqual({ branches: ['main', 'develop'] })
    expect(security.on.push).toEqual({ branches: ['main'] })
    expect(security.jobs['workflow-safety']!['timeout-minutes']).toBe(5)
    expect(security.jobs.codeql).toHaveProperty('strategy.matrix.language', ['javascript-typescript', 'go'])
    expect(security.jobs.codeql).toHaveProperty('if', "github.repository_visibility == 'public'")
    expect(security.jobs.codeql!['timeout-minutes']).toBe(20)
    expect(security.jobs.scorecard).toHaveProperty('if', "github.repository_visibility == 'public' && github.ref == 'refs/heads/main'")
    expect(security.jobs.scorecard!['timeout-minutes']).toBe(10)
    expect(security.jobs.security!.needs).toEqual(['workflow-safety', 'codeql'])
    expect(security.jobs.security!['timeout-minutes']).toBe(5)
    expect(stepUses(security.jobs.codeql!)).toEqual(expect.arrayContaining(['actions/checkout@v7.0.0', 'github/codeql-action/init@v4.36.2', 'github/codeql-action/analyze@v4.36.2']))
    expect(stepUses(security.jobs.scorecard!)).toEqual(expect.arrayContaining(['actions/checkout@v7.0.0', 'ossf/scorecard-action@v2.4.3', 'github/codeql-action/upload-sarif@v4.36.2']))
    expect(security.jobs.scorecard).toHaveProperty('permissions.security-events', 'write')
    expect(fuzz.on.pull_request).toEqual({ branches: ['main', 'develop'] })
    expect(fuzz.on.push).toEqual({ branches: ['main'] })
    expect(Object.keys(fuzz.jobs).sort()).toEqual(['agent-fuzz', 'fuzz', 'router-fuzz'])
    expect(fuzz.jobs.fuzz!.needs).toEqual(['router-fuzz', 'agent-fuzz'])
    expect(fuzz.jobs.fuzz!['timeout-minutes']).toBe(5)
    expect(fuzz.jobs['router-fuzz']!['timeout-minutes']).toBe(10)
    expect(fuzz.jobs['agent-fuzz']!['timeout-minutes']).toBe(10)
    expect(stepRuns(fuzz.jobs['router-fuzz']!)).toEqual(expect.arrayContaining(['npx vitest run src/fuzz.test.ts']))
    expect(stepRuns(fuzz.jobs['agent-fuzz']!)).toEqual(expect.arrayContaining(['go test -run=^$ -fuzz=Fuzz -fuzztime=30s ./internal/agent']))
  })

  it('REQ-REL-004 permits only the hardened deploy workflow_run checkout pattern', () => {
    const ci = workflow('ci.yml')
    const deploy = workflow('deploy.yml')
    const security = workflow('security.yml')
    const fuzz = workflow('fuzz.yml')

    expect(Object.hasOwn(deploy.on, 'workflow_run')).toBe(true)
    expect(deploy.jobs.deploy!.if).toContain("github.event.workflow_run.event == 'push'")
    expect(deploy.jobs.deploy!.if).toContain('github.event.workflow_run.head_repository.full_name == github.repository')
    expect(deploy.jobs.deploy!.steps.find((step) => step.uses === 'actions/checkout@v7.0.0')?.with).toEqual({ ref: '${{ github.event.workflow_run.head_sha || github.ref }}' })
    for (const item of [ci, security, fuzz]) {
      expect(Object.hasOwn(item.on, 'workflow_run')).toBe(false)
      for (const job of Object.values(item.jobs)) {
        for (const step of job.steps) {
          if (step.uses?.startsWith('actions/checkout@')) {
            expect(step.with?.ref).not.toBe('${{ github.event.workflow_run.head_sha || github.ref }}')
          }
        }
      }
    }
  })
})
