import test from 'node:test'
import assert from 'node:assert/strict'

test('workflow task completion stamps ship_date on shipping and announces each stage move', async () => {
  process.env.PSC_DB = ':memory:'
  const db = await import('../lib/db.mjs')
  const p = await import('../lib/production.mjs')
  const { initSuppliers } = await import('../lib/suppliers.mjs')
  initSuppliers(db.getDb())
  const moves = []
  db.onJobStage((e) => moves.push(e))
  db.run("INSERT INTO contacts(id,name) VALUES(1,'Workflow shop')")
  db.run("INSERT INTO jobs(id,contact_id,job_number,title,decoration,stage,status) VALUES(1,1,'JOB-1','Workflow job','Screen Print','new','active')")
  db.initDb(db.getDb())
  let w = p.applyWorkflow(1, { revision: 0, template_ids: [p.templates()[0].id] }, 'Manager')
  // Skip every task before the shipping one, as a manager would on a job that came in finished.
  for (const task of w.tasks.filter((t) => t.stage !== 'shipping')) {
    w = p.transitionTask(1, task.id, { revision: w.revision, action: 'skip', note: 'already done' }, { name: 'Manager', manager: true })
  }
  await null // the hook fires after the task's transaction commits
  const job = db.get('SELECT * FROM jobs WHERE id = 1')
  assert.equal(job.stage, 'shipping')
  // It never stamped on 'shipping' — only on 'complete' — so the packing slip fell back to the
  // booking date for every workflow job.
  assert.equal(job.ship_date, db.todayIso())
  assert.ok(moves.length >= 1, 'workflow moves are announced (job_scans, job.stage automations, board push)')
  assert.ok(moves.every((m) => m.source === 'workflow' && m.job_id === 1 && m.from !== m.to))
  assert.equal(moves.at(-1).to, 'shipping')
})

test('the assistant moves "the Wildcats job", announces it, and matches its text literally', async () => {
  process.env.PSC_DB = ':memory:'
  const db = await import('../lib/db.mjs')
  const { ask, MAX_MESSAGE } = await import('../lib/assistant.mjs')
  const moves = []
  db.onJobStage((e) => moves.push(e))
  db.run("INSERT INTO contacts(id,name) VALUES(10,'Northgate Wildcats Booster Club')")
  db.run("INSERT INTO jobs(id,contact_id,job_number,title,stage,status) VALUES(10,10,'JOB-2010','Spirit tees','new','active')")
  // The module docstring's own example. "the … job" is stripped down to the name.
  const r = await ask('move the Wildcats job to production')
  assert.match(r.reply, /Moved/)
  assert.equal(db.get('SELECT stage FROM jobs WHERE id=10').stage, 'production')
  assert.deepEqual(moves.map((m) => [m.job_id, m.from, m.to, m.source]), [[10, 'new', 'production', 'assistant']])
  // `_` and `%` are literal: an underscore used to match every active job.
  assert.match((await ask('move the _ job to qc')).reply, /couldn't find/)
  assert.equal(db.get('SELECT stage FROM jobs WHERE id=10').stage, 'production')
  // A pasted wall of text is capped instead of becoming a LIKE pattern SQLite refuses.
  const huge = await ask('move ' + 'x'.repeat(60000) + ' to qc')
  assert.equal(typeof huge.reply, 'string')
  assert.ok(MAX_MESSAGE <= 5000)
})
