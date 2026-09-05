export function pageOptions({ page = 1, pageSize = 50 } = {}) {
  const valid = (value, max) =>
    /^(?:[1-9]\d*)$/.test(String(value)) && Number.isSafeInteger(Number(value)) && Number(value) <= max
  if (!valid(page, 1000000) || !valid(pageSize, 100))
    throw Object.assign(new Error('Use a positive page number and a page size from 1 to 100'), {
      status: 400
    })
  return { page: Number(page), pageSize: Number(pageSize) }
}
export function pageRows(rows, options) {
  const { page, pageSize } = pageOptions(options)
  return {
    rows: rows.slice((page - 1) * pageSize, page * pageSize),
    page,
    page_size: pageSize,
    total: rows.length,
    pages: Math.max(1, Math.ceil(rows.length / pageSize))
  }
}
