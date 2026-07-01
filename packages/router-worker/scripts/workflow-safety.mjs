#!/usr/bin/env node
// REL004SecurityWorkflows
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const versionRef = /^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/
const shaRef = /^[a-f0-9]{40}$/i

function workflowFiles(workflowDir) {
  return readdirSync(workflowDir)
    .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
    .map((name) => join(workflowDir, name))
}

function activeLines(text) {
  return text.split('\n').filter((line) => !line.trimStart().startsWith('#'))
}

function hasWorkflowRunTrigger(lines) {
  return lines.some((line) => /^\s*workflow_run\s*:/.test(line))
}

function hasHardenedWorkflowRunJob(lines) {
  const normalized = lines.join(' ')
  return /\bif\s*:/.test(normalized) &&
    /github\.event\.workflow_run\.event\s*==\s*'push'/.test(normalized) &&
    /github\.event\.workflow_run\.head_repository\.full_name\s*==\s*github\.repository/.test(normalized)
}

function hasHardenedCheckoutRef(lines) {
  for (let index = 0; index < lines.length; index += 1) {
    if (!/^\s*-\s+uses\s*:\s*actions\/checkout@/.test(lines[index] ?? '')) continue
    const stepIndent = (lines[index] ?? '').match(/^\s*/)?.[0].length ?? 0
    for (let next = index + 1; next < lines.length; next += 1) {
      const line = lines[next] ?? ''
      const indent = line.match(/^\s*/)?.[0].length ?? 0
      if (indent <= stepIndent && /^\s*-\s+/.test(line)) break
      if (/^\s*ref\s*:\s*\$\{\{\s*github\.event\.workflow_run\.head_sha\s*\|\|\s*github\.ref\s*\}\}\s*$/.test(line)) return true
    }
  }
  return false
}

function actionUses(lines) {
  return lines
    .map((line) => line.match(/^\s*(?:-\s*)?uses\s*:\s*([^\s#]+)\s*$/)?.[1])
    .filter(Boolean)
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
    const lines = activeLines(readFileSync(file, 'utf8'))
    if (hasWorkflowRunTrigger(lines)) {
      if (!file.endsWith('/deploy.yml') && !file.endsWith('\\deploy.yml')) {
        errors.push(`${file} uses workflow_run outside deploy workflow`)
      }
      if (!hasHardenedWorkflowRunJob(lines)) errors.push(`${file} workflow_run job is missing push/repository guards`)
      if (!hasHardenedCheckoutRef(lines)) errors.push(`${file} workflow_run checkout is missing exact head_sha ref`)
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
