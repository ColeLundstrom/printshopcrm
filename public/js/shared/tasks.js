/**
 * The things a shop actually comes here to do, in its own words.
 *
 * The sidebar is a map of the product; this is the list of verbs. Home leads with it and the "New"
 * button in the top bar opens it on every screen, so "I want to make a mockup" is one click from
 * anywhere instead of a hunt through Job Board → job → art card. Each entry lands on a guided
 * screen that asks one question at a time, not on a blank form.
 */
export const TASKS = [
  { key: 'estimate', href: '#/do/estimate', ico: 'estimates', title: 'Make an estimate', sub: 'Pick the customer and the shirts. We do the math.', primary: true },
  { key: 'mockup', href: '#/do/mockup', ico: 'art', title: 'Make a mockup', sub: 'Put their artwork on a product photo.', primary: true, pro: true },
  { key: 'followups', href: '#/auto-follow-ups', ico: 'followups', title: 'Automatic follow-ups', sub: 'Chase quotes, proofs and invoices for you.', primary: true, manage: true },
  { key: 'customer', href: '#/contacts?new=1', ico: 'customers', title: 'Add a customer', sub: 'Name and email is enough.' },
  { key: 'job', href: '#/board', ico: 'board', title: 'Check on a job', sub: 'See where every order is.', pro: true },
  { key: 'paid', href: '#/followups', ico: 'invoices', title: 'See who owes you', sub: 'Quotes waiting and invoices unpaid.' },
  { key: 'messages', href: '#/conversations', ico: 'conversations', title: 'Reply to customers', sub: 'Texts, emails and web chats in one inbox.', pro: true },
]

/** The tasks this edition and this person can actually finish. */
export function tasksFor(me = {}, edition = 'pro') {
  return TASKS.filter((t) => !(t.pro && edition === 'lite') && !(t.manage && me.can_manage === false))
}

const tile = (t) => `<a class="task-tile${t.primary ? ' primary' : ''}" href="${t.href}" data-task="${t.key}">
  <span class="task-ic"><svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><use href="#i-${t.ico}"></use></svg></span>
  <span class="task-t">${t.title}</span>
  <span class="task-s">${t.sub}</span>
</a>`

/** The big three, then the rest as smaller tiles. */
export function taskTiles(me, edition) {
  const list = tasksFor(me, edition)
  const big = list.filter((t) => t.primary), small = list.filter((t) => !t.primary)
  return `<div class="task-grid big">${big.map(tile).join('')}</div>
    ${small.length ? `<div class="task-grid small">${small.map(tile).join('')}</div>` : ''}`
}
