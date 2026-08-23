import { api, $, $$, esc, money, setPage, empty, toast, on } from '../core.js'

/* Products / blank catalog — browse the built-in catalog and run live distributor lookups. */

export async function productsView() {
  setPage('Products')
  const data = await api.get('/api/products')
  const sup = data.suppliers || {}
  const connected = sup.connected
    ? `<span class="pill green">${sup.count} distributor${sup.count === 1 ? '' : 's'} live</span>`
    : `<span class="pill">catalog only</span>`

  const brands = Object.keys(data.byBrand).sort()
  $('#view').innerHTML = `<div class="stack" style="max-width:960px">
    <div class="card">
      <div class="card-h"><h3>Style lookup</h3><div class="spacer"></div>${connected}</div>
      <div class="card-b">
        <p class="dim" style="font-size:12.5px;line-height:1.6;margin-bottom:12px">Type a style number (<code>G500</code>, <code>3001C</code>, <code>PC61</code>) or a brand. Connect S&amp;S Activewear in Settings for live cost + inventory across S&amp;S and AlphaBroder; otherwise the built-in ${data.count}-style catalog answers instantly.</p>
        <div class="row" style="gap:8px">
          <input class="input" id="lookup" placeholder="e.g. G500 or bella hoodie" style="flex:1" autofocus>
          <button class="btn" id="go">Look up</button>
        </div>
        <div id="results" style="margin-top:14px"></div>
      </div>
    </div>

    <div class="card">
      <div class="card-h"><h3>Built-in catalog</h3><div class="spacer"></div><span class="pill">${data.count} styles</span></div>
      <div class="card-b">
        ${brands.map((b) => `<div class="brandblock">
          <div class="brandname">${esc(b)}</div>
          <div class="tbl-wrap"><table class="tbl"><tbody>
            ${data.byBrand[b].map((g) => `<tr>
              <td style="width:74px"><span class="tag">${esc(g.style)}</span></td>
              <td>${esc(g.name)}</td>
              <td class="dim" style="font-size:12px">${esc(g.type)}</td>
              <td class="num" style="font-weight:600">${money(g.cost)}</td>
            </tr>`).join('')}
          </tbody></table></div>
        </div>`).join('')}
      </div>
    </div>
  </div>`

  const runLookup = async () => {
    const style = $('#lookup').value.trim()
    if (!style) return
    $('#results').innerHTML = '<div class="dim" style="font-size:12.5px">Searching…</div>'
    try {
      const r = await api.get(`/api/suppliers/lookup?style=${encodeURIComponent(style)}`)
      const rows = r.products || []
      if (!rows.length) { $('#results').innerHTML = `<div class="dim" style="font-size:12.5px">No match for “${esc(style)}”. Try the mill style number.</div>`; return }
      $('#results').innerHTML = `<div class="row" style="margin-bottom:8px"><span class="pill ${r.live ? 'green' : ''}">${esc(r.source)}${r.live ? ' · live' : ''}</span>${r.errors ? `<span class="dim" style="font-size:11px;margin-left:8px">${esc(r.errors.join('; '))}</span>` : ''}</div>
        <div class="tbl-wrap"><table class="tbl"><thead><tr><th>SKU/Style</th><th>Name</th><th>${r.live ? 'Color · Size' : 'Type'}</th><th class="num">Cost</th>${r.live ? '<th class="num">Stock</th>' : ''}</tr></thead>
        <tbody>${rows.map((p) => `<tr>
          <td><span class="tag">${esc(p.sku || p.style || '')}</span></td>
          <td>${esc(p.name || p.styleName || '')}${p.brand ? ` <span class="dim">${esc(p.brand)}</span>` : ''}</td>
          <td class="dim" style="font-size:12px">${r.live ? `${esc(p.color || '')} ${esc(p.size || '')}` : esc(p.type || '')}</td>
          <td class="num" style="font-weight:600">${p.cost != null ? money(p.cost) : '—'}</td>
          ${r.live ? `<td class="num ${(+p.stock || 0) > 0 ? '' : 'dim'}">${p.stock != null ? p.stock : '—'}</td>` : ''}
        </tr>`).join('')}</tbody></table></div>`
    } catch (e) { $('#results').innerHTML = `<div class="dim" style="font-size:12.5px;color:var(--red)">Lookup failed: ${esc(e.message)}</div>` }
  }
  $('#go').onclick = runLookup
  $('#lookup').addEventListener('keydown', (e) => { if (e.key === 'Enter') runLookup() })
}
