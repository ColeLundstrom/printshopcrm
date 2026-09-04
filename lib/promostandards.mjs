import { psSoap, parsePpcParts, parseInventoryLevels } from './suppliers.mjs'
import { parsePromoXml } from './promo-xml.mjs'
const esc = (v) =>
  String(v ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
const list = (v) => (v == null ? [] : Array.isArray(v) ? v : [v])
const str = (v) => (typeof v === 'string' ? v.trim() : '')
export const PROMO_SERVICES = {
  ss: {
    label: 'S&S Activewear',
    status: 'https://promostandards.ssactivewear.com/orderstatus/v2/orderstatusservice.svc',
    shipment:
      'https://promostandards.ssactivewear.com/ordershipmentnotification/v1/ordershipmentnotificationservice.svc',
    pricing:
      'https://promostandards.ssactivewear.com/pricingandconfiguration/v1/pricingandconfigurationservice.svc'
  },
  sanmar: {
    label: 'SanMar',
    status: 'https://ws.sanmar.com:8080/promostandards/OrderStatusServiceBindingV2',
    shipment: 'https://ws.sanmar.com:8080/promostandards/OrderShipmentNotificationServiceBinding',
    pricing: 'https://ws.sanmar.com:8080/promostandards/PricingAndConfigurationServiceBinding'
  }
}
function credentials(provider, s) {
  if (provider === 'ss')
    return {
      user: s.ss_account || process.env.SS_ACCOUNT || '',
      pass: s.ss_api_key || process.env.SS_API_KEY || ''
    }
  if (provider === 'sanmar')
    return {
      user: s.sanmar_user || process.env.SANMAR_USER || '',
      pass: s.sanmar_pass || process.env.SANMAR_PASS || ''
    }
  throw new Error('Choose S&S Activewear or SanMar')
}
function envelope(service, version, request, c, fields) {
  const ns = `http://www.promostandards.org/WSDL/${service}/${version}/`
  return `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ns="${ns}" xmlns:shar="${ns}SharedObjects/"><soapenv:Header/><soapenv:Body><ns:${request}><shar:wsVersion>${version}</shar:wsVersion><shar:id>${esc(c.user)}</shar:id><shar:password>${esc(c.pass)}</shar:password>${fields}</ns:${request}></soapenv:Body></soapenv:Envelope>`
}
export function orderEnvelope(kind, c, po) {
  if (kind === 'status')
    return envelope(
      'OrderStatus',
      '2.0.0',
      'GetOrderStatusRequest',
      c,
      `<shar:queryType>poSearch</shar:queryType><shar:referenceNumber>${esc(po)}</shar:referenceNumber><shar:returnIssueDetailType>allIssues</shar:returnIssueDetailType><shar:returnProductDetail>true</shar:returnProductDetail>`
    )
  return envelope(
    'OrderShipmentNotificationService',
    '1.0.0',
    'GetOrderShipmentNotificationRequest',
    c,
    `<ns:queryType>1</ns:queryType><ns:referenceNumber>${esc(po)}</ns:referenceNumber>`
  )
}
export function parseOrderStatus(xml, po) {
  const response = parsePromoXml(xml).GetOrderStatusResponse
  if (!response) throw new Error('Unexpected order-status response')
  return list(response.OrderStatusArray?.OrderStatus)
    .filter((o) => str(o.purchaseOrderNumber) === po)
    .flatMap((o) =>
      list(o.OrderStatusDetailArray?.OrderStatusDetail).map((d) => ({
        order_number: str(d.salesOrderNumber),
        status: str(d.status),
        issue: str(d.issueCategory),
        updated_at: str(d.validTimestamp),
        products: list(d.ProductArray?.Product).map((p) => ({
          product_id: str(p.productId),
          part_id: str(p.partId),
          ordered: str(p.QuantityOrdered?.value),
          shipped: str(p.QuantityShipped?.value),
          status: str(p.status)
        }))
      }))
    )
}
export function parseShipments(xml, po) {
  const response = parsePromoXml(xml).GetOrderShipmentNotificationResponse
  if (!response) throw new Error('Unexpected shipment response')
  return list(response.OrderShipmentNotificationArray?.OrderShipmentNotification)
    .filter((o) => str(o.purchaseOrderNumber) === po)
    .flatMap((o) =>
      list(o.SalesOrderArray?.SalesOrder).flatMap((s) =>
        list(s.ShipmentLocationArray?.ShipmentLocation).flatMap((l) =>
          list(l.PackageArray?.Package).map((p) => ({
            order_number: str(s.salesOrderNumber),
            package_id: str(p.id),
            tracking_number: str(p.trackingNumber),
            carrier: str(p.carrier),
            ship_date: str(p.shipmentDate),
            method: str(p.shipmentMethod)
          }))
        )
      )
    )
}
export async function promoOrderStatus(provider, po, s, { send = psSoap } = {}) {
  const c = credentials(provider, s),
    service = PROMO_SERVICES[provider]
  if (!c.user || !c.pass) throw new Error('Add this supplier’s credentials in Settings first')
  if (typeof po !== 'string' || !po.trim() || po.length > 64)
    throw new Error('Enter the supplier purchase order reference (up to 64 characters)')
  const results = await Promise.allSettled(
    ['status', 'shipment'].map((kind) =>
      send({
        endpoint: service[kind],
        action: kind === 'status' ? 'getOrderStatus' : 'getOrderShipmentNotification',
        xml: orderEnvelope(kind, c, po)
      })
    )
  )
  const out = { provider, label: service.label, po_number: po, orders: [], shipments: [], errors: [] }
  for (let i = 0; i < results.length; i++) {
    const r = results[i],
      kind = i === 0 ? 'status' : 'shipment'
    if (r.status === 'rejected') {
      out.errors.push({ service: kind, error: r.reason.message })
      continue
    }
    try {
      out[i === 0 ? 'orders' : 'shipments'] =
        i === 0 ? parseOrderStatus(r.value, po) : parseShipments(r.value, po)
    } catch (e) {
      out.errors.push({ service: kind, error: e.message })
    }
  }
  if (out.errors.length === 2) throw new Error(out.errors.map((e) => `${e.service}: ${e.error}`).join('; '))
  return out
}
export async function promoPricing(provider, productId, s, { send = psSoap } = {}) {
  const c = credentials(provider, s),
    service = PROMO_SERVICES[provider]
  if (!c.user || !c.pass) throw new Error('Add this supplier’s credentials in Settings first')
  if (typeof productId !== 'string' || !productId.trim() || productId.length > 64)
    throw new Error('Enter a supplier product ID')
  const xml = await send({
    endpoint: service.pricing,
    action: 'getConfigurationAndPricing',
    xml: envelope(
      'PricingAndConfiguration',
      '1.0.0',
      'GetConfigurationAndPricingRequest',
      c,
      `<shar:productId>${esc(productId)}</shar:productId><shar:currency>USD</shar:currency><shar:fobId>1</shar:fobId><shar:priceType>Net</shar:priceType><shar:localizationCountry>US</shar:localizationCountry><shar:localizationLanguage>en</shar:localizationLanguage><shar:configurationType>Blank</shar:configurationType>`
    )
  })
  if (!parsePromoXml(xml).GetConfigurationAndPricingResponse) throw new Error('Unexpected pricing response')
  return {
    provider,
    product_id: productId,
    currency: 'USD',
    fob: '1',
    parts: parsePpcParts(xml),
    note: 'Net blank pricing at supplier FOB 1. Confirm size, part ID, quantity break, shipping and order eligibility before purchasing.'
  }
}
