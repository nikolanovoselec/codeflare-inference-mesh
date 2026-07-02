#!/usr/bin/env node

export const DEPLOY_SETTINGS_ANCHORS = ['manual production deploy guard', 'manual integration deploy settings']

const eventName = process.env.GITHUB_EVENT_NAME ?? ''
const githubRef = process.env.GITHUB_REF ?? ''
const runNumber = process.env.GITHUB_RUN_NUMBER ?? ''
const inputEnvironment = process.env.INPUT_ENVIRONMENT ?? 'integration'
const inputVersionTag = process.env.INPUT_VERSION_TAG ?? ''
const workflowRunHeadSha = process.env.WORKFLOW_RUN_HEAD_SHA ?? ''

const targetEnv = eventName === 'workflow_run' ? 'production' : inputEnvironment
const deployRef = eventName === 'workflow_run' ? workflowRunHeadSha : githubRef

if (targetEnv === 'production' && githubRef !== 'refs/heads/main' && eventName !== 'workflow_run') {
  console.error(`Production deploys are only allowed from main. Got ref: ${githubRef}`)
  process.exit(1)
}

const versionTag = inputVersionTag || (targetEnv === 'production' ? `v0.1.${runNumber}` : `v0.1.0-dev.${runNumber}`)
const expectedTag = targetEnv === 'production' ? /^v[0-9]+\.[0-9]+\.[0-9]+$/ : /^v[0-9]+\.[0-9]+\.[0-9]+-dev\.[0-9]+$/
if (!expectedTag.test(versionTag)) {
  console.error(`Invalid ${targetEnv} version tag: ${versionTag}`)
  process.exit(1)
}

const settings = targetEnv === 'production'
  ? { db_name: 'codeflare-inference-mesh', worker_name: 'codeflare-inference-mesh-router', wrangler_env: '' }
  : { db_name: 'codeflare-inference-mesh-integration', worker_name: 'codeflare-inference-mesh-router-integration', wrangler_env: 'integration' }

const output = {
  target_env: targetEnv,
  deploy_ref: deployRef,
  version_tag: versionTag,
  ...settings
}

for (const [key, value] of Object.entries(output)) {
  console.log(`${key}=${value}`)
}
