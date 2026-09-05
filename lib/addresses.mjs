// Postal text is deliberately independent of tax calculation and carrier validation.
export function postalAddress(value, label = 'Address') {
  if (typeof value !== 'string') throw Object.assign(new Error(`${label} must be text.`), { status: 400, code: 'invalid_address', expose: true })
  const text = value.replace(/\r\n?/g, '\n').split('\n').map(line => line.trim()).filter(Boolean).join('\n')
  if (/[\u0000-\u0009\u000b-\u001f\u007f]/.test(text) || text.length > 600 || text.split('\n').length > 8)
    throw Object.assign(new Error(`${label} must fit within 8 lines and 600 characters, without control characters.`), { status: 400, code: 'invalid_address', expose: true })
  return text
}

export function postalPatch(body, current = {}, fields = ['billing_address', 'shipping_address']) {
  return Object.fromEntries(fields.map(key => [key, Object.hasOwn(body || {}, key)
    ? postalAddress(body[key], key === 'billing_address' ? 'Billing address' : 'Shipping address')
    : current[key] ?? '']))
}

export function postalDefaults(contact) {
  return { billing_address: contact?.billing_address || '', shipping_address: contact?.shipping_address || contact?.billing_address || '' }
}

export function initAddressSchema(db) {
  const add = (table, column, declaration) => {
    if (!db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === column))
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${declaration}`)
  }
  // One savepoint makes the additive columns, historical blanks and triggers indivisible.
  db.exec('SAVEPOINT postal_schema')
  try {
    for (const key of ['billing_address', 'shipping_address']) {
      add('contacts', key, "TEXT NOT NULL DEFAULT ''")
      add('estimates', key, 'TEXT')
      add('invoices', key, 'TEXT')
    }
    add('jobs', 'shipping_address', 'TEXT')
    if (!db.prepare('SELECT 1 FROM schema_migrations WHERE name=?').get('postal_address_snapshots_v1')) {
      // Previous releases never stored postal addresses. Do not fabricate historical addresses
      // from customer defaults filled in after migration.
      for (const table of ['estimates', 'invoices']) db.exec(`UPDATE ${table} SET billing_address=COALESCE(billing_address,''),shipping_address=COALESCE(shipping_address,'')`)
      db.exec("UPDATE jobs SET shipping_address=COALESCE(shipping_address,'')")
      db.prepare('INSERT INTO schema_migrations(name) VALUES(?)').run('postal_address_snapshots_v1')
    }
    // Every creation path (manual, API, import, assistant and reorder) snapshots the same defaults.
    // An explicit empty string is a deliberate blank; only omitted/NULL values inherit.
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS estimates_postal_snapshot AFTER INSERT ON estimates
      WHEN NEW.billing_address IS NULL OR NEW.shipping_address IS NULL BEGIN
        UPDATE estimates SET
          billing_address=COALESCE(NEW.billing_address,(SELECT billing_address FROM contacts WHERE id=NEW.contact_id),''),
          shipping_address=COALESCE(NEW.shipping_address,(SELECT COALESCE(NULLIF(shipping_address,''),billing_address) FROM contacts WHERE id=NEW.contact_id),'')
        WHERE id=NEW.id;
      END;
      CREATE TRIGGER IF NOT EXISTS invoices_postal_snapshot AFTER INSERT ON invoices
      WHEN NEW.billing_address IS NULL OR NEW.shipping_address IS NULL BEGIN
        UPDATE invoices SET
          billing_address=COALESCE(NEW.billing_address,(SELECT billing_address FROM estimates WHERE id=NEW.estimate_id AND contact_id IS NEW.contact_id),(SELECT billing_address FROM contacts WHERE id=NEW.contact_id),''),
          shipping_address=COALESCE(NEW.shipping_address,(SELECT shipping_address FROM estimates WHERE id=NEW.estimate_id AND contact_id IS NEW.contact_id),(SELECT COALESCE(NULLIF(shipping_address,''),billing_address) FROM contacts WHERE id=NEW.contact_id),'')
        WHERE id=NEW.id;
      END;
      CREATE TRIGGER IF NOT EXISTS jobs_postal_snapshot AFTER INSERT ON jobs
      WHEN NEW.shipping_address IS NULL BEGIN
        UPDATE jobs SET shipping_address=COALESCE(NEW.shipping_address,
          (SELECT shipping_address FROM invoices WHERE id=NEW.invoice_id AND contact_id IS NEW.contact_id),
          (SELECT shipping_address FROM estimates WHERE id=NEW.estimate_id AND contact_id IS NEW.contact_id),
          (SELECT COALESCE(NULLIF(shipping_address,''),billing_address) FROM contacts WHERE id=NEW.contact_id),'')
        WHERE id=NEW.id;
      END;
    `)
    db.exec('RELEASE postal_schema')
  } catch (error) {
    db.exec('ROLLBACK TO postal_schema; RELEASE postal_schema')
    throw error
  }
}
