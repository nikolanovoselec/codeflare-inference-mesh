#!/usr/bin/env node
// REL004SecurityWorkflows
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import YAML from 'yaml'

const versionRef = /^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/
const shaRef = /^[a-f0-9]{40}$/i
const workflowRunHeadRef = '${{ github.event.workflow_run.head_sha || github.ref }}'

function workflowFiles(workflowDir) {
  return readdirSync(workflowDir)
    .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
    .map((name) => join(workflowDir, name))
}

function parseWorkflow(file) {
  return YAML.parse(readFileSync(file, 'utf8')) ?? {}
}

function workflowOn(workflow) {
  return workflow.on ?? workflow.On ?? {}
}

function jobsOf(workflow) {
  return workflow.jobs && typeof workflow.jobs === 'object' ? workflow.jobs : {}
}

function stepsOf(job) {
  return Array.isArray(job?.steps) ? job.steps : []
}

function hasWorkflowRunTrigger(workflow) {
  return Boolean(workflowOn(workflow).workflow_run)
}

function hasHardenedWorkflowRunJob(job) {
  const condition = String(job?.if ?? '')
  return condition.includes("github.event.workflow_run.event == 'push'") &&
    condition.includes('github.event.workflow_run.head_repository.full_name == github.repository')
}

function checkoutSteps(job) {
  return stepsOf(job).filter((step) => typeof step?.uses === 'string' && step.uses.startsWith('actions/checkout@'))
}

function actionUses(workflow) {
  return Object.values(jobsOf(workflow)).flatMap((job) => stepsOf(job).map((step) => step?.uses).filter((use) => typeof use === 'string'))
}

function runnerPins(workflow) {
  return Object.values(jobsOf(workflow)).flatMap((job) => parseRunnerValue(job?.['runs-on']))
}

function parseRunnerValue(value) {
  if (typeof value === 'string') return value.replace(/[\[\]'"]/g, '').split(',').map((item) => item.trim()).filter(Boolean)
  if (Array.isArray(value)) return value.flatMap(parseRunnerValue)
  return []
}

function invalidRunnerPin(runner) {
  if (runner === 'self-hosted') return ''
  if (runner.endsWith('-latest')) return `${runner} is a floating runner ref`
  if (/^(ubuntu|windows|macos)-\d+(?:\.\d+)?$/.test(runner)) return ''
  return `${runner} is not pinned to a concrete runner version`
}

function invalidActionPin(use) {
  if (use.startsWith('./') || use.startsWith('docker://')) return ''
  const at = use.lastIndexOf('@')
  if (at === -1) return `${use} has no ref`
  const ref = use.slice(at + 1)
  if (ref === 'latest' || ref === 'main' || ref === 'master') return `${use} uses floating ref`
  if (shaRef.test(ref) || versionRef.test(ref)) return ''
  return `${use} is not pinned to a full version or SHA`
}

export function validateWorkflowSafety(workflowDir = '.github/workflows') {
  if (!existsSync(workflowDir)) return [`missing workflow directory: ${workflowDir}`]
  const errors = []
  for (const file of workflowFiles(workflowDir)) {
    const workflow = parseWorkflow(file)
    if (hasWorkflowRunTrigger(workflow)) {
      if (!file.endsWith('/deploy.yml') && !file.endsWith('\\deploy.yml')) {
        errors.push(`${file} uses workflow_run outside deploy workflow`)
      }
      for (const [jobName, job] of Object.entries(jobsOf(workflow))) {
        if (!hasHardenedWorkflowRunJob(job)) errors.push(`${file} ${jobName} workflow_run job is missing push/repository guards`)
        for (const step of checkoutSteps(job)) {
          if (step.with?.ref !== workflowRunHeadRef) errors.push(`${file} ${jobName} workflow_run checkout is missing exact head_sha ref`)
        }
      }
    }
    for (const runner of runnerPins(workflow)) {
      const error = invalidRunnerPin(runner)
      if (error) errors.push(`${file}: ${error}`)
    }
    for (const use of actionUses(workflow)) {
      const error = invalidActionPin(use)
      if (error) errors.push(`${file}: ${error}`)
    }
  }
  return errors
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const errors = validateWorkflowSafety(process.argv[2] ?? '.github/workflows')
  for (const error of errors) console.error(`::error::${error}`)
  process.exit(errors.length === 0 ? 0 : 1)
}
