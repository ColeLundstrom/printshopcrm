// Cross-process fixtures publish complete files. Each config has one writer; request records
// have unique paths. Atomic replacement prevents readers seeing a truncate/write intermediate.
import { writeFileSync, readFileSync, renameSync, rmSync, readdirSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

const pause = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,ms)
export function writeFixtureJson(path, value, { publish = renameSync, wait = pause } = {}) {
  const temporary = path + '.' + process.pid + '.' + randomUUID() + '.tmp'
  try {
    writeFileSync(temporary, JSON.stringify(value))
    // Windows may briefly refuse replacement while a reader/antivirus holds the old file.
    // Keep the complete old version visible; never fall back to truncate/write or delete it.
    // This is a bounded fixture publication retry, not a larger product/test timeout.
    for(let attempt=0;;attempt++) {
      try { publish(temporary,path);break }
      catch(error) {
        if(!['EPERM','EACCES','EBUSY'].includes(error.code) || attempt>=40)throw error
        wait(25)
      }
    }
  }
  finally { rmSync(temporary, { force: true }) }
}
export const readFixtureJson = path => JSON.parse(readFileSync(path, 'utf8'))
export const readFixtureRecords = directory => readdirSync(directory).filter(name => name.endsWith('.json')).sort().map(name => readFixtureJson(join(directory, name)))
