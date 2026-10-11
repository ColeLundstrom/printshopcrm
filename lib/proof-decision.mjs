/** Normalize one explicit public proof choice without letting a legacy alias override it. */
export function publicProofDecision(body) {
  const invalid = message => { throw Object.assign(new Error(message), { status: 400, code: 'invalid_decision' }) }
  if (!body || typeof body !== 'object' || Array.isArray(body)) invalid('Choose approved or rejected.')
  const hasDecision = Object.hasOwn(body, 'decision'), hasAlias = Object.hasOwn(body, 'approved')
  if (!hasDecision && !hasAlias) invalid('Missing decision — post decision=approved or decision=rejected')
  if (hasDecision && !['approved', 'rejected'].includes(body.decision)) invalid('Choose one decision: approved or rejected.')
  if (hasAlias && !['1', 'true', '0', 'false'].includes(body.approved)) invalid('The approved field must be 1, true, 0 or false.')
  const alias = hasAlias ? (['1', 'true'].includes(body.approved) ? 'approved' : 'rejected') : null
  // A conflicting hidden field or repeated form parameter must never become a sign-off.
  if (hasDecision && hasAlias && body.decision !== alias) invalid('Conflicting decisions. Choose approved or rejected and try again.')
  if (Object.hasOwn(body, 'notes') && typeof body.notes !== 'string') invalid('Proof notes must be text.')
  return { approved: (hasDecision ? body.decision : alias) === 'approved', notes: body.notes ?? '' }
}
