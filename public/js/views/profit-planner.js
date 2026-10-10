import { api, $, esc, moneyModel, setPage } from '../core.js'
import { calculateProfitQuote, calculateBreakEven, quantityPriceBreaks } from '../shared/profit-planning.js'

let visit = 0
const quoteFields = [
  ['quantity', 'Finished pieces', 144, 1, 1000000, 1],
  ['garment_cost', 'Blank cost / piece', '', 0],
  ['consumable_cost', 'Decoration supplies / piece', '', 0],
  ['spoilage_pct', 'Material allowance (%)', 2, 0, 100],
  ['setup_minutes', 'Setup minutes', '', 0],
  ['output_hour', 'Finished pieces / productive hour', '', 0.01],
  ['machine_rate', 'Machine operating cost / hour', '', 0],
  ['labor_rate', 'Loaded employee cost / hour', '', 0],
  ['overhead_rate', 'Shared overhead / productive hour', '', 0],
  ['other_cost', 'Other costs for this run', 0, 0],
  ['payment_pct', 'Payment processing fee (%)', 0, 0, 99.99],
  ['payment_flat', 'Fixed processing fee / order', 0, 0],
  ['target_margin_pct', 'Target profit margin (%)', 40, 0, 99.99],
]
const monthFields = [
  ['fixed_cost_month', 'Total fixed costs / month', '', 0],
  ['variable_cost_pct', 'Variable costs as % of sales', '', 0, 99.99],
  ['target_profit_month', 'Target profit / month', 0, 0],
  ['forecast_revenue', 'Forecast sales before tax', '', 0],
  ['productive_hours_month', 'Productive hours / month', '', 0.01],
]
const field = (prefix, [key, title, value, min, max, step = 'any']) => `<label class="field" for="${prefix}${key}">${esc(title)}<input id="${prefix}${key}" class="input" type="number" inputmode="decimal" required min="${min}" ${max === undefined ? '' : `max="${max}"`} step="${step}" value="${value}"></label>`
const inputs = (prefix, fields) => {
  const values = {}
  for (const [key] of fields) {
    const raw = $(`#${prefix}${key}`).value.trim()
    if (!raw) return null
    values[key] = Number(raw)
  }
  return values
}
const metrics = rows => `<div class="kpis">${rows.map(([label, value]) => `<div class="kpi"><div class="lbl">${label}</div><div class="val" style="font-size:24px">${value}</div></div>`).join('')}</div>`

export async function profitPlannerView() {
  const request = ++visit
  setPage('Profit planner', '<a class="btn ghost" href="#/costing/settings">Shop costs & machines</a><a class="btn ghost" href="#/costing">Job cost comparison</a>')
  $('#view').innerHTML = '<div id="profit-loading" role="status">Reading your shop cost setup…</div>'
  const loading = $('#profit-loading')
  try {
    const config = await api.get('/api/costing/config')
    if (request !== visit || !loading.isConnected) return
    render(config)
  } catch (error) {
    if (request !== visit || !loading.isConnected) return
    loading.innerHTML = `<p role="alert">${esc(error.message)}</p><button class="btn" id="profit-retry">Try again</button>`
    $('#profit-retry').onclick = profitPlannerView
  }
}

