import test from 'node:test'
import assert from 'node:assert/strict'
test('production snapshots, ordering, assignments, conflicts and receiving gates', async () => {
  process.env.PSC_DB = ':memory:'
  const { getDb, run, get, setSetting, initDb } = await import('../lib/db.mjs')
  const p = await import('../lib/production.mjs')
  const db = getDb()
  const { initSuppliers } = await import('../lib/suppliers.mjs')
  initSuppliers(db)
  try {
    run("INSERT INTO contacts(id,name) VALUES(1,'Synthetic shop')")
    run(
      "INSERT INTO jobs(id,contact_id,job_number,title,decoration,stage,status) VALUES(1,1,'JOB-1','Old job','Screen Print','production','active')"
    )
    initDb(db)
    assert.equal(p.workflow(1).revision, 0)
    const t = p.templates()[0],
      members = [{ id: 1, status: 'active' }]
    const w = p.applyWorkflow(1, { revision: 0, template_ids: [t.id] }, 'Manager')
    const changed = p.saveTemplate(
      t.id,
      { ...t, revision: t.revision, steps: t.steps.map((s) => ({ ...s, title: s.title + ' updated' })) },
      members
    )
    assert.equal(p.workflow(1).tasks[0].title, 'Receive and count')
    assert.throws(() => p.saveTemplate(t.id, { ...t, revision: t.revision }, members), /changed/)
    assert.throws(
      () =>
        p.transitionTask(1, w.tasks[1].id, { revision: w.revision, action: 'complete' }, { manager: true }),
      /earlier tasks/
    )
    run("INSERT INTO purchase_orders(id,job_id,status) VALUES(1,1,'submitted')")
    run('INSERT INTO po_lines(po_id,qty_ordered,qty_received) VALUES(1,10,9)')
    assert.throws(
      () =>
        p.transitionTask(1, w.tasks[0].id, { revision: w.revision, action: 'complete' }, { manager: true }),
      /quantities/
    )
    run('UPDATE po_lines SET qty_received=10')
    let after = p.transitionTask(
      1,
      w.tasks[0].id,
      { revision: w.revision, action: 'complete' },
      { manager: true, name: 'Receiver' }
    )
    assert.equal(after.tasks[0].status, 'done')
    assert.equal(get('SELECT stage FROM jobs WHERE id=1').stage, 'art_approval')
    assert.throws(
      () =>
        p.transitionTask(1, w.tasks[0].id, { revision: w.revision, action: 'complete' }, { manager: true }),
      /changed/
    )
    after = p.editTask(
      1,
      after.tasks[1].id,
      { ...after.tasks[1], revision: after.revision, assigned_id: 1 },
      'Manager',
      members
    )
    assert.throws(
      () =>
        p.transitionTask(1, after.tasks[1].id, { revision: after.revision, action: 'complete' }, { id: 2 }),
      /another employee/
    )
    assert.throws(
      () =>
        p.editTask(
          1,
          after.tasks[1].id,
          { ...after.tasks[1], revision: after.revision, assigned_id: 99 },
          'Manager',
          members
        ),
      /active employee/
    )
    run('UPDATE jobs SET art_approved_at=CURRENT_TIMESTAMP WHERE id=1')
    after = p.transitionTask(
      1,
      after.tasks[1].id,
      { revision: after.revision, action: 'complete' },
      { id: 1, name: 'Artist' }
    )
    assert.throws(
      () =>
        p.transitionTask(
          1,
          after.tasks[0].id,
          { revision: after.revision, action: 'reopen', note: 'Fix' },
          { manager: true }
        ),
      /later tasks/
    )
    assert.throws(() => p.guardWorkflowStage(1, 'complete'), /production tasks/)
    setSetting('production_auto', '1')
    run(
      "INSERT INTO jobs(id,contact_id,job_number,title,decoration,stage,status) VALUES(2,1,'JOB-2','New job','Screen Print','new','active')"
    )
    assert.equal(p.workflow(2).tasks[0].title, changed.steps[0].title)
    run("INSERT INTO purchase_orders(job_id,status) VALUES(2,'received')")
    const before = p.workflow(2)
    db.exec("CREATE TRIGGER fail_task BEFORE UPDATE ON jobs BEGIN SELECT RAISE(ABORT,'failure'); END")
    assert.throws(
      () =>
        p.transitionTask(
          2,
          before.tasks[0].id,
          { revision: before.revision, action: 'complete' },
          { manager: true }
        ),
      /failure/
    )
    assert.deepEqual(p.workflow(2), before)
    db.exec('DROP TRIGGER fail_task')
    const custom=p.saveTemplate(null,{name:'Custom repeated combination',match_text:'mixed',steps:[{title:'Pack review',department:'QC',stage:'qc',gate:'',assigned_id:1},{title:'Final production',department:'Finishing',stage:'production',gate:'',assigned_id:1}]},members)
    for(const id of [3,4])run("INSERT INTO jobs(id,contact_id,job_number,title,decoration,stage,status) VALUES(?,1,?,'Combined work','mixed','new','active')",id,'JOB-'+id)
    run("INSERT INTO jobs(id,contact_id,job_number,title,decoration,stage,status) VALUES(5,1,'JOB-5','Manual selection','custom','new','active')")
    p.applyWorkflow(5,{revision:0,template_ids:[custom.id]},'Manager')
    for(const id of [3,4,5])assert.deepEqual(p.workflow(id).tasks.map(t=>t.title),['Pack review','Final production'])
    const one=p.workflow(3)
    p.editTask(3,one.tasks[0].id,{...one.tasks[0],title:'Only this order',revision:one.revision},'Manager',members)
    assert.equal(p.workflow(4).tasks[0].title,'Pack review')
    assert.equal(p.templates().find(t=>t.id===custom.id).steps[0].title,'Pack review')
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok')
    assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0)
  } finally {
    db.close()
  }
})
