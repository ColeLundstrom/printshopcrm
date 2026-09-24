import test from 'node:test'
import assert from 'node:assert/strict'
import {DatabaseSync} from 'node:sqlite'
import {contactTagFilter} from '../lib/contact-filters.mjs'

test('tag includes/exclusions combine literally without changing contacts',()=>{
 const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE contacts(id INTEGER,tags TEXT)')
 for(const [id,tags] of [[1,'school,repeat'],[2,'school'],[3,'repeat,overdue'],[4,''],[5,'100%,a_b'],[6,'100x,axb'],[7,"O'Brien"]])db.prepare('INSERT INTO contacts VALUES(?,?)').run(id,tags)
 const before=db.prepare('SELECT * FROM contacts').all()
 const find=q=>{const f=contactTagFilter(q);return db.prepare('SELECT c.id FROM contacts c WHERE 1=1'+f.sql+' ORDER BY id').all(...f.params).map(r=>r.id)}
 assert.deepEqual(find({tag:'school'}),[1,2]);assert.deepEqual(find({tag:['school','repeat']}),[1])
 assert.deepEqual(find({tag:['school','repeat'],tag_mode:'any'}),[1,2,3])
 assert.deepEqual(find({tag:['school','repeat'],tag_mode:'any',exclude_tag:'overdue'}),[1,2])
 assert.deepEqual(find({exclude_tag:['school','repeat']}),[4,5,6,7])
 assert.deepEqual(find({tag:'100%'}),[5]);assert.deepEqual(find({tag:'a_b'}),[5]);assert.deepEqual(find({tag:"O'Brien"}),[7])
 assert.deepEqual(find({tag:'SCHOOL'}),[1,2]);assert.deepEqual(find({tag:'school',exclude_tag:'school'}),[])
 assert.deepEqual(find({tag:'missing'}),[]);assert.deepEqual(find({tag:"' OR 1=1 --"}),[])
 assert.deepEqual(db.prepare('SELECT * FROM contacts').all(),before);db.close()
})
test('filter bounds reject malformed repeated parameters and keep an empty legacy tag valid',()=>{
 assert.deepEqual(contactTagFilter({tag:''}),{sql:'',params:[]})
 for(const q of [{tag:Array(21).fill('x')},{exclude_tag:'a,b'},{tag_mode:['all','any']},{tag_mode:'bad'},{tag:'x'.repeat(201)},{tag:{x:'x'}}])assert.throws(()=>contactTagFilter(q))
})