function render(config) {
  const machines = config.machines.filter(m => m.active)
  const employees = config.members.filter(m => m.status === 'active' && config.employees.some(e => e.member_id === m.id))
  $('#view').innerHTML = `<div id="profit-page" class="stack production-page">
    <div class="card card-b"><strong>Included in the free software</strong><p>Work backward from the margin you need, compare quantity breaks, and find the monthly sales that cover your shop. Calculations use your inputs, not a provider or AI account.</p><p class="dim">These are planning models, not actual profit or a customer quote. Scenarios are not saved and do not change existing quotes, price matrices, invoices or payments. Export your quantity sheet before leaving.</p></div>
    <section class="card card-b"><div class="row"><h2>Cost-plus pricing</h2><button id="profit-example" type="button" class="btn ghost">Try example costs</button></div>
    <p>Model one production operation, including setup. For several operations, include their complete cost in Other costs, or use a job’s machine cost records. Taxes are excluded.</p>
    <div class="prod-fields"><label class="field" for="profit-machine">Load a saved machine<select id="profit-machine" class="input"><option value="">Enter rates below</option>${machines.map(m => `<option value="${m.id}">${esc(m.name)}</option>`).join('')}</select></label>
    <label class="field" for="profit-employee">Load an employee cost<select id="profit-employee" class="input"><option value="">Enter loaded labor below</option>${employees.map(m => `<option value="${m.id}">${esc(m.name)}</option>`).join('')}</select></label></div>
    <p id="profit-input-basis" class="dim" role="status">Use your own cost records. No sample costs have been assumed.</p>
    <form id="profit-quote-form"><div class="prod-fields">${quoteFields.map(f => field('profit-', f)).join('')}</div></form>
    <p class="dim">Loaded labor includes employer costs. Machine cost excludes labor and shared overhead. The material allowance budgets extra blanks and supplies; it does not model replacement production time. Add that time to setup or lower output as appropriate. Processing fees are a planning allowance; confirm your processor’s actual rate. Do not count a cost twice.</p>
    <div id="profit-quote-results" aria-live="polite"></div>
    <div class="row"><h3>Quantity price breaks</h3><button type="button" class="btn ghost" id="profit-export" disabled>Export quantity sheet</button></div>
    <p class="dim">Same cost assumptions at each quantity, including the same one-time setup and Other costs. This is a modeled price floor, not proof that you can sell at that price.</p><div id="profit-breaks" style="overflow:auto"></div></section>
    <section class="card card-b"><h2>Monthly break-even & profit goal</h2><p>Fixed costs include overhead, fixed payroll and owner pay where appropriate. Variable cost percentage includes only costs that rise with sales, such as blanks, supplies, commissions and payment fees. Exclude sales tax and avoid counting fixed costs again in the variable percentage.</p>
    <p class="dim">Your saved shared overhead is ${moneyModel(config.settings.overhead_month)} per month. This is only one part of total fixed costs. Productive hours estimate all active machines’ scheduled hours × productive time; it does not guarantee staffing or demand.</p>
    <form id="profit-month-form"><div class="prod-fields">${monthFields.map(f => field('profit-month-', f)).join('')}</div></form><div id="profit-month-results" aria-live="polite"></div></section>
    <section class="card card-b"><h2>Close the loop with actual work</h2><p><a href="#/costing">Compare saved job, machine and employee cost records</a> · <a href="#/roi">Review modeled job profitability</a> · <a href="#/pipeline">Track quote conversion</a> · <a href="#/reorders">Find reorder opportunities</a></p><p class="dim">This planner does not import accounting statements, reconcile a general ledger, or verify external payment and supplier integrations.</p></section>
  </div>`
  const page = $('#profit-page')
  let priceRows = []
  const calculate = () => {
    if (!page.isConnected) return
    priceRows = []
    $('#profit-export').disabled = true
    $('#profit-breaks').innerHTML = ''
    try {
      const values = inputs('profit-', quoteFields)
      if (!values) { $('#profit-quote-results').innerHTML = '<p role="status">Enter your costs in every field, including an explicit zero when a cost does not apply.</p>'; return }
      const quote = calculateProfitQuote(values)
      priceRows = quantityPriceBreaks(values, [...new Set([12, 24, 48, 72, 144, 288, 576, values.quantity])].sort((a, b) => a - b))
      $('#profit-quote-results').innerHTML = metrics([
        ['Minimum modeled price / piece', moneyModel(quote.minimum_unit_price)], ['Sales before tax', moneyModel(quote.sell_total)],
        ['Modeled profit after fees', moneyModel(quote.modeled_profit)], ['Modeled profit margin', quote.modeled_margin_pct === null ? 'N/A' : quote.modeled_margin_pct.toFixed(2) + '%'],
      ]) + `<p>Modeled production: ${quote.total_minutes.toFixed(1)} minutes. Garments ${moneyModel(quote.costs.garments)} · supplies ${moneyModel(quote.costs.consumables)} · machine ${moneyModel(quote.costs.machine)} · labor ${moneyModel(quote.costs.labor)} · overhead ${moneyModel(quote.costs.overhead)} · other ${moneyModel(quote.costs.other)} · processing ${moneyModel(quote.processing_fee)}.</p><p class="dim">This planner rounds up to two decimal places per piece to meet your target and displays those decimals even for whole-unit currencies. Margin means profit ÷ sales, not markup on cost. The model excludes costs you have not entered.</p>`
      $('#profit-breaks').innerHTML = `<table class="tbl"><thead><tr><th>Pieces</th><th class="num">Min. price / piece</th><th class="num">Sales</th><th class="num">Modeled profit</th><th class="num">Margin</th></tr></thead><tbody>${priceRows.map(q => `<tr><td>${q.quantity}</td><td class="num">${moneyModel(q.minimum_unit_price)}</td><td class="num">${moneyModel(q.sell_total)}</td><td class="num">${moneyModel(q.modeled_profit)}</td><td class="num">${q.modeled_margin_pct === null ? 'N/A' : q.modeled_margin_pct.toFixed(2) + '%'}</td></tr>`).join('')}</tbody></table>`
      $('#profit-export').disabled = false
    } catch (error) { $('#profit-quote-results').innerHTML = `<p role="alert">${esc(error.message)}</p>` }
  }
  const monthly = () => {
    if (!page.isConnected) return
    try {
      const values = inputs('profit-month-', monthFields)
      if (!values) { $('#profit-month-results').innerHTML = '<p role="status">Enter all five monthly assumptions to see your break-even point.</p>'; return }
      const model = calculateBreakEven(values)
      $('#profit-month-results').innerHTML = metrics([
        ['Break-even sales / month', moneyModel(model.break_even_sales)], ['Sales for your profit goal', moneyModel(model.target_sales)],
        ['Forecast modeled profit', moneyModel(model.forecast_modeled_profit)], ['Target sales / productive hour', moneyModel(model.required_sales_per_hour)],
      ]) + `<p class="dim">Contribution margin ${model.contribution_margin_pct.toFixed(2)}%. Forecast profit is sales minus variable and fixed costs. This is an operating model, not cash flow, tax advice or a staffing plan.</p>`
    } catch (error) { $('#profit-month-results').innerHTML = `<p role="alert">${esc(error.message)}</p>` }
  }
  for (const [id, action] of [['profit-quote-form', calculate], ['profit-month-form', monthly]]) {
    $( '#' + id).oninput = action
    $( '#' + id).onsubmit = e => { e.preventDefault(); action() }
  }
  $('#profit-machine').onchange = () => {
    const machine = machines.find(m => String(m.id) === $('#profit-machine').value)
    if (!machine) return
    for (const [key, value] of Object.entries({ setup_minutes: machine.setup_minutes, output_hour: machine.output_hour, machine_rate: machine.hourly_cost, overhead_rate: config.overhead_rate ?? '' })) $('#profit-' + key).value = String(value)
    calculate()
  }
  $('#profit-employee').onchange = () => {
    const employee = config.employees.find(e => String(e.member_id) === $('#profit-employee').value)
    if (employee) { $('#profit-labor_rate').value = String(employee.hourly_cost); calculate() }
  }
  $('#profit-example').onclick = () => {
    const example = { quantity: 144, garment_cost: 4, consumable_cost: 0.5, spoilage_pct: 2, setup_minutes: 30, output_hour: 120, machine_rate: 10, labor_rate: 25, overhead_rate: 20, other_cost: 15, payment_pct: 3, payment_flat: 0.3, target_margin_pct: 40 }
    for (const [key, value] of Object.entries(example)) $('#profit-' + key).value = String(value)
    $('#profit-machine').value = ''; $('#profit-employee').value = ''
    $('#profit-input-basis').textContent = 'Example costs loaded. Review every value against your shop before using or exporting these prices.'
    calculate()
  }
  $('#profit-export').onclick = () => {
    if (!page.isConnected || !priceRows.length) return
    const csv = ['Quantity,Minimum modeled unit price,Sales before tax,Modeled cost before processing,Processing fee,Modeled profit,Modeled margin percent', ...priceRows.map(q => [q.quantity, q.minimum_unit_price, q.sell_total, q.total_cost, q.processing_fee, q.modeled_profit, q.modeled_margin_pct].join(','))].join('\r\n') + '\r\n'
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' })), link = document.createElement('a')
    link.href = url; link.download = 'printshopcrm-modeled-price-breaks.csv'; document.body.append(link); link.click(); link.remove()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  const productiveHours = machines.reduce((sum, m) => sum + m.hours_week, 0) * 52 / 12 * config.settings.productive_pct / 100
  if (productiveHours > 0) $('#profit-month-productive_hours_month').value = String(Math.round(productiveHours * 100) / 100)
  calculate(); monthly()
}
