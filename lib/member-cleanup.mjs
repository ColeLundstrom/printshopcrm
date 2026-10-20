/**
 * What a shop's own database still says about a member after that member is removed.
 *
 * Member identity lives in the control db, but four per-shop tables key by member id: the Slack
 * assistant's user links, costing hourly rates, the production department preference, and task
 * assignments. Removing the member left all of them behind, and because members.id could be
 * re-issued (see the member identity sequence in lib/tenants.mjs), a removed employee's Slack link
 * resolved to whoever was hired next. Ids are no longer reused, but a removed person's Slack user
 * must also stop being able to act at all, and their open tasks go back to the unassigned queue
 * instead of sitting on someone who can no longer sign in.
 *
 * Runs inside the shop's tenant context (the DELETE /api/members/:id request). Completed and
 * skipped tasks keep their assignment as history.
 */
import { all, run, tx, now } from './db.mjs'

export function forgetMember(memberId) {
  const id = Number(memberId)
  if (!Number.isSafeInteger(id) || id <= 0) return
  const tables = new Set(all("SELECT name FROM sqlite_schema WHERE type='table'").map((r) => r.name))
  tx(() => {
    if (tables.has('slack_operator_members')) run('DELETE FROM slack_operator_members WHERE member_id=?', id)
    if (tables.has('costing_employees')) run('DELETE FROM costing_employees WHERE member_id=?', id)
    if (tables.has('production_preferences')) run('DELETE FROM production_preferences WHERE member_id=?', id)
    if (tables.has('production_tasks')) run("UPDATE production_tasks SET assigned_id=NULL,updated_at=? WHERE assigned_id=? AND status NOT IN ('done','skipped')", now(), id)
  })
}
