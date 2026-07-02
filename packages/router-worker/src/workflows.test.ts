import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

function stepByName(job: Job, name: string): Step | undefined {
  return job.steps.find((step) => step.name === name)
}

function stepUses(job: Job): readonly string[] {
  return job.steps.map((step) => step.uses).filter((use): use is string => typeof use === 'string')
}

function outputValues(stdout: string): Record<string, string> {
  return Object.fromEntries(stdout.trim().split('\n').filter(Boolean).map((line) => line.split('=', 2) as [string, string]))
}

function runScript(script: string, options: { input?: string; env?: Record<string, string>; args?: readonly string[] } = {}) {
  return spawnSync(process.execPath, [resolve(repoRoot, script), ...(options.args ?? [])], {
    input: options.input,
    env: { ...process.env, ...options.env },
    encoding: 'utf8'
  })
}

function runShellBlock(block: string, env: Record<string, string>) {
  return runShellBlockWithFiles(block, env).result
}

function runShellBlockWithFiles(block: string, env: Record<string, string>, files: Record<string, string> = {}, binFiles: Record<string, string> = {}, readBack: readonly string[] = []) {
  const dir = mkdtempSync(resolve(tmpdir(), 'workflow-shell-'))
  const bin = resolve(dir, 'bin')
  mkdirSync(bin, { recursive: true })
  for (const [file, content] of Object.entries(files)) {
    const path = resolve(dir, file)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, content)
  }
  for (const [file, content] of Object.entries(binFiles)) {
    const path = resolve(bin, file)
    writeFileSync(path, content, { mode: 0o755 })
  }
  const script = resolve(dir, 'step.sh')
  writeFileSync(script, block)
  try {
    const result = spawnSync('bash', [script], { cwd: dir, env: { PATH: `${bin}:${process.env.PATH ?? ''}`, ...env }, encoding: 'utf8' })
    const outputs = Object.fromEntries(readBack.map((file) => {
      const path = resolve(dir, file)
      return [file, existsSync(path) ? readFileSync(path, 'utf8') : '']
    }))
    return { result, outputs }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
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
    expect(ci.jobs.router!.steps.map((step) => step.name ?? step.uses)).toEqual(expect.arrayContaining(['Install dependencies', 'Lint router', 'Test router behavior', 'Type-check router', 'Generate Wrangler types', 'Worker dry-run deploy']))
    expect(stepUses(ci.jobs.agent!)).toEqual(expect.arrayContaining(['actions/checkout@v7.0.0', 'actions/setup-go@v6.5.0']))
    expect(ci.jobs.agent!.steps.find((step) => step.uses === 'actions/setup-go@v6.5.0')?.with).toEqual({ 'go-version': '1.26.4' })
    expect(ci.jobs.agent!.steps.map((step) => step.name ?? step.uses)).toEqual(expect.arrayContaining(['Go test', 'Go vet', 'Go race tests', 'Build command']))
    expect(ci.jobs.packaging!.steps.map((step) => step.name ?? step.uses)).toEqual(expect.arrayContaining(['Build staged binary', 'Create archive and checksums', 'Version command', 'actions/upload-artifact@v7.0.1']))
    expect(stepUses(ci.jobs.packaging!)).toEqual(expect.arrayContaining(['actions/upload-artifact@v7.0.1']))
    expect(stepUses(ci.jobs['dependency-review']!)).toEqual(expect.arrayContaining(['actions/dependency-review-action@v5.0.0']))
    expect(ci.jobs['vulnerability-checks']!.steps.map((step) => step.name ?? step.uses)).toEqual(expect.arrayContaining(['npm audit', 'Go vulnerability check']))
  })

  it('REQ-REL-002 auto-deploys production only after green main gates and allows manual integration from any branch', () => {
    const deploy = workflow('deploy.yml')
    const deployJob = deploy.jobs.deploy!

    expect(Object.keys(deploy.on).sort()).toEqual(['workflow_dispatch', 'workflow_run'])
    expect(deploy.on.workflow_run).toEqual({ workflows: ['PR Checks'], types: ['completed'], branches: ['main'] })
    expect(deploy.on.workflow_dispatch).toHaveProperty('inputs.environment.default', 'integration')
    expect(deploy.on.workflow_dispatch).toHaveProperty('inputs.version_tag.required', false)
    expect(deploy.on.workflow_dispatch).toHaveProperty('inputs.worker_base_url.required', false)
    expect(deploy.concurrency).toMatchObject({ 'cancel-in-progress': true })
    expect(deployJob['timeout-minutes']).toBe(45)
    expect(deployJob.if).toBeDefined()
    expect(deployJob.env).toBeUndefined()
    expect(deployJob.steps.find((step) => step.uses === 'actions/checkout@v7.0.0')?.with).toEqual({ ref: '${{ github.event.workflow_run.head_sha || github.ref }}', 'persist-credentials': false })
    const stepNames = deployJob.steps.map((step) => step.name ?? step.uses ?? '')
    expect(stepNames.indexOf('Guard deploy source')).toBeLessThan(stepNames.indexOf('actions/checkout@v7.0.0'))
    const guardRun = stepByName(deployJob, 'Guard deploy source')!.run!
    const guardEnv = { WORKFLOW_RUN_CONCLUSION: '', WORKFLOW_RUN_EVENT: '', WORKFLOW_RUN_REPOSITORY: '', EXPECTED_REPOSITORY: 'nikolanovoselec/codeflare-inference-mesh' }
    expect(runShellBlock(guardRun, { ...guardEnv, EVENT_NAME: 'workflow_dispatch', INPUT_ENVIRONMENT: 'integration', GITHUB_REF: 'refs/heads/feature' }).status).toBe(0)
    expect(runShellBlock(guardRun, { ...guardEnv, EVENT_NAME: 'workflow_dispatch', INPUT_ENVIRONMENT: 'production', GITHUB_REF: 'refs/heads/feature' }).status).toBe(1)
    expect(runShellBlock(guardRun, { EVENT_NAME: 'workflow_run', INPUT_ENVIRONMENT: '', GITHUB_REF: 'refs/heads/main', WORKFLOW_RUN_CONCLUSION: 'success', WORKFLOW_RUN_EVENT: 'push', WORKFLOW_RUN_REPOSITORY: 'nikolanovoselec/codeflare-inference-mesh', EXPECTED_REPOSITORY: 'nikolanovoselec/codeflare-inference-mesh' }).status).toBe(0)
    expect(runShellBlock(guardRun, { EVENT_NAME: 'workflow_run', INPUT_ENVIRONMENT: '', GITHUB_REF: 'refs/heads/main', WORKFLOW_RUN_CONCLUSION: 'success', WORKFLOW_RUN_EVENT: 'pull_request', WORKFLOW_RUN_REPOSITORY: 'nikolanovoselec/codeflare-inference-mesh', EXPECTED_REPOSITORY: 'nikolanovoselec/codeflare-inference-mesh' }).status).toBe(1)
    expect(stepNames.indexOf('Resolve deploy settings')).toBeGreaterThan(stepNames.indexOf('actions/checkout@v7.0.0'))
    expect(stepNames.indexOf('Publish GitHub Release')).toBeGreaterThan(-1)
    expect(stepNames.indexOf('Deploy Worker')).toBeGreaterThan(stepNames.indexOf('Publish GitHub Release'))
    expect(stepByName(deployJob, 'Resolve deploy settings')).toMatchObject({
      run: 'node packages/router-worker/scripts/resolve-deploy-settings.mjs >> "$GITHUB_OUTPUT"',
      env: {
        INPUT_ENVIRONMENT: '${{ inputs.environment }}',
        INPUT_VERSION_TAG: '${{ inputs.version_tag }}',
        INPUT_WORKER_BASE_URL: '${{ inputs.worker_base_url }}',
        WORKFLOW_RUN_HEAD_SHA: '${{ github.event.workflow_run.head_sha }}',
        WORKER_BASE_URL: '${{ vars.WORKER_BASE_URL }}',
        PRODUCTION_WORKER_BASE_URL: '${{ vars.PRODUCTION_WORKER_BASE_URL }}',
        INTEGRATION_WORKER_BASE_URL: '${{ vars.INTEGRATION_WORKER_BASE_URL }}',
        CLOUDFLARE_WORKERS_DEV_SUBDOMAIN: '${{ vars.CLOUDFLARE_WORKERS_DEV_SUBDOMAIN }}'
      }
    })
    const integrationSettings = runScript('packages/router-worker/scripts/resolve-deploy-settings.mjs', { env: { GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/feature', INPUT_ENVIRONMENT: 'integration', GITHUB_RUN_NUMBER: '7', CLOUDFLARE_WORKERS_DEV_SUBDOMAIN: 'example-subdomain' } })
    const productionSettings = runScript('packages/router-worker/scripts/resolve-deploy-settings.mjs', { env: { GITHUB_EVENT_NAME: 'workflow_run', GITHUB_REF: 'refs/heads/main', WORKFLOW_RUN_HEAD_SHA: 'abc123', GITHUB_RUN_NUMBER: '8', PRODUCTION_WORKER_BASE_URL: 'https://router.example.com' } })
    const rejectedProduction = runScript('packages/router-worker/scripts/resolve-deploy-settings.mjs', { env: { GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/feature', INPUT_ENVIRONMENT: 'production', GITHUB_RUN_NUMBER: '9', WORKER_BASE_URL: 'https://router.example.com' } })
    const rejectedWorkerUrl = runScript('packages/router-worker/scripts/resolve-deploy-settings.mjs', { env: { GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/feature', INPUT_ENVIRONMENT: 'integration', GITHUB_RUN_NUMBER: '10', WORKER_BASE_URL: 'https://router.example.com/path' } })
    const rejectedShellUrl = runScript('packages/router-worker/scripts/resolve-deploy-settings.mjs', { env: { GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/feature', INPUT_ENVIRONMENT: 'integration', GITHUB_RUN_NUMBER: '11', WORKER_BASE_URL: 'https://$(id).example.com' } })
    expect(integrationSettings.status).toBe(0)
    expect(outputValues(integrationSettings.stdout)).toEqual({ target_env: 'integration', deploy_ref: 'refs/heads/feature', version_tag: 'v0.1.0-dev.7', worker_base_url: 'https://codeflare-inference-mesh-router-integration.example-subdomain.workers.dev', db_name: 'codeflare-inference-mesh-integration', worker_name: 'codeflare-inference-mesh-router-integration', wrangler_env: 'integration' })
    expect(productionSettings.status).toBe(0)
    expect(outputValues(productionSettings.stdout)).toMatchObject({ target_env: 'production', deploy_ref: 'abc123', version_tag: 'v0.1.8', worker_base_url: 'https://router.example.com', db_name: 'codeflare-inference-mesh' })
    expect(rejectedProduction.status).toBe(1)
    expect(rejectedWorkerUrl.status).toBe(1)
    expect(rejectedShellUrl.status).toBe(1)
    expect(runScript('packages/router-worker/scripts/deploy-gate.mjs', {
      input: JSON.stringify([
        { workflowName: 'Security', headSha: 'abc', event: 'workflow_dispatch', headBranch: 'develop', status: 'completed', conclusion: 'success', databaseId: 4 },
        { workflowName: 'Security', headSha: 'abc', event: 'push', headBranch: 'main', status: 'completed', conclusion: 'failure', databaseId: 5, url: 'https://example.test/failing-run' }
      ]),
      env: { WORKFLOW_NAME: 'Security', GATE_SHA: 'abc', REQUIRED_EVENT: 'push', REQUIRED_BRANCH: 'main' }
    }).stdout.startsWith('failure')).toBe(true)
    const d1Step = stepByName(deployJob, 'Resolve or create D1 database')!
    const d1Run = d1Step.run!
    expect(d1Step).toMatchObject({ 'working-directory': 'packages/router-worker', env: { CLOUDFLARE_API_TOKEN: '${{ secrets.CLOUDFLARE_API_TOKEN_DEPLOY }}', AGENT_RELEASE_TAG: '${{ steps.settings.outputs.version_tag }}', WORKER_BASE_URL: '${{ steps.settings.outputs.worker_base_url }}' } })
    const d1Execution = runShellBlockWithFiles(
      d1Run.replaceAll('${{ steps.settings.outputs.db_name }}', 'codeflare-inference-mesh-integration'),
      { CLOUDFLARE_ACCOUNT_ID: 'account-a', CLOUDFLARE_API_TOKEN: 'deploy-token', AGENT_RELEASE_TAG: 'v0.1.0-dev.7', WORKER_BASE_URL: 'https://router.example.com' },
      { 'wrangler.toml': 'database_id = "create-via-deploy-workflow"\nAGENT_RELEASE_TAG = "agent-release-tag-placeholder"\nWORKER_BASE_URL = "https://codeflare-inference-mesh-router.<your-subdomain>.workers.dev"\n' },
      { npm: '#!/bin/sh\nif [ "$1 $2 $3 $4 $5 $6" = "exec -- wrangler d1 list --json" ]; then printf \'[{"name":"codeflare-inference-mesh-integration","uuid":"11111111-2222-4333-8444-555555555555"}]\'; exit 0; fi\nprintf \'unexpected npm %s\\n\' "$*" >&2\nexit 1\n' },
      ['wrangler.toml']
    )
    expect(d1Execution.result.status).toBe(0)
    expect(d1Execution.outputs['wrangler.toml']).toContain('https://router.example.com')
    expect(d1Execution.outputs['wrangler.toml']).not.toContain('<your-subdomain>')
    expect(stepByName(deployJob, 'Apply D1 migrations')).toMatchObject({ 'working-directory': 'packages/router-worker', env: { CLOUDFLARE_API_TOKEN: '${{ secrets.CLOUDFLARE_API_TOKEN_DEPLOY }}' } })
    const secretsRun = stepByName(deployJob, 'Set Worker runtime secrets')!.run!
    expect(stepByName(deployJob, 'Set Worker runtime secrets')).toMatchObject({ 'working-directory': 'packages/router-worker', env: { CLOUDFLARE_API_TOKEN_RUNTIME: '${{ secrets.CLOUDFLARE_API_TOKEN_RUNTIME }}' } })
    const secretsExecution = runShellBlockWithFiles(
      secretsRun.replaceAll('${{ steps.settings.outputs.wrangler_env }}', ''),
      { CLOUDFLARE_ACCOUNT_ID: 'account-a', CLOUDFLARE_API_TOKEN: 'deploy-token', CLOUDFLARE_API_TOKEN_RUNTIME: 'runtime-token', ADMIN_RECOVERY_TOKEN: '' },
      {},
      { npm: '#!/bin/sh\nif [ "$1 $2 $3 $4 $5" = "exec -- wrangler secret bulk" ]; then cat > secret-bulk.json; exit 0; fi\nif [ "$1 $2 $3 $4 $5 $6" = "exec -- wrangler secret delete ADMIN_RECOVERY_TOKEN" ]; then cat > secret-delete.stdin; printf \'%s\' "$*" > secret-delete.args; exit 0; fi\nprintf \'unexpected npm %s\\n\' "$*" >&2\nexit 1\n' },
      ['secret-bulk.json', 'secret-delete.stdin', 'secret-delete.args']
    )
    expect(secretsExecution.result.status).toBe(0)
    expect(JSON.parse(secretsExecution.outputs['secret-bulk.json']!)).toEqual({ CLOUDFLARE_ACCOUNT_ID: 'account-a', CLOUDFLARE_API_TOKEN_RUNTIME: 'runtime-token' })
    expect(secretsExecution.outputs['secret-delete.stdin']).toBe('y\n')
    expect(secretsExecution.outputs['secret-delete.args']).toContain('ADMIN_RECOVERY_TOKEN')
    expect(stepByName(deployJob, 'Deploy Worker')).toMatchObject({ 'working-directory': 'packages/router-worker', env: { CLOUDFLARE_API_TOKEN: '${{ secrets.CLOUDFLARE_API_TOKEN_DEPLOY }}' } })
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
    const deployJob = deploy.jobs.deploy!
    const stepNames = deployJob.steps.map((step) => step.name ?? step.uses ?? '')

    expect(stepNames).toEqual(expect.arrayContaining(['Build release artifacts and manifest', 'Sign checksums when signing is configured', 'Publish GitHub Release', 'Deploy Worker', 'actions/upload-artifact@v7.0.1']))
    const buildStep = stepByName(deployJob, 'Build release artifacts and manifest')!
    expect(buildStep).toMatchObject({ 'working-directory': 'packages/node-agent' })
    const buildExecution = runShellBlockWithFiles(
      buildStep.run!
        .replaceAll('${{ steps.settings.outputs.version_tag }}', 'v0.1.0-dev.7')
        .replaceAll('${{ steps.settings.outputs.target_env }}', 'integration'),
      { GITHUB_SHA: 'abc123' },
      {},
      {
        go: '#!/bin/sh\nout=""\nwhile [ $# -gt 0 ]; do if [ "$1" = "-o" ]; then shift; out="$1"; fi; shift || true; done\nmkdir -p "$(dirname "$out")"\nprintf binary > "$out"\n',
        zip: '#!/bin/sh\nprintf archive > "$1"\n',
        tar: '#!/bin/sh\nout=""\nwhile [ $# -gt 0 ]; do if [ "$1" = "-czf" ]; then shift; out="$1"; fi; shift || true; done\nprintf archive > "$out"\n',
        sha256sum: '#!/bin/sh\nif [ "$1" = "-c" ]; then exit 0; fi\nfor file in "$@"; do printf "abc  %s\\n" "$file"; done\n'
      },
      ['dist/inference-mesh-agent-linux-amd64', 'dist/inference-mesh-agent-linux-amd64.tar.gz', 'dist/inference-mesh-agent-windows-amd64.exe', 'dist/inference-mesh-agent-windows-amd64.zip', 'dist/checksums.txt', 'dist/release-manifest.json']
    )
    expect(buildExecution.result.status).toBe(0)
    expect(buildExecution.outputs['dist/inference-mesh-agent-linux-amd64']).toBe('')
    expect(buildExecution.outputs['dist/inference-mesh-agent-linux-amd64.tar.gz']).toBe('archive')
    expect(buildExecution.outputs['dist/inference-mesh-agent-windows-amd64.exe']).toBe('')
    expect(buildExecution.outputs['dist/inference-mesh-agent-windows-amd64.zip']).toBe('archive')
    expect(buildExecution.outputs['dist/checksums.txt']).toContain('.tar.gz')
    expect(JSON.parse(buildExecution.outputs['dist/release-manifest.json']!)).toMatchObject({ version: 'v0.1.0-dev.7', channel: 'integration', commit: 'abc123' })
    const signStep = stepByName(deployJob, 'Sign checksums when signing is configured')!
    expect(signStep).toMatchObject({ 'working-directory': 'packages/node-agent/dist', env: { COSIGN_PRIVATE_KEY: '${{ secrets.COSIGN_PRIVATE_KEY }}', COSIGN_PASSWORD: '${{ secrets.COSIGN_PASSWORD }}' } })
    const skippedSign = runShellBlock(signStep.run!, { COSIGN_PRIVATE_KEY: '', COSIGN_PASSWORD: '' })
    expect(skippedSign.status).toBe(0)
    expect(skippedSign.stdout).toContain('Cosign key not configured; skipping signature')
    expect(stepByName(deployJob, 'Publish GitHub Release')).toMatchObject({ 'working-directory': 'packages/node-agent/dist', env: { GH_TOKEN: '${{ github.token }}' } })
    expect(stepByName(deployJob, 'Resolve or create D1 database')?.env).toMatchObject({ AGENT_RELEASE_TAG: '${{ steps.settings.outputs.version_tag }}', CLOUDFLARE_API_TOKEN: '${{ secrets.CLOUDFLARE_API_TOKEN_DEPLOY }}' })
    expect(stepNames.indexOf('Deploy Worker')).toBeGreaterThan(stepNames.indexOf('Publish GitHub Release'))
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
    expect(stepByName(fuzz.jobs['router-fuzz']!, 'Run router fuzz corpus')).toMatchObject({ 'working-directory': 'packages/router-worker' })
    expect(fuzz.jobs['agent-fuzz']).toHaveProperty('defaults.run.working-directory', 'packages/node-agent')
    expect(stepByName(fuzz.jobs['agent-fuzz']!, 'Run agent fuzz targets')).toBeDefined()
  })

  it('REQ-REL-004 rejects unsafe workflow_run checkout, floating actions, reusable workflows, and floating runners', () => {
    const valid = runScript('packages/router-worker/scripts/workflow-safety.mjs', { args: [resolve(repoRoot, '.github/workflows')] })
    expect(valid.status).toBe(0)

    const temp = mkdtempSync(resolve(tmpdir(), 'workflow-safety-'))
    try {
      const unsafeWorkflowDir = resolve(temp, 'unsafe-workflow-run')
      const unsafeActionDir = resolve(temp, 'unsafe-action')
      const unsafeRunnerDir = resolve(temp, 'unsafe-runner')
      const unsafeReusableDir = resolve(temp, 'unsafe-reusable')
      const unsafeStepGuardDir = resolve(temp, 'unsafe-step-guard')
      const unsafeNamedCheckoutDir = resolve(temp, 'unsafe-named-checkout')
      mkdirSync(unsafeWorkflowDir, { recursive: true })
      mkdirSync(unsafeActionDir, { recursive: true })
      mkdirSync(unsafeRunnerDir, { recursive: true })
      mkdirSync(unsafeReusableDir, { recursive: true })
      mkdirSync(unsafeStepGuardDir, { recursive: true })
      mkdirSync(unsafeNamedCheckoutDir, { recursive: true })
      writeFileSync(resolve(unsafeWorkflowDir, 'deploy.yml'), `name: Deploy\non:\n  workflow_run:\n    workflows: [PR Checks]\njobs:\n  deploy:\n    if: github.event.workflow_run.event == 'push' && github.event.workflow_run.head_repository.full_name == github.repository\n    runs-on: ubuntu-24.04\n    steps:\n      - uses: actions/checkout@v7.0.0\n        with:\n          ref: \${{ github.event.workflow_run.head_sha || github.ref }}\n      - uses: actions/checkout@v7.0.0\n        with:\n          ref: \${{ github.ref }}\n`)
      writeFileSync(resolve(unsafeActionDir, 'security.yml'), `name: Security\non: [pull_request]\njobs:\n  unsafe:\n    runs-on: ubuntu-24.04\n    steps:\n      - uses: actions/checkout@main # hidden by comment in raw-line parsers\n`)
      writeFileSync(resolve(unsafeRunnerDir, 'security.yml'), `name: Security\non: [pull_request]\njobs:\n  unsafe:\n    runs-on:\n      - ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4.2.2\n`)
      writeFileSync(resolve(unsafeReusableDir, 'security.yml'), `name: Security\non: [pull_request]\njobs:\n  unsafe:\n    uses: owner/repo/.github/workflows/reusable.yml@main\n`)
      writeFileSync(resolve(unsafeStepGuardDir, 'deploy.yml'), `name: Deploy\non:\n  workflow_run:\n    workflows: [PR Checks]\njobs:\n  deploy:\n    runs-on: ubuntu-24.04\n    steps:\n      - uses: actions/checkout@v7.0.0\n        if: github.event.workflow_run.event == 'push' && github.event.workflow_run.head_repository.full_name == github.repository\n        with:\n          ref: \${{ github.event.workflow_run.head_sha || github.ref }}\n`)
      writeFileSync(resolve(unsafeNamedCheckoutDir, 'deploy.yml'), `name: Deploy\non:\n  workflow_run:\n    workflows: [PR Checks]\njobs:\n  deploy:\n    if: github.event.workflow_run.event == 'push' && github.event.workflow_run.head_repository.full_name == github.repository\n    runs-on: ubuntu-24.04\n    steps:\n      - name: Checkout\n        uses: actions/checkout@v7.0.0\n        with:\n          ref: \${{ github.ref }}\n`)

      const unsafeWorkflowRun = runScript('packages/router-worker/scripts/workflow-safety.mjs', { args: [unsafeWorkflowDir] })
      const unsafeAction = runScript('packages/router-worker/scripts/workflow-safety.mjs', { args: [unsafeActionDir] })
      const unsafeRunner = runScript('packages/router-worker/scripts/workflow-safety.mjs', { args: [unsafeRunnerDir] })
      const unsafeReusable = runScript('packages/router-worker/scripts/workflow-safety.mjs', { args: [unsafeReusableDir] })
      const unsafeStepGuard = runScript('packages/router-worker/scripts/workflow-safety.mjs', { args: [unsafeStepGuardDir] })
      const unsafeNamedCheckout = runScript('packages/router-worker/scripts/workflow-safety.mjs', { args: [unsafeNamedCheckoutDir] })

      expect(unsafeWorkflowRun.status).not.toBe(0)
      expect(unsafeAction.status).not.toBe(0)
      expect(unsafeRunner.status).not.toBe(0)
      expect(unsafeReusable.status).not.toBe(0)
      expect(unsafeStepGuard.status).not.toBe(0)
      expect(unsafeNamedCheckout.status).not.toBe(0)
    } finally {
      rmSync(temp, { recursive: true, force: true })
    }
  })
})
