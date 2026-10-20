import { api, $, esc, setPage, toast, go, localDay } from '../core.js'
import { customerPicker } from '../shared/customer-picker.js'

/**
 * Start a job — for work that never needed a quote: the walk-in, the reorder agreed on the phone,
 * the shop's own merch. The Job Board's "+ New Job" form asks for everything at once; this asks who
 * it's for, then what it is and when it's due, and drops the job straight onto the board.
 */
export async function doJobView() {
  setPage('Start a job', '', '<a href="#/">Home</a> /')
  $('#view').innerHTML = `<div class="guide">
    <ol class="guide-steps" aria-label="Steps"><li class="on" aria-current="step" id="dj-s1"><span class="gs-n">1</span>Who is it for?</li><li id="dj-s2"><span class="gs-n">2</span>What and when?</li></ol>
    <section class="guide-card" style="max-width:760px" id="dj-body"></section>
  </div>`
  const body = $('#dj-body')
  const ask = (c) => {
    $('#dj-s1').className = 'done'; $('#dj-s1').removeAttribute('aria-current'); $('#dj-s1 .gs-n').textContent = '✓'
    $('#dj-s2').className = 'on'; $('#dj-s2').setAttribute('aria-current', 'step')
    const due = new Date(); due.setDate(due.getDate() + 14)
    body.innerHTML = `<form id="dj-form" novalidate>
      <div class="guide-who">For <strong>${esc(c.name)}</strong> <button type="button" class="linkbtn" id="dj-change">Change</button></div>
      <h2 class="guide-q">What is it?</h2>
      <div class="field"><label for="dj-title" class="sr-only">Job name</label><input class="input" id="dj-title" autocomplete="off" placeholder="24 staff tees, front logo"></div>
      <div class="grid2">
        <div class="field"><label for="dj-garment">Item (optional)</label><input class="input" id="dj-garment" autocomplete="off" placeholder="Gildan 5000 Black"></div>
        <div class="field"><label for="dj-due">Due date</label><input class="input" id="dj-due" type="date" value="${localDay(due)}"></div>
      </div>
      <div class="field"><label for="dj-notes">Notes for the shop (optional)</label><textarea class="input" id="dj-notes" rows="3" placeholder="Sizes, ink colours, where it prints…"></textarea></div>
      <button class="btn primary big" type="submit" id="dj-go">Put it on the board →</button>
    </form>`
    $('#dj-change').onclick = () => doJobView()
    $('#dj-title').focus()
    $('#dj-form').addEventListener('submit', async (e) => {
      e.preventDefault()
      const title = $('#dj-title').value.trim()
      if (!title) { toast('Give the job a short name', true); $('#dj-title').focus(); return }
      const btn = $('#dj-go'); btn.disabled = true; btn.textContent = 'Starting…'
      try {
        const job = await api.post('/api/jobs', { contact_id: c.id, title, garment: $('#dj-garment').value.trim(), due_date: $('#dj-due').value || null, notes: $('#dj-notes').value.trim() })
        toast(`${job.job_number} is on the board`)
        go(`/jobs/${job.id}`)
      } catch (err) { toast(err.message, true); btn.disabled = false; btn.textContent = 'Put it on the board →' }
    })
  }
  body.innerHTML = '<h2 class="guide-q">Who is this job for?</h2><p class="guide-hint">Start typing their name. New customer? Add them right here.</p><div id="dj-picker"></div>'
  await customerPicker($('#dj-picker'), ask)
}
