#!/usr/bin/env node
// REL004SecurityWorkflows
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const versionRef = /^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/
const shaRef = /^[a-f0-9]{40}$/i
const workflowRunHeadRef = '${{ github.event.workflow_run.head_sha || github.ref }}'

function workflowFiles(workflowDir) {
  return readdirSync(workflowDir)
    .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
    .map((name) => join(workflowDir, name))
}

function stripInlineComment(line) {
  let quote = ''
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]
    if ((char === '"' || char === "'") && line[index - 1] !== '\\') quote = quote === char ? '' : quote || char
    if (char === '#' && !quote && /\s/.test(line[index - 1] ?? ' ')) return line.slice(0, index).trimEnd()
  }
  return line.trimEnd()
}

function linesFromFile(file) {
  return readFileSync(file, 'utf8')
    .split('\n')
    .map(stripInlineComment)
    .filter((line) => line.trim() !== '')
}

function indentOf(line) {
  return line.match(/^\s*/)?.[0].length ?? 0
}

function hasWorkflowRunTrigger(lines) {
  return lines.some((line) => /^\s*workflow_run\s*:/.test(line))
}

function jobBlocks(lines) {
  const jobsIndex = lines.findIndex((line) => /^jobs\s*:/.test(line))
  if (jobsIndex < 0) return []
  const blocks = []
  let current
  for (let index = jobsIndex + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    if (indentOf(line) === 0 && /^\S/.test(line)) break
    const job = line.match(/^  ([A-Za-z0-9_-]+)\s*:\s*$/)
    if (job) {
      if (current) blocks.push(current)
      current = { name: job[1], lines: [line] }
      continue
    }
    if (current) current.lines.push(line)
  }
  if (current) blocks.push(current)
  return blocks
}

function hasHardenedWorkflowRunJob(job) {
  const normalized = job.lines.join(' ')
  return /\bif\s*:/.test(normalized) &&
    /github\.event\.workflow_run\.event\s*==\s*'push'/.test(normalized) &&
    /github\.event\.workflow_run\.head_repository\.full_name\s*==\s*github\.repository/.test(normalized)
}

function checkoutSteps(job) {
  const steps = []
  for (let index = 0; index < job.lines.length; index += 1) {
    const line = job.lines[index] ?? ''
    const match = line.match(/^(\s*)-\s+uses\s*:\s*(actions\/checkout@\S+)\s*$/)
    if (!match) continue
    const stepIndent = match[1].length
    const stepLines = [line]
    for (let next = index + 1; next < job.lines.length; next += 1) {
      const child = job.lines[next] ?? ''
      if (indentOf(child) <= stepIndent && /^\s*-\s+/.test(child)) break
      stepLines.push(child)
    }
    steps.push(stepLines)
  }
  return steps
}

function stepHasWorkflowRunHeadRef(stepLines) {
  return stepLines.some((line) => new RegExp(`^\\s*ref\\s*:\\s*${escapeRegExp(workflowRunHeadRef)}\\s*$`).test(line))
}

function actionUses(lines) {
  return lines
    .map((line) => line.match(/^\s*(?:-\s*)?uses\s*:\s*(\S+)\s*$/)?.[1])
    .filter(Boolean)
}

function runnerPins(lines) {
  const pins = []
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    const match = line.match(/^(\s*)runs-on\s*:\s*(.*?)\s*$/)
    if (!match) continue
    const [, indent = '', rawValue = ''] = match
    if (rawValue) {
      pins.push(...parseRunnerValue(rawValue))
      continue
    }
    for (let next = index + 1; next < lines.length; next += 1) {
      const child = lines[next] ?? ''
      const childIndent = indentOf(child)
      if (childIndent <= indent.length) break
      const item = child.match(/^\s*-\s*(.+?)\s*$/)?.[1]
      if (item) pins.push(...parseRunnerValue(item))
    }
  }
  return pins
}

function parseRunnerValue(value) {
  return value.replace(/[\[\]'"]/g, '').split(',').map((item) => item.trim()).filter(Boolean)
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

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function validateWorkflowSafety(workflowDir = '.github/workflows') {
  if (!existsSync(workflowDir)) return [`missing workflow directory: ${workflowDir}`]
  const errors = []
  for (const file of workflowFiles(workflowDir)) {
    const lines = linesFromFile(file)
    if (hasWorkflowRunTrigger(lines)) {
      if (!file.endsWith('/deploy.yml') && !file.endsWith('\\deploy.yml')) {
        errors.push(`${file} uses workflow_run outside deploy workflow`)
      }
      for (const job of jobBlocks(lines)) {
        if (!hasHardenedWorkflowRunJob(job)) errors.push(`${file} ${job.name} workflow_run job is missing push/repository guards`)
        for (const stepLines of checkoutSteps(job)) {
          if (!stepHasWorkflowRunHeadRef(stepLines)) errors.push(`${file} ${job.name} workflow_run checkout is missing exact head_sha ref`)
        }
      }
    }
    for (const runner of runnerPins(lines)) {
      const error = invalidRunnerPin(runner)
      if (error) errors.push(`${file}: ${error}`)
    }
    for (const use of actionUses(lines)) {
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
