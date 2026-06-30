import { readFileSync } from 'node:fs'

const uuidPattern = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i

export function parseD1DatabaseId(text) {
  const assignment = text.match(/database_id\s*=\s*"([^"]+)"/)
  if (assignment) return assignment[1]
  return text.match(uuidPattern)?.[0]
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const path = process.argv[2]
  const id = path ? parseD1DatabaseId(readFileSync(path, 'utf8')) : undefined
  if (!id) {
    console.error('Could not parse D1 database id')
    process.exit(1)
  }
  process.stdout.write(id)
}
