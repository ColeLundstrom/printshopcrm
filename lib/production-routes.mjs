import { promoOrderStatus, promoPricing, PROMO_SERVICES } from './promostandards.mjs'
import QRCode from 'qrcode'
import { all, get, run, tx, now, getSettings, setSetting, garmentLines } from './db.mjs'
import * as p from './production.mjs'
import { purchaseOrdersForJob } from './suppliers.mjs'
export function registerProductionRoutes(
  app,
  { requireRole, hasRole, listMembers, broadcast, origin, artUrl }
) {
  const safe = (fn) => async (req, res, next) => {
    try {
      await fn(req, res)
    } catch (e) {
      if (e.status) res.status(e.status).json({ error: e.message })
      else next(e)
    }
  }
  const team = (req) =>
    req.tenant
      ? listMembers(req.tenant.id).map(({ id, name, status }) => ({ id, name, status }))
      : [{ id: 0, name: 'Shop operator', status: 'active' }]
  const actor = (req) => ({
    name: req.member?.name || 'Shop operator',
    id: req.member?.id || null,
    manager: hasRole(req, 'manager')
  })
  const job = (id) => {
    const j = get('SELECT * FROM jobs WHERE id=?', Number(id))
    if (!j) throw Object.assign(new Error('Job not found'), { status: 404 })
    return j
  }
  const details = (j, req) => {
    const w = p.workflow(j.id)
    return {
      job: {
        id: j.id,
        job_number: j.job_number,
        title: j.title,
        stage: j.stage,
        status: j.status,
        decoration: j.decoration,
        garment: j.garment,
        quantities: j.quantities,
        sizes: j.sizes,
        due_date: j.due_date,
        rush: j.rush,
        notes: j.notes
      },
      ...w,
      counts: JSON.parse(get('SELECT counts FROM production_counts WHERE job_id=?', j.id)?.counts || '{}'),
      shipments: all('SELECT * FROM production_shipments WHERE job_id=? ORDER BY id', j.id),
      tasks: w.tasks.map((t) => ({ ...t, blocked: p.taskBlock(j, t, w.tasks) })),
      lines: JSON.parse(j.line_sizes || '[]'),
      pos: purchaseOrdersForJob(j.id).map((po) => ({
        ...po,
        supplier_check: get('SELECT payload,checked_at FROM supplier_order_checks WHERE po_id=?', po.id)
      })),
      art: all('SELECT * FROM art_versions WHERE job_id=? ORDER BY version DESC', j.id).map((a) => ({
        id: a.id,
        version: a.version,
        status: a.status,
        url: artUrl(a)
      })),
      members: team(req),
      manager: hasRole(req, 'manager')
    }
  }
  app.get(
    '/api/suppliers/promo',
    requireRole('manager'),
    safe((req, res) => {
      const s = getSettings()
      res.json({
        services: PROMO_SERVICES,
        credentials: { ss: !!(s.ss_account && s.ss_api_key), sanmar: !!(s.sanmar_user && s.sanmar_pass) }
      })
    })
  )
  app.post(
    '/api/suppliers/promo/pricing',
    requireRole('manager'),
    safe(async (req, res) => {
      try {
        res.json(await promoPricing(req.body?.provider, req.body?.product_id, getSettings()))
      } catch (e) {
        res.status(400).json({ error: e.message })
      }
    })
  )
  app.post(
    '/api/purchase-orders/:id/supplier-check',
    requireRole('manager'),
    safe(async (req, res) => {
      const po = get('SELECT * FROM purchase_orders WHERE id=?', Number(req.params.id))
      if (!po) return res.status(404).json({ error: 'Purchase order not found' })
      const provider =
        req.body?.provider ||
        (po.supplier === 'SanMar' ? 'sanmar' : po.supplier === 'S&S Activewear' ? 'ss' : '')
      try {
        const result = await promoOrderStatus(provider, po.po_number, getSettings())
        run(
          'INSERT INTO supplier_order_checks(po_id,provider,payload,checked_at) VALUES(?,?,?,?) ON CONFLICT(po_id) DO UPDATE SET provider=excluded.provider,payload=excluded.payload,checked_at=excluded.checked_at',
          po.id,
          provider,
          JSON.stringify(result),
          now()
        )
        res.json(result)
      } catch (e) {
        res.status(400).json({ error: e.message })
      }
    })
  )
  app.get(
    '/api/production',
    safe((req, res) => {
      const departments = all(
        "SELECT DISTINCT department FROM production_tasks UNION SELECT DISTINCT json_extract(s.value,'$.department') AS department FROM production_templates t,json_each(t.steps) s ORDER BY department"
      ).map((r) => r.department)
      const preferred = req.member
        ? get('SELECT department FROM production_preferences WHERE member_id=?', req.member.id)?.department ||
          ''
        : ''
      const department = String(req.query.department ?? preferred),
        mine = req.query.mine === '1'
      const queue = p.productionQueue({
        department,
        mine,
        memberId: req.member?.id ?? null,
        page: req.query.page ?? 1,
        pageSize: req.query.page_size ?? 50
      })
      res.json({
        ...queue,
        departments,
        department,
        preferred,
        members: team(req),
        manager: hasRole(req, 'manager'),
        auto: getSettings().production_auto === '1'
      })
    })
  )
  app.put(
    '/api/production/preference',
    safe((req, res) => {
      const department = String(req.body?.department || '')
        .trim()
        .slice(0, 60)
      if (req.member)
        run(
          'INSERT INTO production_preferences(member_id,department) VALUES(?,?) ON CONFLICT(member_id) DO UPDATE SET department=excluded.department',
          req.member.id,
          department
        )
      res.json({ department })
    })
  )
  app.put(
    '/api/production/auto',
    requireRole('manager'),
    safe((req, res) => {
      if (typeof req.body?.enabled !== 'boolean')
        return res.status(400).json({ error: 'enabled must be true or false' })
      setSetting('production_auto', req.body.enabled ? '1' : '0')
      res.json({ ok: true })
    })
  )
  app.get(
    '/api/production/templates',
    safe((req, res) =>
      res.json({ templates: p.templates(), members: team(req), manager: hasRole(req, 'manager') })
    )
  )
  app.post(
    '/api/production/templates',
    requireRole('manager'),
    safe((req, res) => res.json(p.saveTemplate(null, req.body, team(req))))
  )
  app.put(
    '/api/production/templates/:id',
    requireRole('manager'),
    safe((req, res) => res.json(p.saveTemplate(Number(req.params.id), req.body, team(req))))
  )
  app.get(
    '/api/production/jobs/:id',
    safe((req, res) => {
      if (req.query.shop && req.query.shop !== (req.tenant?.slug || 'local'))
        return res.status(403).json({ error: 'This label belongs to another shop. Sign in to that shop.' })
      res.json(details(job(req.params.id), req))
    })
  )
  app.get(
    '/api/production/jobs/:id/qr',
    safe(async (req, res) => {
      const j = job(req.params.id)
      const href = `${origin(req)}/#/production/jobs/${j.id}?shop=${encodeURIComponent(req.tenant?.slug || 'local')}`
      res
        .type('image/svg+xml')
        .set('Cache-Control', 'no-store')
        .send(await QRCode.toString(href, { type: 'svg', errorCorrectionLevel: 'Q', margin: 4 }))
    })
  )
  app.post(
    '/api/production/jobs/:id/counts',
    safe((req, res) => {
      const j = job(req.params.id),
        b = req.body || {},
        who = actor(req)
      tx(() => {
        const w = p.workflow(j.id),
          task = w.tasks.find((t) => t.status === 'pending')
        if (!w.revision || w.revision !== b.revision)
          throw Object.assign(new Error('Job changed. Refresh first.'), { status: 409 })
        if (
          !who.manager &&
          (!task || task.gate !== 'receiving' || (task.assigned_id !== null && task.assigned_id !== who.id))
        )
          throw Object.assign(new Error('This receiving task is not available to you.'), { status: 403 })
        const expected = JSON.parse(j.sizes || '{}'),
          old = JSON.parse(get('SELECT counts FROM production_counts WHERE job_id=?', j.id)?.counts || '{}'),
          counts = b.counts
        if (
          !counts ||
          Array.isArray(counts) ||
          typeof counts !== 'object' ||
          Object.keys(counts).length > 100
        )
          throw Object.assign(new Error('Provide received counts by size'), { status: 400 })
        for (const [size, n] of Object.entries(counts))
          if (
            !Object.hasOwn(expected, size) ||
            !Number.isSafeInteger(n) ||
            n < 0 ||
            n > Number(expected[size]) ||
            (!who.manager && n < Number(old[size] || 0))
          )
            throw Object.assign(
              new Error(
                'Counts must be whole units within the job’s size quantities. Managers correct previous counts.'
              ),
              { status: 400 }
            )
        const saved = { ...old, ...counts }
        run(
          'INSERT INTO production_counts(job_id,counts,counted_by,updated_at) VALUES(?,?,?,?) ON CONFLICT(job_id) DO UPDATE SET counts=excluded.counts,counted_by=excluded.counted_by,updated_at=excluded.updated_at',
          j.id,
          JSON.stringify(saved),
          who.name,
          now()
        )
        run('UPDATE production_jobs SET revision=revision+1 WHERE job_id=?', j.id)
        run(
          'INSERT INTO production_events(job_id,actor,action,detail) VALUES(?,?,?,?)',
          j.id,
          who.name,
          'garments.counted',
          JSON.stringify({ before: old, after: saved })
        )
      })
      broadcast('production', { job_id: j.id })
      res.json(details(j, req))
    })
  )
  app.post(
    '/api/production/jobs/:id/shipments',
    safe((req, res) => {
      const j = job(req.params.id),
        b = req.body || {},
        who = actor(req)
      tx(() => {
        const w = p.workflow(j.id),
          task = w.tasks.find((t) => t.status === 'pending')
        if (!w.revision || w.revision !== b.revision)
          throw Object.assign(new Error('Job changed. Refresh first.'), { status: 409 })
        if (
          !who.manager &&
          (!task || task.stage !== 'shipping' || (task.assigned_id !== null && task.assigned_id !== who.id))
        )
          throw Object.assign(new Error('This shipping task is not available to you.'), { status: 403 })
        const carrier = String(b.carrier || '').trim(),
          tracking = String(b.tracking_number || '').trim(),
          note = String(b.note || '').trim()
        if (!carrier || carrier.length > 60 || !tracking || tracking.length > 100 || note.length > 1000)
          throw Object.assign(
            new Error('Enter a carrier / pickup method and tracking number / collection reference.'),
            { status: 400 }
          )
        run(
          'INSERT INTO production_shipments(job_id,carrier,tracking_number,note,created_by) VALUES(?,?,?,?,?) ON CONFLICT(job_id,carrier,tracking_number) DO NOTHING',
          j.id,
          carrier,
          tracking,
          note,
          who.name
        )
        run('UPDATE production_jobs SET revision=revision+1 WHERE job_id=?', j.id)
        run(
          'INSERT INTO production_events(job_id,actor,action,detail) VALUES(?,?,?,?)',
          j.id,
          who.name,
          'shipment.recorded',
          JSON.stringify({ carrier, tracking, note })
        )
      })
      broadcast('production', { job_id: j.id })
      res.json(details(j, req))
    })
  )
  app.post(
    '/api/production/jobs/:id/receive/:po',
    safe((req, res) => {
      const j = job(req.params.id),
        b = req.body || {},
        who = actor(req)
      const result = tx(() => {
        const w = p.workflow(j.id),
          task = w.tasks.find((t) => t.status === 'pending')
        if (!w.revision || w.revision !== b.revision)
          throw Object.assign(new Error('Counts changed. Refresh before saving.'), { status: 409 })
        if (
          !who.manager &&
          (!task || task.gate !== 'receiving' || (task.assigned_id !== null && task.assigned_id !== who.id))
        )
          throw Object.assign(
            new Error('The receiving task must be available and assigned to you or unassigned.'),
            { status: 403 }
          )
        const po = get('SELECT * FROM purchase_orders WHERE id=? AND job_id=?', Number(req.params.po), j.id)
        if (!po || ['closed', 'cancelled'].includes(po.status))
          throw Object.assign(new Error('Open purchase order not found'), { status: 404 })
        if (
          !Array.isArray(b.counts) ||
          !b.counts.length ||
          b.counts.length > 1000 ||
          new Set(b.counts.map((c) => c?.line_id)).size !== b.counts.length
        )
          throw Object.assign(new Error('Provide unique receiving lines'), { status: 400 })
        const before = []
        for (const c of b.counts) {
          const line = get('SELECT * FROM po_lines WHERE id=? AND po_id=?', Number(c?.line_id), po.id)
          if (
            !line ||
            !Number.isSafeInteger(c.qty_received) ||
            c.qty_received < 0 ||
            c.qty_received > line.qty_ordered ||
            (!who.manager && c.qty_received < line.qty_received)
          )
            throw Object.assign(
              new Error(
                'Counts must be whole units within ordered quantities. A manager corrects previous counts.'
              ),
              { status: 400 }
            )
          before.push({ line_id: line.id, before: line.qty_received, after: c.qty_received })
          run('UPDATE po_lines SET qty_received=? WHERE id=?', c.qty_received, line.id)
        }
        const totals = get(
          'SELECT sum(qty_received) AS received,sum(qty_ordered) AS ordered FROM po_lines WHERE po_id=?',
          po.id
        )
        run(
          'UPDATE purchase_orders SET status=?,updated_at=? WHERE id=?',
          totals.received >= totals.ordered
            ? 'received'
            : totals.received > 0
              ? 'partial'
              : po.submitted_at
                ? 'submitted'
                : 'placed_manually',
          now(),
          po.id
        )
        run('UPDATE production_jobs SET revision=revision+1 WHERE job_id=?', j.id)
        run(
          'INSERT INTO production_events(job_id,task_id,actor,action,detail) VALUES(?,?,?,?,?)',
          j.id,
          task?.id || null,
          who.name,
          'received',
          JSON.stringify({ po: po.id, counts: before })
        )
        return details(j, req)
      })
      broadcast('production', { job_id: j.id })
      res.json(result)
    })
  )
  app.post(
    '/api/production/jobs/:id/workflow',
    requireRole('manager'),
    safe((req, res) => {
      const j = job(req.params.id)
      p.applyWorkflow(j.id, req.body, actor(req).name)
      broadcast('production', { job_id: j.id })
      res.json(details(job(j.id), req))
    })
  )
  app.post(
    '/api/production/jobs/:id/tasks',
    requireRole('manager'),
    safe((req, res) => {
      const j = job(req.params.id)
      p.editTask(j.id, null, req.body, actor(req).name, team(req))
      broadcast('production', { job_id: j.id })
      res.json(details(job(j.id), req))
    })
  )
  app.put(
    '/api/production/jobs/:id/tasks/:task',
    requireRole('manager'),
    safe((req, res) => {
      const j = job(req.params.id)
      p.editTask(j.id, Number(req.params.task), req.body, actor(req).name, team(req))
      broadcast('production', { job_id: j.id })
      res.json(details(job(j.id), req))
    })
  )
  app.post(
    '/api/production/jobs/:id/tasks/:task/action',
    safe((req, res) => {
      const j = job(req.params.id)
      p.transitionTask(j.id, Number(req.params.task), req.body, actor(req))
      broadcast('production', { job_id: j.id })
      res.json(details(job(j.id), req))
    })
  )
}
