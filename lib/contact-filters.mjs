// Parameterized, literal tag matching. '%' and '_' are tag text, never SQL wildcards.
export function contactTagFilter(query = {}) {
  const values = value => {
    const list = value === undefined ? [] : Array.isArray(value) ? value : [value]
    if (list.length > 20) throw new Error('Choose at most 20 tags per filter.')
    if (list.some(v => typeof v !== 'string' || v.length > 200 || /[\u0000-\u001f,]/.test(v)))
      throw new Error('Choose valid customer tags (up to 200 characters, without commas).')
    return [...new Set(list.map(v => v.trim()).filter(Boolean))]
  }
  const include = values(query.tag), exclude = values(query.exclude_tag)
  const mode = query.tag_mode ?? 'all'
  if (!['all','any'].includes(mode)) throw new Error('Tag matching must be all or any.')
  const clauses = [], params = []
  const match = "instr(',' || lower(COALESCE(c.tags,'')) || ',', ',' || lower(?) || ',')"
  if (include.length) { clauses.push('(' + include.map(() => match + ' > 0').join(mode === 'any' ? ' OR ' : ' AND ') + ')'); params.push(...include) }
  for (const tag of exclude) { clauses.push(match + ' = 0'); params.push(tag) }
  return { sql: clauses.length ? ' AND ' + clauses.join(' AND ') : '', params }
}

// One predicate for the screen and its export, retaining existing search semantics.
export function contactSearchFilter(query = {}) {
  const q = `%${String(query.q ?? '').toLowerCase()}%`, tags = contactTagFilter(query)
  return {
    sql: `(lower(c.name) LIKE ? OR lower(COALESCE(c.company,'')) LIKE ? OR lower(COALESCE(c.email,'')) LIKE ?)` + tags.sql,
    params: [q, q, q, ...tags.params],
  }
}
