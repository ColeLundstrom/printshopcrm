# Replacing a print shop's CRM

This module is for ordinary screen printing, embroidery, DTF and mixed-decoration shops.
It does not add event staffing, contractor payroll or event logistics.

PrintShopCRM already supports customer records, quotes, appearance approvals, production,
invoices, recorded payments, a sales pipeline, conversations and configurable automations.
The additions here close two practical gaps: office/customer tasks and a reviewable GHL
customer/deal/task import. **They do not establish complete GHL parity or authorize cancellation
of an existing CRM.** Provider accounts, data reconciliation and remaining workflows still matter.

## Customer tasks

Open **Customer tasks** in the sidebar. Create a task, optionally link a customer, select an
active team member, set a date and record notes. Managers can review/assign the whole queue;
employees see and update their own tasks. Open/done/cancelled records remain available.
Completion records a timestamp; reopening clears it. Concurrent edits require a reload rather
than silently replacing a colleague's changes. Changing a task never sends customer messages.
Production tasks remain on the existing department/job workflow.

Imported tasks start unassigned for a manager to review. Historical completed tasks retain their
completed state but no invented completion timestamp. Imported staff identities are not treated
as logins, invitations or matching employee IDs.

## Prepare a GHL export

Keep the original export in private storage. Do not commit customer data to a public repository.
Use shop-owned GHL exports/API reads to assemble one JSON object:

- `locationId`: the GHL subaccount being migrated. Split different locations into separate shops.
- `contacts`: an array with source `id`, name/firstName/lastName, email, phone, companyName,
  notes (text), tags (array), and available `dnd`/`dndSettings` preferences.
- `opportunities`: source `id`, contactId (or contact.id), name, monetaryValue, status,
  pipelineId and pipelineStageId. Optional notes are plain text.
- `tasks`: source `id`, contactId, title, body, dueDate, and boolean completed.
- `stageMap`: source pipeline-stage IDs mapped explicitly to `lead`, `quoted`, `sent`,
  `negotiation`, `won` or `lost`. Won/lost/abandoned source statuses retain their terminal
  meaning; abandoned is represented as lost. Deal value is not an invoice/payment balance.
- `contactMap`: optional source-contact-ID → existing PrintShopCRM customer ID mappings,
  reviewed by a manager. The ID appears in the existing customer's detail-page URL. An email
  collision does not authorize an automatic merge. Ambiguous duplicate emails need review.

Example: [synthetic bundle](../public/examples/ghl-migration.json).
The UI also offers **Download example bundle**. Replace the example records before a real import.

Prepare numbered, private files without making network requests:

```sh
node bin/prepare-ghl-import.mjs export.json new-private-bundles America/Los_Angeles
```

The output directory must not exist. Files are created mode 600, the directory mode 700.
It creates contact-first batches of at most 250 records and 700 KB; import in filename order.
A task timestamp needs an explicit IANA timezone to avoid silently changing its local due day.
No auth/session data is copied. The converter preserves only the supported fields; keep the
original export for everything else. It does not fetch missing pages from GHL. Whoever produces
the export must finish pagination and reconcile source counts before preparing it.

