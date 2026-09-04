import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
const read = (name) => readFileSync(new URL('../' + name, import.meta.url), 'utf8')

test('container publication waits for the complete reusable CI workflow', () => {
  const publish = read('.github/workflows/publish-image.yml')
  assert.match(publish, /validate:\s*\n\s*uses: \.\/\.github\/workflows\/ci\.yml/)
  assert.match(publish, /publish:\s*\n\s*needs: validate/)
  assert.doesNotMatch(publish, /branches:\s*\[main\]/)
  assert.match(read('.github/workflows/ci.yml'), /workflow_call:/)
})

test('stable images are only published from a matching version tag', () => {
  const publish = read('.github/workflows/publish-image.yml')
  assert.match(publish, /refs\/tags\/v/)
  assert.match(publish, /package\.json/)
  assert.match(publish, /git merge-base --is-ancestor/)
})
