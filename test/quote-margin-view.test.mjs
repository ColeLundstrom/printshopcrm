import { unsupportedScreenPrintMethods } from '../public/js/shared/capacity-scope.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { sizeTotal, guessColors, jobCost, lineBlankCost, lineBlankCostKnown, margin, marginVerdict, priceForMargin, raiseToSubtotal, computeTotals, valuePerHour } from '../public/js/shared/pricing.js'

// Execute the shipped editor calculation; only the DOM boundary is replaced. The slice runs from
// marginGuard through the gauge helpers that follow it, up to `const draw`.
const source=readFileSync(new URL('../public/js/views/estimates.js',import.meta.url),'utf8')
const start=source.indexOf('const marginGuard =')
const end=source.indexOf('\n  const draw',start)
assert(start>0 && end>start)
const fmt=value=>'$'+Number(value).toFixed(2)
function preview(items, revenue=288, settings={}) {
  const node={hidden:false,innerHTML:'',className:''}
  const ctx=vm.createContext({items,settings,up:{},$:()=>node,unsupportedScreenPrintMethods,sizeTotal,guessColors,jobCost,lineBlankCost,lineBlankCostKnown,margin,marginVerdict,priceForMargin,valuePerHour,
    esc:value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;'),money:fmt,money0:value=>'$'+Math.round(Number(value))})
  vm.runInContext(source.slice(start,end)+'\nmarginGuard('+revenue+');\nthis.__state=meterState;',ctx)
  node.state=ctx.__state ? {...ctx.__state} : null
  return node
}
const garment={description:'Sample tees',decoration:'Screen Print',sizes:{M:24},unit_price:12,blank_cost:4}
// 24 pcs × $4 × 1.02 spoilage + 15.6 auto-press minutes at $75 ÷ 30% + one $8 screen.
const COST=170.92

test('sales-tax exemption cannot erase garment, screen or labor costs',()=>{
  assert.deepEqual(preview([{...garment,taxable:false}]),preview([{...garment,taxable:true}]))
  assert.match(preview([garment]).innerHTML,/profit on/)
})
test('a below-target preview never calls the margin healthy',()=>{
  const result=preview([garment],600,{target_margin_pct:90})
  assert.match(result.innerHTML,/Below target/)
  assert.doesNotMatch(result.innerHTML,/Healthy/)
  assert.doesNotMatch(result.className,/pm-good|pm-strong/,'below the shop target is never painted in the healthy colour')
})
test('DTF, embroidery and mixed-method quotes do not show a screenprinting profit calculation',()=>{
  for(const items of [[{...garment,decoration:'DTF Transfer'}],[{...garment,decoration:'Embroidery'}],[garment,{...garment,decoration:'Laser'}],[{...garment,decoration:'',matrix:{name:'Contract Embroidery'}}],[{...garment,decoration:'Screen Print + Embroidery'}],[{...garment,decoration:''}]]) {
    const result=preview(items)
    assert.equal(result.hidden,false)
    assert.match(result.innerHTML,/Use Job costing/)
    assert.doesNotMatch(result.innerHTML,/Est\. margin|profit on|Raise to|data-pm-apply/)
    assert.equal(result.state,null,'nothing for Apply to act on')
  }
})
test('fees and discounts change revenue without inventing machine labor',()=>{
  const discount={description:'Discount',qty:1,unit_price:-10,taxable:true}
  const fee={description:'Shipping',qty:1,unit_price:20,taxable:false}
  assert.deepEqual(preview([garment,discount,fee],298),preview([garment],298))
})

test('the meter shows margin on a gauge with the shop target as a tick, plus profit, cost, revenue and $/press-hour',()=>{
  const result=preview([garment],400,{target_margin_pct:45})
  const m=margin(400,COST)
  assert.equal(result.hidden,false)
  assert.match(result.className,/^profit-meter pm-strong$/)
  assert.match(result.innerHTML,/<svg viewBox="0 0 200 112" aria-hidden="true"/)
  assert.match(result.innerHTML,/class="pm-tick"/)
  assert.match(result.innerHTML,/class="pm-tick-l"[^>]*>45%</)
  assert.match(result.innerHTML,/class="pm-needle"/)
  assert.match(result.innerHTML,new RegExp(`<span class="pm-pct">${m.margin}%</span>`))
  assert.ok(result.innerHTML.includes(`<dt>Profit</dt><dd>~${fmt(m.profit)}</dd>`))
  assert.ok(result.innerHTML.includes(`<dt>Cost</dt><dd>~${fmt(COST)}</dd>`))
  assert.ok(result.innerHTML.includes(`<dt>Revenue</dt><dd>${fmt(400)}</dd>`))
  assert.ok(result.innerHTML.includes(`<dt>Profit / press hr</dt><dd>$${valuePerHour(m.profit,15.6)}</dd>`))
})
test('tone follows marginVerdict: losing money is bad, thin is bad, tight is warn',()=>{
  assert.match(preview([garment],150).className,/pm-bad/)
  assert.match(preview([garment],150).innerHTML,/LOSING MONEY/)
  assert.match(preview([garment],200,{target_margin_pct:10}).className,/pm-bad/) // 14.5%: Too thin
  assert.match(preview([garment],270,{target_margin_pct:30}).className,/pm-warn/) // 36.7%: Tight
})

test('below target: the walk-away price is the exact priceForMargin of the shown cost, with a one-click Apply',()=>{
  const result=preview([garment],288,{target_margin_pct:45})
  const walk=priceForMargin(COST,45)
  assert.equal(walk,310.77)
  assert.ok(result.innerHTML.includes(`<strong>Raise to ${fmt(walk)}</strong> (${fmt(walk/24)}/pc) to hit your 45% target.`))
  assert.match(result.innerHTML,/data-pm-apply[^>]*>Apply \$310\.77</)
  assert.deepEqual(result.state,{cost:COST,floor:45,walk})
})
test('Apply reaches the target through the normal totals path, and the meter then agrees',()=>{
  const items=[structuredClone(garment),{description:'Setup',qty:1,unit_price:25,taxable:false},{description:'Discount',qty:1,unit_price:-10,taxable:true}]
  const before=computeTotals(items,8,{}).subtotal
  const shown=preview(items,before,{target_margin_pct:45})
  const plan=raiseToSubtotal(items,shown.state.walk,{})
  for(const c of plan.changes) items[c.index].unit_price=c.to
  const after=computeTotals(items,8,{}).subtotal
  assert.ok(after>=shown.state.walk)
  assert.equal(items[1].unit_price,25,'the setup fee is not scaled');assert.equal(items[2].unit_price,-10,'the negotiated discount is not shrunk')
  const result=preview(items,after,{target_margin_pct:45})
  assert.doesNotMatch(result.innerHTML,/Below target|Raise to|data-pm-apply/)
  assert.match(result.innerHTML,/Walk-away price at your 45% target/)
})
test('above target: shows the walk-away floor and the room above it, no Apply',()=>{
  const result=preview([garment],400,{target_margin_pct:45})
  assert.ok(result.innerHTML.includes(`Walk-away price at your 45% target: <strong>${fmt(310.77)}</strong> (${fmt(310.77/24)}/pc) · ${fmt(400-310.77)} of room.`))
  assert.doesNotMatch(result.innerHTML,/data-pm-apply/)
})
test('a line with no unit price to scale gets the walk-away price but no Apply',()=>{
  const result=preview([{...garment,unit_price:0},{description:'Flat',qty:1,unit_price:100,taxable:true}],100)
  assert.match(result.innerHTML,/Raise to/)
  assert.doesNotMatch(result.innerHTML,/data-pm-apply/)
})
test('an impossible target never produces a walk-away price',()=>{
  const result=preview([garment],288,{target_margin_pct:100})
  assert.match(result.innerHTML,/cannot be reached at any price/)
  assert.doesNotMatch(result.innerHTML,/Raise to|data-pm-apply|pm-tick"/)
  assert.equal(result.state.walk,null)
})

test('an unknown garment cost says what is missing instead of a margin built on a free blank',()=>{
  const result=preview([{description:'Custom order',decoration:'Screen Print',sizes:{M:24},unit_price:12}])
  assert.match(result.className,/pm-unknown/)
  assert.match(result.innerHTML,/No blank cost for line 1 \(“Custom order”\)/)
  assert.match(result.innerHTML,/at most \d+(\.\d)?% before garments/)
  assert.doesNotMatch(result.innerHTML,/Est\. margin<|profit on|Raise to|data-pm-apply|Healthy|Strong/)
  assert.equal(result.state,null,'Apply cannot act on an unknown cost')
  // A blank the shop told us costs nothing (customer-supplied matrix or an explicit 0) is known.
  assert.match(preview([{description:'Custom order',decoration:'Screen Print',sizes:{M:24},unit_price:12,matrix:{name:'Contract',decoration:'Screen Print',customerSupplied:true}}]).innerHTML,/profit on/)
  assert.match(preview([{description:'Garment — 1/0 Front',decoration:'Screen Print',sizes:{M:24},unit_price:12,garment_cost:0}]).innerHTML,/profit on/)
  // A recognised blank in the description is a known (catalogue) cost, as before.
  assert.match(preview([{description:'Gildan 5000 tees',decoration:'Screen Print',sizes:{M:24},unit_price:12}]).innerHTML,/profit on/)
})
test('an empty quote keeps the meter hidden rather than showing a fake 100%',()=>{
  assert.equal(preview([{...garment,sizes:{M:0}}]).hidden,true)
  assert.equal(preview([garment],0).hidden,true)
})
test('no money in the meter is formatted by hand',()=>{
  const slice=source.slice(start,end)
  assert.doesNotMatch(slice,/\$\$\{|toLocaleString/)
})
