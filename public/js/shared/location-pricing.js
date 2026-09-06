/** Saved per-location prices. No live matrix lookup: issued documents never reprice themselves. */
const fail = message => { throw Object.assign(new Error(message), {status:400, expose:true, code:'invalid_location_pricing'}) }
const amount = value => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 10000000) fail('Enter a valid nonnegative decoration or garment price.')
  return Math.round(value * 100) / 100
}
const label = (value, name, max=120) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x1f\x7f]/.test(value)) fail(`Enter a valid ${name}.`)
  return value.trim()
}
export function quantityBands(rows) {
  if (!Array.isArray(rows) || !rows.length || rows.length > 60) return null
  const bands = rows.map(s => {
    const text=String(s).trim().replaceAll(',',''); let m
    if ((m=text.match(/^(\d+)\s*[-–—]\s*(\d+)$/))) return {min:+m[1],max:+m[2]}
    if ((m=text.match(/^(\d+)\s*\+$/))) return {min:+m[1],max:null}
    if ((m=text.match(/^(\d+)$/))) return {min:+m[1],max:null,bare:true}
    return null
  })
  if (bands.some(b=>!b)) return null
  if (bands.every(b=>b.bare)) bands.forEach((b,i)=>{b.max=i+1<bands.length?bands[i+1].min-1:null;delete b.bare})
  else if (bands.some(b=>b.bare)) return null
  if (bands.some((b,i)=>b.min<0 || (b.max!==null&&b.max<b.min) || (i && (bands[i-1].max===null || b.min<=bands[i-1].max)))) return null
  return bands
}
export function locationPricing(item) {
  const p=item?.decoration_pricing
  if (p == null) return null
  if (p.version!==1 || !Array.isArray(p.locations) || !p.locations.length || p.locations.length>20) fail('A garment needs between 1 and 20 decoration locations.')
  const qty=item.sizes ? Object.values(item.sizes).reduce((s,n)=>s+Number(n||0),0) : Number(item.qty??item.quantity)
  if (!Number.isSafeInteger(qty) || qty<=0 || qty>1000000) fail('Enter the garment quantities before pricing its locations.')
  if(p.customer_supplied!=null && typeof p.customer_supplied!=='boolean') fail('Choose whether the customer supplies the garments.')
  const garment=amount(p.garment_price)
  if(p.customer_supplied && garment!==0) fail('Customer-supplied garments must have a zero garment charge.')
  let perPiece=garment, flat=0
  const locations=p.locations.map(l=>{
    if(!l || typeof l!=='object' || Array.isArray(l)) fail('Invalid decoration location.')
    if(l.matrix && (typeof l.matrix!=='object'||Array.isArray(l.matrix))) fail('Invalid saved matrix.')
    if(l.matrix) for(const key of ['name','row','col']) label(l.matrix[key], 'matrix '+key)
    const location=label(l.location,'location'), method=label(l.method,'decoration method')
    if (!['piece','flat'].includes(l.unit)) fail('Choose per-piece or flat decoration pricing.')
    let price=amount(l.price), row=l.matrix?.row || ''
    if (l.tiers!=null) {
      if (!Array.isArray(l.tiers)||!l.tiers.length||l.tiers.length>60) fail('The saved matrix quantity bands are invalid. Select the matrix again.')
      let match=null, previous=-1
      for (const t of l.tiers) {
        if (!t || !Number.isSafeInteger(t.min)||t.min<0||t.min<=previous||(t.max!==null&&(!Number.isSafeInteger(t.max)||t.max<t.min))) fail('The saved matrix quantity bands overlap or are invalid.')
        previous=t.max===null?Infinity:t.max
        label(t.row,'matrix row')
        if(t.price!==null) amount(t.price)
        if(qty>=t.min&&(t.max===null||qty<=t.max)) match=t
      }
      if (!match || match.price===null) fail(`${location}: no matrix price for ${qty} pieces. Select a priced quantity band.`)
      price=amount(match.price);row=match.row
    } else if (l.matrix && l.priced_qty!==qty) fail(`${location}: quantity changed. Reprice this location from its matrix.`)
    if(l.unit==='piece')perPiece+=price;else flat+=price
    return {...l,location,method,price,...(l.matrix?{matrix:{...l.matrix,row}}:{})}
  })
  perPiece=Math.round(perPiece*100)/100;flat=Math.round(flat*100)/100
  if(perPiece>10000000 || !Number.isSafeInteger(Math.round((qty*perPiece+flat)*100))) fail('The combined price is too large to store accurately.')
  return {qty,garment,perPiece,flat,locations,total:Math.round((qty*perPiece+flat)*100)/100}
}
export function normalizeLocationItem(item) {
  const result=locationPricing(item);if(!result)return item
  const p=item.decoration_pricing
  if (p.notes!=null && (typeof p.notes!=='string'||p.notes.length>2000)) fail('Garment notes must be text, at most 2,000 characters.')
  const notes=p.notes||''
  const details=result.locations.map(l=>`${l.location}: ${l.method}, ${l.price.toFixed(2)}${l.unit==='flat'?' flat':' / piece'}${l.matrix?` (${l.matrix.name}: ${l.matrix.row} · ${l.matrix.col})`:''}`)
  const detail=[notes,`Garment ${result.garment.toFixed(2)} / piece`,...details].filter(Boolean).join('; ')
  if(detail.length>2400) fail('Shorten the location names or notes so the complete pricing breakdown fits on the customer document.')
  const {matrix:_old,...rest}=item
  return {...rest,unit_price:result.perPiece,decoration:[...new Set(result.locations.map(l=>l.method))].join(' + '),
    detail,
    decoration_pricing:{version:1,customer_supplied:p.customer_supplied===true,garment_price:result.garment,notes,locations:result.locations}}
}
export function pickedLocation(pick, location) {
  return {location,method:pick.matrix.decoration||pick.matrix.name,unit:pick.unit,price:pick.price,matrix:pick.matrix,priced_qty:pick.qty,...(pick.quantity_tiers?{tiers:pick.quantity_tiers}:{})}
}
