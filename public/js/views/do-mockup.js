import { api, $, esc, setPage, toast, go, fmtDate } from '../core.js'
import { customerPicker } from '../shared/customer-picker.js'

/**
 * Make a mockup — the front door.
 *
 * The composer (views/mockup-composer.js) saves its proof onto a job, so it lives at
 * /jobs/:id/mockup and the only way in was Job Board → open the job → the art card's "Create
 * mockup" button. Nobody thinking "I want to put this logo on a hoodie" goes looking there. This
 * screen asks the one question the composer needs answered — which order is it for? — and if there
 * is no order yet, makes one in two fields and goes straight on.
 */
export async function doMockupView() {
  setPage('Make a mockup', '', '<a href="#/">Home</a> /')
  const d = await api.get('/api/board')
  const jobs = (d.columns || []).flatMap((c) => c.jobs.map((j) => ({ ...j, stage_label: c.label || c.key })))
    // Newest work first: the order someone is mocking up is almost always the one just booked.
    .sort((a, b) => (b.id || 0) - (a.id || 0))

  $('#view').innerHTML = `<div class="guide">
    <ol class="guide-steps" aria-label="Steps"><li class="on" aria-current="step"><span class="gs-n">1</span>Which order is it for?</li><li><span class="gs-n">2</span>Place the artwork</li></ol>
    <div class="guide-split even">
      <section class="guide-card">
        <h2 class="guide-q">Pick the order</h2>
        <p class="guide-hint">The mockup is saved on the order so the customer can approve it.</p>
        ${jobs.length ? `<label class="sr-only" for="mk-q">Search orders</label>
          <input class="input cp-q" id="mk-q" type="search" autocomplete="off" placeholder="Search by customer, order name or number…">
          <div class="cp-list" id="mk-list" role="list"></div>`
          : '<p class="dim">No open orders yet. Start one on the right — it takes ten seconds.</p>'}
      </section>
      <section class="guide-card">
        <h2 class="guide-q">Or start a new order</h2>
        <p class="guide-hint">Don’t have an order yet? Pick the customer, name it, and you’re in.</p>
        <div id="mk-new"></div>
      </section>
    </div>
  </div>`

  const list = $('#mk-list')
  if (list) {
    const draw = (q = '') => {
      const n = q.trim().toLowerCase()
      const hits = (n ? jobs.filter((j) => [j.title, j.job_number, j.contact_name, j.company].some((v) => String(v || '').toLowerCase().includes(n))) : jobs).slice(0, 10)
      list.innerHTML = hits.length ? hits.map((j) => `<a class="cp-row" role="listitem" href="#/jobs/${j.id}/mockup">
          <span class="cp-av" aria-hidden="true"><svg viewBox="0 0 16 16"><use href="#i-orders"></use></svg></span>
          <span class="cp-txt"><span class="cp-n">${esc(j.title || 'Untitled order')}</span>
            <span class="cp-d">${esc([j.job_number, j.contact_name, j.stage_label, j.due_date ? `due ${fmtDate(j.due_date)}` : ''].filter(Boolean).join(' · '))}</span></span>
          <span class="cp-go" aria-hidden="true">Mock it up →</span></a>`).join('')
        : `<p class="dim cp-none">No open order matches “${esc(q.trim())}”. Start a new one instead.</p>`
    }
    draw()
    const q = $('#mk-q')
    q.addEventListener('input', () => draw(q.value))
    q.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); list.querySelector('.cp-row')?.click() } })
    q.focus()
  }

  const newBox = $('#mk-new')
  const askTitle = (c) => {
    newBox.innerHTML = `<form class="cp-form" id="mk-form" novalidate>
      <div class="guide-who">For <strong>${esc(c.name)}</strong> <button type="button" class="linkbtn" id="mk-change">Change</button></div>
      <div class="field"><label for="mk-title">What is it?</label><input class="input" id="mk-title" autocomplete="off" placeholder="Team hoodies, staff tees…"></div>
      <button class="btn primary big" type="submit" id="mk-go">Start mockup →</button>
    </form>`
    $('#mk-change').onclick = () => customerPicker(newBox, askTitle)
    $('#mk-title').focus()
    $('#mk-form').addEventListener('submit', async (e) => {
      e.preventDefault()
      const title = $('#mk-title').value.trim()
      if (!title) { toast('Give the order a short name', true); $('#mk-title').focus(); return }
      const btn = $('#mk-go'); btn.disabled = true; btn.textContent = 'Starting…'
      try {
        const job = await api.post('/api/jobs', { contact_id: c.id, title })
        go(`/jobs/${job.id}/mockup`)
      } catch (err) { toast(err.message, true); btn.disabled = false; btn.textContent = 'Start mockup →' }
    })
  }
  await customerPicker(newBox, askTitle)
  // The picker focuses its own search; on this screen the open-order search is the first question.
  if (list) $('#mk-q').focus()
}

