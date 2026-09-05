// Cross-process fixtures publish complete files. Each config has one writer; request records
// have unique paths. Atomic replacement prevents readers seeing a truncate/write intermediate.
import { writeFileSync, readFileSync, renameSync, rmSync, readdirSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

export function writeFixtureJson(path, value) {
  const temporary = path + '.' + process.pid + '.' + randomUUID() + '.tmp'
  try { writeFileSync(temporary, JSON.stringify(value)); renameSync(temporary, path) }
  finally { rmSync(temporary, { force: true }) }
}
export const readFixtureJson = path => JSON.parse(readFileSync(path, 'utf8'))
export const readFixtureRecords = directory => readdirSync(directory).filter(name => name.endsWith('.json')).sort().map(name => readFixtureJson(join(directory, name)))
