import test from 'node:test'
import assert from 'node:assert/strict'
import { publicProofDecision } from '../lib/proof-decision.mjs'

test('public proof parsing preserves explicit decisions and all four legacy string aliases', () => {
  for (const [alias, approved] of [['1', true], ['true', true], ['0', false], ['false', false]]) {
    const decision = approved ? 'approved' : 'rejected'
    assert.deepEqual(publicProofDecision({ approved: alias }), { approved, notes: '' })
    assert.deepEqual(publicProofDecision({ decision, approved: alias, notes: 'Exact feedback\nSecond line' }), { approved, notes: 'Exact feedback\nSecond line' })
    assert.deepEqual(publicProofDecision({ decision }), { approved, notes: '' })
  }
  assert.deepEqual(publicProofDecision({ decision: 'approved', notes: '', unrelated: 'ignored' }), { approved: true, notes: '' })
})

test('public proof parsing refuses missing, ambiguous, repeated and non-text decision fields', () => {
  const invalid = [null, undefined, [], 'approved', {}, { notes: 'Feedback is not a decision' }]
  for (const value of [undefined, null, '', 'typo', 'APPROVED', ' approved', true, false, 1, 0, {}, ['approved'], ['approved', 'rejected']]) {
    invalid.push({ decision: value }, { decision: value, approved: '1' })
  }
  for (const value of [undefined, null, '', 'typo', 'TRUE', ' 1', true, false, 1, 0, {}, ['1'], ['1', '0']]) {
    invalid.push({ approved: value }, { decision: 'approved', approved: value })
  }
  for (const [decision, approved] of [['approved', '0'], ['approved', 'false'], ['rejected', '1'], ['rejected', 'true']]) invalid.push({ decision, approved })
  for (const notes of [undefined, null, 0, false, {}, ['one'], ['one', 'two']]) invalid.push({ decision: 'approved', notes })
  for (const body of invalid) assert.throws(() => publicProofDecision(body), { status: 400, code: 'invalid_decision' }, JSON.stringify(body))
})
