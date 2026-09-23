import test from 'node:test'
import assert from 'node:assert/strict'
process.env.PSC_DB = ':memory:'
const { parseSheet } = await import('../lib/matrices.mjs')

test('CSV and TSV preserve exact column positions, zero, blank, currency and quoted headings', () => {
  const sheet = parseSheet('\uFEFFQty,"Small, front","Large ""back"""\r\n1-11,0,"$1,234.56"\r\n12-23,,.25\r\n')
  assert.deepEqual(sheet, {cols:['Small, front','Large "back"'],rows:['1-11','12-23'],cells:[[0,1234.56],[null,.25]],filled:3,cornerLabel:'Qty'})
  assert.deepEqual(parseSheet('Qty\tSmall\tLarge\n1-11\t4.25\t\n12-23\t\t0').cells, [[4.25,null],[null,0]])
  assert.deepEqual(parseSheet('Qty,"Front\tprint",Back\n"One\nitem",1,2').cols,['Front print','Back'])
  assert.deepEqual(parseSheet('\nQty,A\nOne,2').rows,['One'])
})

test('malformed sheets fail instead of silently shifting, omitting or replacing prices', () => {
  const cases = [
    ['Qty,Small,,Large\n1-11,1,2,3',/Column 3 needs/],
    ['Qty,A\n,4',/Row 2 needs/],
    ['Qty,A,B\nOne,4',/Row 2 has 2 fields/],
    ['Qty,A\nOne,4,5',/Row 2 has 3 fields/],
    ['Qty,"A\nOne,4',/closing quote/],
    ['Qty,"A"x\nOne,4',/Unexpected text/],
    ['Qty,A,a\nOne,1,2',/Duplicate column/],
    ['Qty,A\nOne,1\none,2',/Duplicate row/],
    ['Qty,A\nOne,',/No prices/],
    ['Qty,'+'a'.repeat(49)+'\nOne,1',/exceeds 48/],
    ['Qty,A\n'+ 'a'.repeat(49)+',1',/exceeds 48/],
  ]
  for (const [text,error] of cases) assert.throws(()=>parseSheet(text),error)
  for (const price of ['abc','-1','=1+2','1e3','0x10','Infinity','"1,23"','900719925474100'])
    assert.throws(()=>parseSheet(`Qty,A\nOne,${price}`),/Invalid price|too large/)
})

test('size limits reject the entire sheet; the maximum complete grid succeeds', () => {
  const grid = (rows,cols) => [','+Array.from({length:cols},(_,i)=>'C'+i).join(','), ...Array.from({length:rows},(_,i)=>'R'+i+','+Array(cols).fill('1').join(','))].join('\n')
  assert.equal(parseSheet(grid(60,40)).filled,2400)
  assert.throws(()=>parseSheet(grid(61,40)),/at most 60 price rows/)
  assert.throws(()=>parseSheet(grid(60,41)),/at most 40 price columns/)
  assert.throws(()=>parseSheet('x'.repeat(2_000_001)),/2 MB/)
})
