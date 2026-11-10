import { api, $, $$, esc, money, setPage, empty, toast, on, modal, closeModal, confirmModal, formData } from '../core.js'

/* Products / blank catalog — the blanks this shop buys, what each costs, and live distributor
 * lookups. The catalog used to be read-only: its only writer was the built-in seed, so a blank
 * outside it was costed from the nearest similar garment with nothing to say so. A manager can now
 * add the blanks the shop actually buys and correct any cost; each row says whether its number is
 * the shop's own price or a built-in estimate. */

export async function productsView() {
  setPage('Products')
  const data = await api.get('/api/products')
  const sup = data.suppliers || {}
  const canManage = window.__me?.can_manage !== false
  const TYPES = ['tee', 'hoodie', 'crew', 'polo', 'hat', 'tank', 'jacket', 'bag', 'apron', 'other']
  const mine = data.garments.filter((g) => g.supplier === 'shop').length
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
      <div class="card-h"><h3>Blank catalog</h3><div class="spacer"></div><span class="pill">${data.count} styles${mine ? ` · ${mine} yours` : ''}</span>${canManage ? '<button class="btn sm secondary" id="g-add" type="button">Add a blank</button>' : ''}</div>
      <div class="card-b">
        <p class="dim" style="font-size:12.5px;line-height:1.6;margin-bottom:12px">These costs feed every job's profit figure. <strong>Your price</strong> is a cost you entered. <strong>Catalog estimate</strong> is a built-in ballpark — correct it to what you pay, or connect a supplier for live pricing. A blank that is not listed here is costed from the nearest similar garment and marked approximate on the job.</p>
        ${brands.map((b) => `<div class="brandblock">
          <div class="brandname">${esc(b)}</div>
          <div class="tbl-wrap"><table class="tbl fit"><tbody>
            ${data.byBrand[b].map((g) => `<tr>
              <td style="width:74px"><span class="tag">${esc(g.style)}</span></td>
              <td>${esc(g.name)} <span class="dim" style="font-size:12px">${esc(g.type || '')}</span></td>
              <td><span class="pill ${g.supplier === 'shop' ? 'green' : ''}">${g.supplier === 'shop' ? 'Your price' : 'Catalog estimate'}</span></td>
              <td class="num" style="font-weight:600">${money(g.cost)}</td>
              ${canManage ? `<td class="num" style="width:64px"><button class="btn sm ghost" type="button" data-edit="${g.id}" aria-label="Edit ${esc(g.brand)} ${esc(g.style)}">Edit</button></td>` : ''}
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
  const byId = new Map(data.garments.map((g) => [g.id, g]))
  const blankForm = (g) => modal({
    title: g ? `Edit ${g.brand} ${g.style}` : 'Add a blank',
    body: `<div class="grid2">
        <div class="field"><label for="gf-brand">Brand</label><input class="input" id="gf-brand" name="brand" maxlength="60" value="${esc(g?.brand || '')}" placeholder="Carhartt"></div>
        <div class="field"><label for="gf-style">Style number</label><input class="input" id="gf-style" name="style" maxlength="40" value="${esc(g?.style || '')}" placeholder="K87"></div>
      </div>
      <div class="field"><label for="gf-name">Name</label><input class="input" id="gf-name" name="name" maxlength="120" value="${esc(g?.name || '')}" placeholder="Workwear pocket tee"></div>
      <div class="grid2">
        <div class="field"><label for="gf-cost">What you pay per piece</label><input class="input" id="gf-cost" name="cost" type="number" min="0" step="0.01" inputmode="decimal" value="${g ? esc(g.cost) : ''}" placeholder="0.00"></div>
        <div class="field"><label for="gf-type">Type</label><select class="input" id="gf-type" name="type">${TYPES.map((t) => `<option value="${t}" ${(g?.type || 'tee') === t ? 'selected' : ''}>${t[0].toUpperCase()}${t.slice(1)}</option>`).join('')}</select></div>
      </div>
      <p class="dim" style="font-size:12.5px;line-height:1.5">A quote line that names this style number is costed at this price.</p>
      <p class="dim" id="gf-err" role="alert" style="color:var(--red);font-size:12.5px;min-height:1em"></p>`,
    footer: `${g && data.removable?.[g.id] ? '<button class="btn danger ghost" id="gf-del" type="button">Take out of catalog</button><div class="spacer"></div>' : ''}<button class="btn ghost" data-close type="button">Cancel</button><button class="btn" id="gf-save" type="button">${g ? 'Save' : 'Add blank'}</button>`,
    onMount: (bg) => {
      const save = $('#gf-save', bg)
      save.onclick = async () => {
        if (save.disabled) return
        const f = formData(bg)
        if (f.cost == null) { $('#gf-err', bg).textContent = 'Enter what you pay per piece.'; return }
        save.disabled = true
        try {
          if (g) await api.put(`/api/garments/${g.id}`, f); else await api.post('/api/garments', f)
          closeModal(); toast(g ? 'Saved. This is now your price.' : 'Blank added to your catalog.'); productsView()
        } catch (e) { $('#gf-err', bg).textContent = e.message; save.disabled = false }
      }
      const del = $('#gf-del', bg)
      if (del) del.onclick = () => confirmModal(`Take ${g.brand} ${g.style} out of your catalog?`, 'Quotes that name this style will be costed from the nearest similar blank and marked approximate.', async () => {
        try { await api.req('DELETE', `/api/garments/${g.id}`); toast('Taken out of your catalog'); productsView() } catch (e) { toast(e.message, true) }
      }, 'Take it out')
    },
  })
  if ($('#g-add')) $('#g-add').onclick = () => blankForm(null)
  for (const b of $$('[data-edit]')) b.onclick = () => blankForm(byId.get(+b.dataset.edit))

  $('#go').onclick = runLookup
  $('#lookup').addEventListener('keydown', (e) => { if (e.key === 'Enter') runLookup() })
}
