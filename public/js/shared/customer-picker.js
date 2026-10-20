import { api, $, esc, toast, on } from '../core.js'

/**
 * "Who is it for?" — the first question of every guided flow.
 *
 * A search box over the customer list with the matches as big rows, and a three-field "new
 * customer" form right underneath for when they are not in the book yet. The estimate editor's
 * dropdown makes the shop scroll a <select> of every customer; this filters as they type and never
 * leaves the screen to add one.
 *
 * Calls onPick({ id, name, company, email }) once a customer is chosen or created.
 */
export async function customerPicker(root, onPick) {
  const { contacts } = await api.get('/api/contacts')
  root.innerHTML = `<div class="cp">
    <label class="sr-only" for="cp-q">Search customers</label>
    <input class="input cp-q" id="cp-q" type="search" autocomplete="off" placeholder="Type a name, company or email…">
    <div class="cp-list" id="cp-list" role="list"></div>
    <details class="cp-new" id="cp-new"${contacts.length ? '' : ' open'}>
      <summary>＋ New customer</summary>
      <form class="cp-form" id="cp-form" novalidate>
        <div class="grid3">
          <div class="field"><label for="cp-name">Name *</label><input class="input" id="cp-name" required autocomplete="off"></div>
          <div class="field"><label for="cp-email">Email</label><input class="input" id="cp-email" type="email" autocomplete="off"></div>
          <div class="field"><label for="cp-phone">Phone</label><input class="input" id="cp-phone" type="tel" autocomplete="off"></div>
        </div>
        <button class="btn primary" type="submit" id="cp-save">Add and continue →</button>
      </form>
    </details>
  </div>`

  const list = $('#cp-list', root)
  let nameTyped = false   // once the shop types in the Name box itself, the search stops filling it
  const draw = (q = '') => {
    const needle = q.trim().toLowerCase()
    const hits = (needle
      ? contacts.filter((c) => [c.name, c.company, c.email].some((v) => String(v || '').toLowerCase().includes(needle)))
      : contacts).slice(0, 8)
    list.innerHTML = hits.length
      ? hits.map((c) => `<button type="button" class="cp-row" role="listitem" data-id="${c.id}">
          <span class="cp-av" aria-hidden="true">${esc(String(c.name || '?').trim().charAt(0).toUpperCase())}</span>
          <span class="cp-txt"><span class="cp-n">${esc(c.name)}</span><span class="cp-d">${esc([c.company, c.email].filter(Boolean).join(' · ') || 'No email on file')}</span></span>
          <span class="cp-go" aria-hidden="true">Choose →</span></button>`).join('')
      : `<p class="dim cp-none">${needle ? `No customer matches “${esc(q.trim())}”. Add them below.` : 'No customers yet. Add your first one below.'}</p>`
    if (needle && !hits.length) {
      const nm = $('#cp-name', root)
      $('#cp-new', root).open = true
      // Most searches that miss are a name: carry it into the form so it is not typed twice.
      if (nm && !nameTyped && !needle.includes('@')) nm.value = q.trim()
    }
  }
  draw()
  $('#cp-name', root).addEventListener('input', () => { nameTyped = true })
  const q = $('#cp-q', root)
  q.addEventListener('input', () => draw(q.value))
  q.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return
    e.preventDefault()
    const first = list.querySelector('.cp-row')
    // Enter picks the top match; with no match it moves on to the new customer's email.
    if (first) first.click(); else $('#cp-email', root).focus()
  })
  on(list, '[data-id]', (_e, t) => {
    const c = contacts.find((x) => x.id === +t.dataset.id)
    if (c) onPick(c)
  })
  $('#cp-form', root).addEventListener('submit', async (e) => {
    e.preventDefault()
    const name = $('#cp-name', root).value.trim()
    if (!name) { toast('Type the customer’s name', true); $('#cp-name', root).focus(); return }
    const btn = $('#cp-save', root)
    btn.disabled = true
    try {
      const c = await api.post('/api/contacts', { name, email: $('#cp-email', root).value.trim(), phone: $('#cp-phone', root).value.trim() })
      toast(`Added ${c.name}`)
      onPick(c)
    } catch (err) { toast(err.message, true); btn.disabled = false }
  })
  q.focus()
}
