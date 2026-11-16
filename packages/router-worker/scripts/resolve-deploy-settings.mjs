#!/usr/bin/env node

export const DEPLOY_SETTINGS_ANCHORS = ['manual production deploy guard', 'manual integration deploy settings']

const eventName = process.env.GITHUB_EVENT_NAME ?? ''
const githubRef = process.env.GITHUB_REF ?? ''
const runNumber = process.env.GITHUB_RUN_NUMBER ?? ''
const inputEnvironment = process.env.INPUT_ENVIRONMENT ?? 'integration'
const inputVersionTag = process.env.INPUT_VERSION_TAG ?? ''
const inputWorkerBaseUrl = process.env.INPUT_WORKER_BASE_URL ?? ''
const deploySha = process.env.DEPLOY_SHA ?? ''

const targetEnv = eventName === 'workflow_run' ? 'production' : inputEnvironment
const deployRef = deploySha
if (deployRef.length !== 40 || !/^[a-f0-9]{40}$/.test(deployRef)) {
  console.error('Deploy settings require the validated full DEPLOY_SHA')
  process.exit(1)
}

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

const workerBaseUrl = resolveWorkerBaseUrl(targetEnv, settings.worker_name)
if (workerBaseUrl && !validWorkerBaseUrl(workerBaseUrl)) {
  console.error(`Invalid ${targetEnv} worker_base_url: ${workerBaseUrl}`)
  process.exit(1)
}

const output = {
  target_env: targetEnv,
  deploy_ref: deployRef,
  version_tag: versionTag,
  worker_base_url: workerBaseUrl,
  ...settings
}

function resolveWorkerBaseUrl(environment, workerName) {
  if (inputWorkerBaseUrl) return inputWorkerBaseUrl
  const envSpecific = environment === 'production' ? process.env.PRODUCTION_WORKER_BASE_URL : process.env.INTEGRATION_WORKER_BASE_URL
  if (envSpecific) return envSpecific
  // Never let integration inherit the generic production origin.
  if (environment === 'production' && process.env.WORKER_BASE_URL) return process.env.WORKER_BASE_URL
  if (process.env.CLOUDFLARE_WORKERS_DEV_SUBDOMAIN) return `https://${workerName}.${process.env.CLOUDFLARE_WORKERS_DEV_SUBDOMAIN}.workers.dev`
  return ''
}

function validWorkerBaseUrl(value) {
  try {
    const url = new URL(value)
    const labels = url.hostname.split('.')
    return url.protocol === 'https:'
      && url.username === ''
      && url.password === ''
      && url.pathname === '/'
      && url.search === ''
      && url.hash === ''
      && url.hostname.length <= 253
      && labels.length >= 2
      && labels.every(validHostnameLabel)
  } catch {
    return false
  }
}

function validHostnameLabel(label) {
  return label.length > 0
    && label.length <= 63
    && !label.startsWith('-')
    && !label.endsWith('-')
    && [...label].every((char) => char === '-' || (char >= '0' && char <= '9') || (char >= 'a' && char <= 'z'))
}

for (const [key, value] of Object.entries(output)) {
  console.log(`${key}=${value}`)
}
