import { unsupportedScreenPrintMethods } from '../public/js/shared/capacity-scope.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { sizeTotal, guessColors, jobCost, lineBlankCost, margin, marginVerdict } from '../public/js/shared/pricing.js'

// Execute the shipped editor calculation; only the DOM boundary is replaced.
const source=readFileSync(new URL('../public/js/views/estimates.js',import.meta.url),'utf8')
const start=source.indexOf('const marginGuard =')
const end=source.indexOf('\n  const draw',start)
assert(start>0 && end>start)
function preview(items, revenue=288, settings={}) {
  const node={hidden:false,innerHTML:'',className:''}
  const ctx=vm.createContext({items,settings,$:()=>node,unsupportedScreenPrintMethods,sizeTotal,guessColors,jobCost,lineBlankCost,margin,marginVerdict,
    esc:value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;'),money:value=>'$'+Number(value).toFixed(2)})
  vm.runInContext(source.slice(start,end)+'\nmarginGuard('+revenue+');',ctx)
  return node
}
const garment={description:'Sample tees',decoration:'Screen Print',sizes:{M:24},unit_price:12,blank_cost:4}

test('sales-tax exemption cannot erase garment, screen or labor costs',()=>{
  assert.deepEqual(preview([{...garment,taxable:false}]),preview([{...garment,taxable:true}]))
  assert.match(preview([garment]).innerHTML,/profit on/)
})
test('a below-target preview never calls the margin healthy',()=>{
  const result=preview([garment],600,{target_margin_pct:90})
  assert.match(result.innerHTML,/Below target/)
  assert.doesNotMatch(result.innerHTML,/Healthy/)
})
test('DTF, embroidery and mixed-method quotes do not show a screenprinting profit calculation',()=>{
  for(const items of [[{...garment,decoration:'DTF Transfer'}],[{...garment,decoration:'Embroidery'}],[garment,{...garment,decoration:'Laser'}],[{...garment,decoration:'',matrix:{name:'Contract Embroidery'}}],[{...garment,decoration:'Screen Print + Embroidery'}],[{...garment,decoration:''}]]) {
    const result=preview(items)
    assert.equal(result.hidden,false)
    assert.match(result.innerHTML,/Use Job costing/)
    assert.doesNotMatch(result.innerHTML,/Est\. margin|profit on/)
  }
})
test('fees and discounts change revenue without inventing machine labor',()=>{
  const discount={description:'Discount',qty:1,unit_price:-10,taxable:true}
  const fee={description:'Shipping',qty:1,unit_price:20,taxable:false}
  assert.deepEqual(preview([garment,discount,fee],298),preview([garment],298))
})
