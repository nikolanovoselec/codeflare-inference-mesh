import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

const root = new URL('../src', import.meta.url)
const violations = []

async function walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) await walk(path)
    if (entry.isFile() && path.endsWith('.ts')) {
      const text = await readFile(path, 'utf8')
      if (/console\.log\(/.test(text)) violations.push(`${path}: console.log is not allowed`)
    }
  }
}

await walk(root.pathname)
if (violations.length > 0) {
  process.stderr.write(`${violations.join('\n')}\n`)
  process.exit(1)
}
