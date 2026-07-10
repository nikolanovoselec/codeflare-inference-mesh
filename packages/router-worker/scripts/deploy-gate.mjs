#!/usr/bin/env node
// REL002AutoProductionDeploy
import { readFileSync } from 'node:fs'

function latestRequiredRun(rows, env) {
  const workflowName = env.WORKFLOW_NAME
  const headSha = env.GATE_SHA
  const requiredEvent = env.REQUIRED_EVENT ?? 'push'
  const requiredBranch = env.REQUIRED_BRANCH ?? 'main'
  const matches = rows
    .filter((row) => !workflowName || row.workflowName === workflowName || row.name === workflowName)
    .filter((row) => !headSha || row.headSha === headSha)
    .filter((row) => row.event === requiredEvent)
    .filter((row) => !requiredBranch || row.headBranch === requiredBranch)
    .sort((a, b) => Number(b.databaseId ?? 0) - Number(a.databaseId ?? 0))
  return matches[0]
}

export function evaluateDeployGate(rows, env = process.env) {
  const latest = latestRequiredRun(rows, env)
  if (!latest) return { status: 'pending' }
  if (latest.status !== 'completed') return { status: 'pending', run: latest }
  if (latest.conclusion === 'success') return { status: 'success', run: latest }
  if (latest.conclusion === 'skipped') return { status: 'pending', run: latest }
  return { status: 'failure', run: latest }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const input = readFileSync(0, 'utf8')
  const rows = JSON.parse(input)
  const result = evaluateDeployGate(rows)
  process.stdout.write(result.status)
  if (result.run?.url) process.stdout.write(` ${result.run.url}`)
  process.stdout.write('\n')
}
