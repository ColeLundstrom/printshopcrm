/**
 * Commit customer imports in bounded batches. The counters describe committed rows only.
 * The caller supplies its already-authorized tenant handle; this module never opens a database.
 */
export async function writeContactImport(db, contacts, { batchSize = 500, checkpoint = async () => {} } = {}) {
  let created = 0, duplicates = 0, skipped = 0, stopped = null
  try {
    const findEmail = db.prepare('SELECT id FROM contacts WHERE lower(email) = lower(?) LIMIT 1')
    // tax_exempt / tax_exempt_id / payment_term arrive only when the file stated them (lib/csv.mjs
    // mapContactRow). They were never written: a resale customer imported taxable and a Net 30
    // account imported Net 15. Columns an older database does not have yet are simply left out.
    const have = new Set(db.prepare('PRAGMA table_info(contacts)').all().map(c => c.name))
    const extra = ['tax_exempt', 'tax_exempt_id', 'payment_term'].filter(c => have.has(c))
    const TERMS = new Set(['due_on_receipt', 'net_15', 'net_30', 'net_45'])
    const extraValue = (c, col) => col === 'tax_exempt' ? (c.tax_exempt ? 1 : 0)
      : col === 'tax_exempt_id' ? String(c.tax_exempt_id || '')
        : TERMS.has(c.payment_term) ? c.payment_term : 'net_15'
    const insert = db.prepare(`INSERT INTO contacts (name, email, phone, company, notes, tags, billing_address, shipping_address, created_at, updated_at${extra.map(c => ', ' + c).join('')}) VALUES (?,?,?,?,?,?,?,?,?,?${extra.map(() => ',?').join('')})`)
    for (let offset = 0; offset < contacts.length; offset += batchSize) {
      let inBatch = false, batchCreated = 0, batchDuplicates = 0, batchSkipped = 0
      try {
        db.exec('BEGIN IMMEDIATE')
        inBatch = true
        for (const c of contacts.slice(offset, offset + batchSize)) {
          // Preview's snapshot can be stale after another import or request commits. This
          // check holds the write lock, so two imports cannot both add the same email.
          if (c.email && findEmail.get(c.email)) { batchDuplicates++; continue }
          db.exec('SAVEPOINT contact_import_row')
          try {
            const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19)
            const result = insert.run(c.name, c.email, c.phone, c.company, c.notes, c.tags, c.billing_address || '', c.shipping_address || '', stamp, stamp, ...extra.map(col => extraValue(c, col)))
            // RAISE(IGNORE) can return successfully without adding a contact. Its earlier
            // trigger writes still exist, so discard the whole row rather than count it.
            if (Number(result.changes) === 0) {
              db.exec('ROLLBACK TO contact_import_row; RELEASE contact_import_row')
              batchSkipped++
              continue
            }
            db.exec('RELEASE contact_import_row')
            batchCreated++
          } catch (error) {
            // A constraint can reject one row. Undo its trigger side effects too. A trigger
            // using RAISE(ROLLBACK) has already ended the batch, so it must stop the import.
            try { db.exec('ROLLBACK TO contact_import_row; RELEASE contact_import_row') }
            catch { throw error }
            if ((Number(error?.errcode) & 255) !== 19) throw error
            batchSkipped++
          }
        }
        db.exec('COMMIT')
        inBatch = false
        created += batchCreated
        duplicates += batchDuplicates
        skipped += batchSkipped
      } catch (error) {
        if (inBatch) { try { db.exec('ROLLBACK') } catch { /* SQLite may have rolled back already. */ } }
        throw error
      }
      await checkpoint() // runs after COMMIT; a maintenance limit must preserve these counts
      if (offset + batchSize < contacts.length) await new Promise(resolve => setImmediate(resolve))
    }
  } catch (error) { stopped = error }
  return { created, duplicates, skipped, stopped }
}
