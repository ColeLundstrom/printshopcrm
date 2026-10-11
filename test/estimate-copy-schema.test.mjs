import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { initEstimateCopySchema } from '../lib/estimate-copy-schema.mjs'

test('old quotes are backfilled without changes and future legacy inserts receive stable creation identities',()=>{
  const db=new DatabaseSync(':memory:')
  try {
    db.exec("PRAGMA foreign_keys=ON; CREATE TABLE contacts(id INTEGER PRIMARY KEY); CREATE TABLE estimates(id INTEGER PRIMARY KEY,contact_id INTEGER REFERENCES contacts(id) ON DELETE CASCADE,notes TEXT); INSERT INTO contacts VALUES(1); INSERT INTO estimates VALUES(1,1,'Historical quote'),(2,1,'Other quote');")
    const rows=db.prepare('SELECT * FROM estimates').all()
    initEstimateCopySchema(db)
    const identities=db.prepare('SELECT * FROM estimate_copy_identities ORDER BY estimate_id').all()
    assert.equal(identities.length,2);for(const row of identities)assert.match(row.identity,/^[a-f0-9]{32}$/)
    assert.notEqual(identities[0].identity,identities[1].identity);assert.deepEqual(db.prepare('SELECT * FROM estimates').all(),rows)
    db.exec("UPDATE estimates SET notes='Legitimate edit' WHERE id=2")
    initEstimateCopySchema(db);assert.deepEqual(db.prepare('SELECT * FROM estimate_copy_identities ORDER BY estimate_id').all(),identities)
    assert.throws(()=>db.prepare('UPDATE estimate_copy_identities SET identity=? WHERE estimate_id=1').run('a'.repeat(32)),/immutable/)
    // A prior app version inserts only its known estimate columns; the persisted trigger still runs.
    db.exec("INSERT INTO estimates(contact_id,notes) VALUES(1,'Legacy insert')")
    const created=db.prepare('SELECT * FROM estimate_copy_identities WHERE estimate_id=3').get();assert.match(created.identity,/^[a-f0-9]{32}$/)
    db.exec("DELETE FROM estimates WHERE id=3; INSERT INTO estimates(contact_id,notes) VALUES(1,'Reused row')")
    assert.notEqual(db.prepare('SELECT identity FROM estimate_copy_identities WHERE estimate_id=3').get().identity,created.identity)
    db.exec('DELETE FROM contacts WHERE id=1')
    assert.equal(db.prepare('SELECT count(*) n FROM estimate_copy_identities').get().n,0)
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[])
  } finally {db.close()}
})

test('an interrupted identity migration rolls back schema and backfill together',()=>{
  const db=new DatabaseSync(':memory:')
  try {
    db.exec('CREATE TABLE estimates(id INTEGER PRIMARY KEY); INSERT INTO estimates VALUES(1),(2)')
    db.function('randomblob',_size=>{throw Error('Synthetic entropy failure')})
    assert.throws(()=>initEstimateCopySchema(db),/Synthetic entropy failure/)
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='estimate_copy_identities'").get(),undefined)
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='estimate_copy_identity_insert'").get(),undefined)
    assert.equal(db.prepare('SELECT count(*) n FROM estimates').get().n,2)
  } finally {db.close()}
})
