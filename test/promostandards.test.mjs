import test from 'node:test'
import assert from 'node:assert/strict'
import { parsePromoXml } from '../lib/promo-xml.mjs'
import { parseOrderStatus, parseShipments, promoOrderStatus, orderEnvelope } from '../lib/promostandards.mjs'
const wrap = (s) =>
  `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>${s}</s:Body></s:Envelope>`
const status = wrap(
  '<GetOrderStatusResponse><OrderStatusArray><OrderStatus><purchaseOrderNumber>PO-1</purchaseOrderNumber><OrderStatusDetailArray><OrderStatusDetail><salesOrderNumber>00123</salesOrderNumber><status>partiallyShipped</status><ProductArray><Product><partId>0007</partId><QuantityOrdered><value>10</value></QuantityOrdered><QuantityShipped><value>5</value></QuantityShipped></Product></ProductArray></OrderStatusDetail></OrderStatusDetailArray></OrderStatus></OrderStatusArray><ServiceMessage><code>0</code></ServiceMessage></GetOrderStatusResponse>'
)
const shipment = wrap(
  '<GetOrderShipmentNotificationResponse><OrderShipmentNotificationArray><OrderShipmentNotification><purchaseOrderNumber>PO-1</purchaseOrderNumber><SalesOrderArray><SalesOrder><salesOrderNumber>00123</salesOrderNumber><ShipmentLocationArray><ShipmentLocation><PackageArray><Package><id>1</id><trackingNumber>000000123</trackingNumber><carrier>UPS</carrier></Package><Package><id>2</id><trackingNumber>000000124</trackingNumber><carrier>UPS</carrier></Package></PackageArray></ShipmentLocation></ShipmentLocationArray></SalesOrder></SalesOrderArray></OrderShipmentNotification></OrderShipmentNotificationArray></GetOrderShipmentNotificationResponse>'
)
test('PromoStandards validates SOAP, preserves identifiers, filters the exact PO and retains partial service failures', async () => {
  assert.equal(parseOrderStatus(status, 'PO-1')[0].order_number, '00123')
  assert.equal(parseOrderStatus(status, 'PO-1')[0].products[0].part_id, '0007')
  assert.deepEqual(parseOrderStatus(status, 'PO-2'), [])
  assert.equal(parseShipments(shipment, 'PO-1').length, 2)
  assert.equal(parseShipments(shipment, 'PO-1')[0].tracking_number, '000000123')
  assert.throws(() => parsePromoXml('<html>Access denied</html>'), /SOAP/)
  assert.throws(() => parsePromoXml('<!DOCTYPE x [<!ENTITY x "secret">]>' + status), /Invalid/)
  assert.throws(
    () => parsePromoXml(wrap('<Fault><faultstring>private secret</faultstring></Fault>')),
    (e) => !e.message.includes('private secret')
  )
  assert.throws(
    () =>
      parsePromoXml(
        wrap(
          '<Response><ServiceMessage><code>100</code><description>secret</description></ServiceMessage></Response>'
        )
      ),
    /error 100/
  )
  assert.throws(() => parseOrderStatus(wrap('<Other/>'), 'PO-1'), /Unexpected/)
  const calls = []
  const r = await promoOrderStatus(
    'sanmar',
    'PO-1',
    { sanmar_user: 'user', sanmar_pass: 'pass' },
    {
      send: async (b) => {
        calls.push(b)
        return b.action === 'getOrderStatus' ? status : shipment
      }
    }
  )
  assert.equal(r.orders.length, 1)
  assert.equal(r.shipments.length, 2)
  assert.equal(r.errors.length, 0)
  assert(calls.every((c) => new URL(c.endpoint).hostname === 'ws.sanmar.com'))
  const partial = await promoOrderStatus(
    'ss',
    'PO-1',
    { ss_account: '1', ss_api_key: 'key' },
    {
      send: async (b) => {
        if (b.action === 'getOrderStatus') return status
        throw new Error('Timeout')
      }
    }
  )
  assert.equal(partial.orders.length, 1)
  assert.equal(partial.errors.length, 1)
  assert.match(orderEnvelope('status', { user: 'x&y', pass: '<private>' }, 'PO<&'), /PO&lt;&amp;/)
  assert(!orderEnvelope('status', { user: 'x&y', pass: '<private>' }, 'PO<&').includes('<private>'))
})
