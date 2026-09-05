import * as c from './costing.mjs'
export function registerCostingRoutes(app, { requireRole, listMembers }) {
  const safe = (fn) => async (req, res, next) => {
    try {
      res.json(await fn(req))
    } catch (e) {
      if (e.status) res.status(e.status).json({ error: e.message })
      else next(e)
    }
  }
  const team = (req) =>
    req.tenant
      ? listMembers(req.tenant.id).map(({ id, name, status }) => ({ id, name, status }))
      : [{ id: 0, name: 'Shop operator', status: 'active' }]
  const who = (req) => req.member?.name || 'Shop operator'
  app.get(
    '/api/costing/config',
    requireRole('manager'),
    safe((req) => ({ ...c.costingConfig(), members: team(req) }))
  )
  app.put(
    '/api/costing/config',
    requireRole('manager'),
    safe((req) => c.saveCostingConfig(req.body, team(req)))
  )
  app.post(
    '/api/costing/machines',
    requireRole('manager'),
    safe((req) => c.saveMachine(null, req.body))
  )
  app.put(
    '/api/costing/machines/:id',
    requireRole('manager'),
    safe((req) => c.saveMachine(Number(req.params.id), req.body))
  )
  app.get(
    '/api/costing/jobs/:id',
    requireRole('manager'),
    safe((req) => c.jobCosting(Number(req.params.id)))
  )
  app.put(
    '/api/costing/jobs/:id',
    requireRole('manager'),
    safe((req) => c.saveJobCosts(Number(req.params.id), req.body, who(req)))
  )
  app.post(
    '/api/costing/jobs/:id/operations',
    requireRole('manager'),
    safe((req) => c.saveOperation(Number(req.params.id), null, req.body, who(req), team(req)))
  )
  app.put(
    '/api/costing/jobs/:id/operations/:op',
    requireRole('manager'),
    safe((req) =>
      c.saveOperation(Number(req.params.id), Number(req.params.op), req.body, who(req), team(req))
    )
  )
  app.post(
    '/api/costing/jobs/:id/operations/:op/void',
    requireRole('manager'),
    safe((req) => c.voidOperation(Number(req.params.id), Number(req.params.op), req.body, who(req)))
  )
  app.get(
    '/api/costing/comparison',
    requireRole('manager'),
    safe((req) => c.costComparison({ page: req.query.page ?? 1, pageSize: req.query.page_size ?? 50 }))
  )
}
