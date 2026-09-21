import test from 'node:test'
import assert from 'node:assert/strict'
import { mountDesktopNavigation } from '../public/js/shared/desktop-navigation.js'

function fixture({saved = null, blocked = false} = {}) {
  const clicks = {}, changes = {}, attributes = {}, writes = []
  const root = {dataset: {}, ownerDocument: {activeElement: null}}
  const navLink = {}
  const button = {addEventListener: (name, fn) => clicks[name] = fn, setAttribute: (k,v) => attributes[k] = v, focus: () => root.ownerDocument.activeElement = button}
  const sidebar = {contains: element => element === navLink}
  const media = {matches: true, addEventListener: (name, fn) => changes[name] = fn}
  let closed = 0
  mountDesktopNavigation({root, sidebar, button, media, read: () => {if(blocked) throw Error('Storage denied'); return saved}, write: value => {if(blocked) throw Error('Quota'); writes.push(value)}, closeMobileDrawer: () => closed++})
  return {root, button, attributes, writes, navLink, click: () => clicks.click(), resize: desktop => {media.matches = desktop; changes.change()}, closed: () => closed}
}
test('denied storage does not prevent repeated manual hide/show', () => {
  const f = fixture({blocked: true})
  f.click(); assert.equal(f.attributes['aria-expanded'], 'false'); assert.equal(f.button.textContent, 'Show navigation')
  f.click(); assert.equal(f.attributes['aria-expanded'], 'true'); assert.equal(f.button.textContent, 'Hide navigation')
})
test('desktop preference survives mobile use and focus leaves a hidden drawer on resize', () => {
  const f = fixture({saved:'collapsed'})
  f.resize(false); f.root.ownerDocument.activeElement = f.navLink
  f.click(); assert.deepEqual(f.writes, [])
  f.resize(true); assert.equal(f.closed(),1); assert.equal(f.root.ownerDocument.activeElement, f.button)
  assert.equal(f.root.dataset.navigation,'collapsed')
  f.click(); assert.deepEqual(f.writes,['expanded'])
})
