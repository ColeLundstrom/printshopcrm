import { api, $, esc, money, fmtDate, setPage, on, modal, closeModal, confirmModal, toast, go } from '../core.js'

/**
 * Platform Control Room — the admin's cockpit over every shop on this deployment. Only reachable by
 * the deployment's admin (PSC_ADMIN_EMAIL); the API gates every call the same way. Lets the admin
 * spin up a client's shop, sign in to set it up for them, suspend/reactivate, and remove accounts.
 */
export async function adminView() {
  setPage('Control Room', '<button class="btn" id="ad-new">+ New client shop</button>')
  let data
  try { data = await api.get('/api/admin/shops') } catch (e) {
    $('#view').innerHTML = `<div class="empty">${esc(e.message || 'Admins only')}</div>`; return
  }
  const shops = data.shops || []
  const active = shops.filter((s) => s.status !== 'suspended').length
  const suspended = shops.length - active
  const revenue = shops.reduce((a, s) => a + (Number(s.revenue) || 0), 0)

  $('#view').innerHTML = `
    <div class="kpis" style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:16px">
      ${kpi(shops.length, 'Client shops')}
      ${kpi(active, 'Active')}
      ${kpi(suspended, 'Suspended')}
      ${kpi(money(revenue), 'Collected across all shops')}
    </div>
    <div class="card"><div class="card-b" style="padding:0">
      <table class="tbl" style="width:100%;border-collapse:collapse">
        <thead><tr style="text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:var(--dim)">
          <th style="padding:12px 14px">Shop</th><th>Owner</th><th>Status</th><th>Invoices</th><th>Customers</th><th>Collected</th><th>Last login</th><th></th>
        </tr></thead>
        <tbody id="ad-rows">
          ${shops.length ? shops.map(row).join('') : '<tr><td colspan="8" style="padding:26px;text-align:center;color:var(--dim)">No client shops yet — add your first one.</td></tr>'}
        </tbody>
      </table>
    </div></div>`

  $('#ad-new').onclick = () => newShopModal()

  on($('#ad-rows'), '[data-act]', async (e, t) => {
    const id = +t.dataset.id; const act = t.dataset.act; const name = t.dataset.name || 'this shop'
    if (act === 'signin') {
      if (!confirm(`Sign in as ${name}? Your admin session will switch to their shop — sign back in to your own account afterward.`)) return
      try { await api.post(`/api/admin/shops/${id}/signin`, {}); location.href = '/' } catch (ex) { toast(ex.message, true) }
    } else if (act === 'suspend' || act === 'activate') {
      try { await api.post(`/api/admin/shops/${id}/status`, { status: act === 'suspend' ? 'suspended' : 'active' }); adminView() }
      catch (ex) { toast(ex.message, true) }
    } else if (act === 'delete') {
      confirmModal(
        `Delete ${name}?`,
        `This permanently removes the shop and all its invoices, customers, and history. This can't be undone.`,
        async () => { try { await api.del(`/api/admin/shops/${id}`); toast('Shop deleted'); adminView() } catch (ex) { toast(ex.message, true) } },
        'Delete forever')
    }
  })
}

const kpi = (v, label) => `<div class="card"><div class="card-b"><div style="font-size:24px;font-weight:700">${esc(String(v))}</div><div class="dim" style="font-size:12px">${esc(label)}</div></div></div>`

function row(s) {
  const suspended = s.status === 'suspended'
  const statusPill = suspended
    ? '<span class="pill" style="background:rgba(239,68,68,.15);color:#ef4444">Suspended</span>'
    : '<span class="pill" style="background:rgba(37,99,235,.15);color:var(--accent)">Active</span>'
  return `<tr style="border-top:1px solid var(--line)">
    <td style="padding:12px 14px"><strong>${esc(s.shop_name || '—')}</strong><div class="dim" style="font-size:11px">${esc(s.slug)}</div></td>
    <td><div>${esc(s.owner_name || '—')}</div><div class="dim" style="font-size:11px">${esc(s.owner_email || '')}</div></td>
    <td>${statusPill}</td>
    <td>${s.invoices}</td>
    <td>${s.customers}</td>
    <td>${money(s.revenue)}</td>
    <td class="dim" style="font-size:12px">${s.last_login ? esc(fmtDate(s.last_login)) : 'never'}</td>
    <td style="text-align:right;white-space:nowrap;padding-right:12px">
      <button class="btn ghost sm" data-act="signin" data-id="${s.id}" data-name="${esc(s.shop_name)}">Sign in</button>
      <button class="btn ghost sm" data-act="${suspended ? 'activate' : 'suspend'}" data-id="${s.id}" data-name="${esc(s.shop_name)}">${suspended ? 'Reactivate' : 'Suspend'}</button>
      <button class="btn ghost sm" data-act="delete" data-id="${s.id}" data-name="${esc(s.shop_name)}" style="color:#ef4444">Delete</button>
    </td>
  </tr>`
}

function newShopModal() {
  modal({
    title: 'New client shop',
    body: `<div class="dim" style="font-size:13px;margin-bottom:14px">Spin up a shop for a client. You'll get a one-time password to hand them — or sign in as the shop yourself to set it up.</div>
      <div class="field"><label>Shop name *</label><input class="input" id="ns-shop" placeholder="Milo's Prints"></div>
      <div class="grid2" style="margin-top:10px">
        <div class="field"><label>Owner name</label><input class="input" id="ns-name" placeholder="Milo"></div>
        <div class="field"><label>Owner email *</label><input class="input" id="ns-email" type="email" placeholder="milo@example.com"></div>
      </div>
      <div class="field" style="margin-top:10px"><label>Temp password (optional — auto-generated if blank)</label><input class="input" id="ns-pw" placeholder="leave blank to auto-generate"></div>
      <div class="dim" id="ns-err" style="color:#ef4444;font-size:12px;display:none;margin-top:8px"></div>`,
    footer: `<button class="btn ghost" data-close>Cancel</button><button class="btn" id="ns-go">Create shop</button>`,
    onMount: (bg) => {
      const err = (m) => { const e = $('#ns-err', bg); e.textContent = m; e.style.display = '' }
      $('#ns-go', bg).onclick = async () => {
        const shop_name = $('#ns-shop', bg).value.trim(), owner_email = $('#ns-email', bg).value.trim()
        if (!shop_name || !owner_email) return err('Shop name and owner email are required.')
        try {
          const r = await api.post('/api/admin/shops', { shop_name, owner_name: $('#ns-name', bg).value.trim(), owner_email, password: $('#ns-pw', bg).value.trim() })
          closeModal()
          modal({
            title: 'Shop created ✓',
            body: `<div style="line-height:1.7"><strong>${esc(r.shop.shop_name)}</strong> is ready. Hand these to your client:<div class="card" style="margin-top:12px"><div class="card-b" style="font-size:13px">
              <div>Sign-in: <strong>${location.origin}/login</strong></div>
              <div>Email: <strong>${esc(r.shop.owner_email)}</strong></div>
              <div>Temp password: <strong>${esc(r.password)}</strong></div>
            </div></div><div class="dim" style="font-size:12px;margin-top:8px">Save the password now — it isn't shown again.</div></div>`,
            footer: `<button class="btn" data-close>Done</button>`,
            onMount: () => {}, wide: false,
          })
          adminView()
        } catch (e) { err(e.message || 'Could not create the shop.') }
      }
    },
  })
}
