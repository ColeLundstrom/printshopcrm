# Try your first print job in PrintShopCRM

Follow one fictional order from a quote to a proof, production record and paid invoice.
Use it to decide whether the workflow fits your shop before importing customer records.
The complete application is free to self-host under
[AGPL-3.0-or-later](../LICENSE); [paid hosting](../HOSTING.md) is optional.

**Start here: [install an isolated sample shop](../INSTALL.md#try-it-locally).**
Already running the evaluation? Keep this checklist beside it. For a specific version,
review the [published releases](https://github.com/ColeLundstrom/printshopcrm/releases)
and the documentation bundled with that version.

## What you will check

- One customer, one estimate, one linked production job and one invoice
- 48 shirts: 24 medium and 24 large
- Fictional rate of $12 per shirt, plus one $24 setup fee, with 0% tax
- Expected invoice total: $600. A $200 sample payment leaves $400; another $400 leaves $0
- Current artwork approval, saved records after restart and a fresh draft for a repeat order

These are synthetic USD evaluation amounts, not suggested selling prices or tax advice.
Use your shop's own pricing and tax treatment when configuring a real installation.

## 1. Keep the evaluation separate

Use the generated `start.mjs` from the [isolated demo](DEMO.md). The banner identifies sample
data and disabled external services. Use only fictional names, `example.test` email addresses
and artwork you created for testing. Keep the generated login files private.

The demo blocks outbound application connections, including email, SMS, payment processors,
supplier services, cloud AI and accounting integrations. You will open customer links yourself
on the same computer and record fictional payments. A send label or success notification in
this demo is not evidence of email delivery. Do not connect real accounts or enter credentials.

## 2. Create a quote you can reconcile

1. Open **Estimates → + New Estimate**. Select one of the fictional customers, or use
   **Add a new customer** for a clearly labeled evaluation customer.
2. Describe the line as `Evaluation shirts`, select **Screen Print**, and enter **24 M / 24 L**
   in the size grid. Set the rate to **12.00** and every other size to zero.
3. Add a **Fee / setup line** called `Evaluation setup`, quantity **1**, rate **24.00**.
4. Set **Tax rate (%)** to **0** for this example. Confirm **48 pieces**, **$600 subtotal**,
   **$0 tax** and **$600 total**, then choose **Create Estimate**.

If the total differs, inspect line quantities, rates, size upcharges and any extra fees before
proceeding. The check is useful because you know the expected result. After this first pass,
repeat it with **From a price matrix** and a copy of your own rates. Review
[price matrices](../README.md#price-matrices) and
[per-location pricing](LOCATION-PRICING.md) for mixed decoration methods.

## 3. Review the customer's quote

Choose **Open customer view** in the estimate's **Customer Link** section on the same computer.
Check the customer, size breakdown,
total and saved terms, then approve the fictional quote. Return to the staff screen and refresh
if needed. The estimate should show its approval and make **Convert to Invoice + Job** available.
No email is necessary for this local check.

For real orders, commercial changes such as price, quantities, notes or terms require a fresh
approval. Earlier acceptance remains in the history. A staff **Mark Approved** action records
staff acceptance; do not use it as evidence that a customer clicked their link.

## 4. Create the invoice and production record

Choose **Convert to Invoice + Job**. Review **Payment terms** and **Production due** separately.
The current options include Due on receipt, Net 15, Net 30 and Net 45, with an optional invoice
date override. Terms count calendar days from invoice creation using the server's UTC date;
they do not set the production promise.

Choose **Create Invoice + Job**, then check that the job links to the original estimate and its
invoice. Compare the 48-piece size breakdown and $600 invoice against the quote. Reopening the
quote should show **View Invoice**, without offering a second conversion for that invoice.

## 5. Check a proof before production

In the job's **Art & Proofs**, upload a small sample PNG, JPG, WebP, SVG or PDF that you own.
Choose **Send for approval**, then open **Proof link** yourself. This evaluation still sends no
external email. Check the displayed version and approve it as the fictional customer.

Return to the job and inspect its **Work ticket** and production board entry. Confirm the
current approved proof and quantities. If you upload a replacement, approval must clear until
that new version is reviewed. Earlier proof versions remain history.

Customer approval covers appearance. Prepared production files and a staff technical release
are a separate workflow; a mockup does not certify print dimensions, separations or embroidery
files. Read [artwork and production release](ARTWORK.md) before relying on the production controls.
Do not disable a technical hold just to make an evaluation job advance.

## 6. Reconcile two fictional payments

Open the linked invoice and choose **Record Payment**. Enter **200.00**, select **other**,
and add the note `Fictional evaluation deposit`. Confirm a partial payment and a **$400 balance**.
Record **400.00** with the note `Fictional evaluation balance`. Confirm **$600 paid**, **$0 balance**
and the **paid** status. Both payment records should remain visible.

Manual payment entry records bookkeeping; it does not collect money. Online checkout, refunds
and provider callbacks need separate acceptance with your own provider's sandbox and intended
HTTPS installation. See [payment setup and limits](PAYMENTS.md).

## 7. Reopen the work and try a repeat order

Stop the evaluation with Ctrl+C in its terminal and restart the same generated `start.mjs`.
Do not run seed or reset. Sign in again and check the customer, quote, invoice, both payments,
size breakdown and proof file. An ordinary restart check does not replace testing backup restore.

Open the original estimate and choose **Duplicate**. In **Customer for the new quote**, keep the
fictional customer or select another existing one, then choose **Create draft & edit**. Review the
new draft's customer, copied lines, previous prices and customer-specific notes before saving. A repeat order needs its own acceptance, invoice,
payments and production work; prior approval or completion must not carry over.

## Before using it for real work

- [ ] The example reconciles across quote, job and invoice, including after restart.
- [ ] Your own pricing, sizes, decoration methods, payment terms and due dates have been tested.
- [ ] Your team has checked its phone/tablet workflow, PDFs and actual artwork formats.
- [ ] Authentication, HTTPS, persistent databases/artwork and updates follow the
  [production install guide](../INSTALL.md#production-install).
- [ ] A complete [backup](../INSTALL.md#backups) has been restored into a separate installation
  using the [restore procedure](../INSTALL.md#putting-a-backup-back), including artwork.
- [ ] Any imported data has been reconciled using the [migration checklist](MIGRATION.md).
- [ ] Required email, supplier, payment and accounting connections have their own acceptance.

Review the [documented workflow limits](CORE-READINESS.md) before choosing a migration date.
Capacity estimates, supplier ordering, carrier services, accounting and artwork preparation
have different boundaries. A local walkthrough does not verify a production deployment or
every external integration.

**Ready for your own installation? [Read the production guide](../INSTALL.md#production-install).**
You provide the computer or server and maintain updates and tested backups. Domains, email and
other external services can have their own costs. If you prefer operating help,
[optional paid hosting](../HOSTING.md) uses the same application.