The field vocabulary follows HighLevel's [opportunity search documentation](https://marketplace.gohighlevel.com/docs/ghl/opportunities/search-opportunity/)
and [contact DND documentation](https://marketplace.gohighlevel.com/docs/webhook/ContactDndUpdate/index.html).
This is an offline adapter, not an OAuth connection or a promise of automatic migration from every
GHL export format/API version.

## Preview, commit, reconcile

1. In **Setup & connections → Move your CRM**, choose a prepared bundle.
2. Preview counts, collisions and communication holds. Resolve identity/stage errors in the
   source mapping, then preview again. A batch accepts at most 250 records; browser upload is
   capped at 750 KB and the existing server JSON body ceiling still applies.
3. Import the reviewed records. The server checks the preview again under a write lock.
4. Reconcile counts in Customers, Pipeline and Customer tasks. Confirm dates, values and identities.
5. Assign imported tasks and review communication permissions before enabling new senders.

Each batch is one transaction. A failed write rolls back its contacts, deals, tasks, holds,
source references and receipt together. A retry of the same committed request returns its
receipt. Source location + entity type + source ID prevents duplicate imports across batches.
Changed source records stop for manual reconciliation; imports do not overwrite local work.
Source IDs are retained in the JSON export's `crm_import_refs` table. Current contact detail
changes do not get replaced by an unchanged source replay.

New contacts do not emit contact-created automations, deal-stage events or messages.
No invoices, payment rows, job records or customer/staff accounts are created by this importer.
Linking an existing customer preserves its details but deliberately adds communication holds,
which the preview calls out. Do not link a customer without reviewing that effect.

## Communication holds

Every imported/linked contact starts with email and SMS held, even if the source omits DND.
Known GHL do-not-contact preferences are identified in the reason. Hold checks cover ordinary
customer send queues, automatic follow-ups and explicit sends of already-saved outbox drafts.
They do not recall a message already handed to a provider, control external agents that send
directly through their own provider, or stop the old GHL workflows.

**Communication holds** lets a manager release one channel after recording the permission or
correction supporting the release. Releases require the current revision, and a newly added
hold cannot be released with an older review. History remains in `crm_history`; releasing does
not send a message. Review existing scheduled automations before releasing a hold because a
subsequent ordinary automation tick may become eligible to send.

Existing shops have no holds by default. Existing customers are unaffected unless deliberately
linked/imported or held through the manager API. Existing auth, sessions, payment links and
production controls retain their current behavior.

## Remaining replacement work

| Workflow | Current state / cutover requirement |
|---|---|
| Quotes, approvals, production, invoices | Existing native functionality; walk an actual shop order through it and verify pricing/roles |
| Customers, pipeline, office tasks | New silent migration supported for documented fields; reconcile source pagination/counts |
| Customer email | SMTP/relay sending exists; full OAuth mailbox synchronization into Conversations is still missing |
| Customer SMS | Own Twilio account and verified inbound callback supported; test both directions and transfer phone service separately |
| Platform transactional email | Explicit `PSC_PLATFORM_EMAIL_TRANSPORT=independent` lets the nurture helper use SMTP/Postmark/Resend without GHL. Default legacy behavior is preserved; review pending campaigns and test the selected provider before switching |
| Platform marketing capture | Existing landing-page capture still uses GHL; move this separately if that platform path is used |
| Active quotes/invoices/deposits/payment history | No automatic GHL migration here. Reconcile ledger/balances and old links; do not use settled-history CSV imports for active/part-paid work |
| Conversations, attachments, postal/custom fields | Not imported by this adapter; preserve the original archive and migrate needed history/files separately |
| Workflows, campaigns and scheduled sends | Not transferred. Rebuild needed rules and move one writer at a time to avoid duplicate messages |
| Voice, missed-call flows and appointment booking | No full native replacement established by this change; needs implementation or an independently configured service |
| Suppliers, accounting and online payments | Existing adapters need shop-owned provider acceptance; software alone does not replace those provider services |

## Upgrade and rollback boundary

This change adds separate per-shop tables; it does not rebuild contact/document tables or
change authentication. Existing JSON exports discover the new tables automatically. Retain
an application/database/upload backup and rehearse against copies before any live upgrade.
Run full tests, end-to-end tests and exact-commit CI; verify existing owner and staff sessions.
An additive schema is not proof of a production-safe migration on its own.

**After importing contacts with holds, an old runtime is not a safe blind rollback:** it does
not understand these holds and could send to those contacts. Before reverting code, stop
customer outbound delivery/automation and reconcile post-upgrade writes. Do not restore an old
database over new customer work. Prefer a forward fix. Keep the current production version
running until release acceptance and explicit deployment authorization are complete.
