import test from 'node:test'
import assert from 'node:assert/strict'
import { brandTokens, brandCss, contrast, validBrandColor } from '../public/js/shared/branding.js'
test('custom shop colors preserve readable text in both appearances and reject CSS injection', () => {
  for (const value of [
    'red',
    '#123',
    'url(https://example.test/x)',
    '#123456;}</style><script>x</script>',
    {},
    null
  ])
    assert.equal(validBrandColor(value), false)
  for (const primary of [
    '#000000',
    '#ffffff',
    '#ffff00',
    '#0000ff',
    '#ff0000',
    '#ff00ff',
    '#00ff00',
    '#123456'
  ])
    for (const mode of ['light', 'dark']) {
      const t = brandTokens({ brand_primary: primary, brand_secondary: primary }, mode),
        surface = mode === 'dark' ? '#1b2029' : '#eceff4'
      assert(contrast(t['--accent'], surface) >= 4.5)
      assert(contrast(t['--accent'], t['--accent-ink']) >= 4.5)
      assert(contrast(t['--accent-dim'], '#eafff8') >= 4.5)
      assert(contrast(t['--violet'], surface) >= 4.5)
      assert(contrast(t['--violet-solid'], '#ffffff') >= 4.5)
    }
  assert.deepEqual(brandTokens({}, 'dark'), {})
  assert(!brandCss({ brand_primary: '</style><script>bad</script>' }).includes('script'))
})
