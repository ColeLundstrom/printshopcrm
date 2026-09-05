# Reusable production workflows

Build a workflow once in **Setup → Workflow templates**. Screen printing, embroidery and DTF starters are included. Rename, reorder, add or remove steps; choose each step’s department, board stage and employee. A step can require received PO quantities, customer artwork approval or a staff technical production release. Use custom departments and project types for finishing, laser, promotional products or your own process.

In **Department queue → Automatic tasks for new jobs**, enable automatic application after reviewing your templates. A new active job in the New stage matches the longest decoration text from an unarchived template. Only one template auto-matches; create a combined template for a regularly repeated combination. Existing jobs and imported jobs already in later stages are not automatically enrolled.

On a job, **Production tasks → Choose workflow** also accepts several templates for one-off combinations. Shared identical tasks are combined, with receiving/art/prepress/production/QC/shipping ordered by board stage. Review the result. The job owns its task copy: later template edits do not change existing orders. Managers can edit pending tasks, reassign employees, add tasks, skip with a reason and reopen in reverse completion order. Other employees complete unassigned tasks or tasks assigned to them. A stale update returns 409 and must be refreshed.

Departments can save their start page and turn on Focus mode on a tablet. Focus mode reduces visual distractions; it does not replace the underlying staff account permissions. Employee accounts still use the existing owner/manager/staff roles.

## Appearance approval and technical preflight

**Artwork approval** checks the customer's appearance decision. **Technical production release** (the API task gate `preflight`) checks a separate staff review of the files to be printed, cut or stitched. Choose that requirement for a prepress review step in a reusable template. Adding the requirement does not render artwork or complete a task automatically; a manager records the technical release on the full job's **Production files & review** panel, then the assigned employee completes the workflow step.

Upload customer originals under **Original artwork** and machine handoff files under **Prepared production files**. Staff downloads stay separate from public customer proof links. A release requires the current approved proof, selected prepared files, reviewed print dimensions/method and explicit human confirmation. The software checks selected file integrity on upload and release; it does not validate machine output, separations or digitizing and does not continuously monitor external changes to files on disk.

The migration adds records without enrolling old jobs, rewriting customized templates or marking existing proofs technically ready. Ordinary jobs retain an optional technical requirement until a manager enables it or records a release. Once a release is recorded, the job requires a current release for subsequent production, QC, shipping and completion transitions. The hold applies even without workflow tasks and cannot be bypassed by skipping a task into one of those stages, moving a board card, scanning, using the stage API or running a stage automation. A step explicitly requiring `preflight` also checks technical readiness when completed, even if the job-level requirement was initially optional.

Proof replacement/decisions, source/prepared-file uploads and changes to garment, decoration or quantity/size data invalidate the technical release. The associated revisions prevent a tablet from completing work against stale records. Scheduling, title or rush changes alone do not invalidate that review. Managers can revoke a release with a reason or change the optional job requirement under **Advanced production controls**. An `appearance_mockup` always requires separate technical review; disabling its requirement is refused. A native mockup composer is not implemented yet.

The work ticket shows only the current approved appearance proof and a separate technical review status. **Production manifest** is a JSON manifest of reviewed prepared files, not a generated RIP file. Its `ready` and `technical_ready` values require a current technical release; the compatibility field `approved_art` remains appearance-only. See [artwork and production release](ARTWORK.md) for file limits, private storage/download behavior, invalidation details and the full API contract. Every step works manually without AI.

## Receiving and handoffs

Enter total received so far, by PO line or by size for customer-supplied/manual garments. Submitted totals are bounded by ordered/expected counts, and staff cannot reduce earlier counts; managers can correct them. Retries cannot add the same shipment twice. Shortages block the receiving task until resolved. Partial or short-closed POs retain their existing purchasing behavior.

Optional QR labels open the authenticated production job. Labels carry the shop identifier and do not grant access or complete work by scanning. Staff must explicitly complete the next task. Use the phone’s native QR camera, the in-app scanner where supported, or enter the job number. Physical phones require a reachable HTTPS installation; a laptop-only 127.0.0.1 preview cannot be reached from another device.

Outgoing shipping supports manually recorded carrier/tracking or pickup references. These are records, not a carrier label purchase or delivery-status subscription. Supplier shipment checks are separate from receiving and never mark garments received automatically.

## Machine and employee costing

In **Shop costs & machines**, enter shop hours, productive capacity, shared overhead and loaded employee hourly costs. Define each machine/workstation’s method, hourly operating cost, output per hour, setup minutes and weekly schedule. Avoid counting employee costs or overhead again in the machine rate.

A job’s margin calculator stores machine/employee operations. Plans derive time from output plus setup; actual minutes and good units are entered together. Saved operations keep their rate snapshot when shop settings change. Corrections require a note; voiding a duplicate operation retains its original audit record. Customer-supplied blank costs can be zeroed, and material/freight/other job costs can be entered. Contract matrix metadata also carries zero blank cost onto quoted items.

The model separates planned versus recorded operation time. Materials and decoration may still be estimates. Legacy decoration estimates can include outside labor: override them with actual supplies-only cost when recording in-house operations, to avoid counting labor twice. Adding one operation replaces the legacy labor estimate, so enter all job operations before treating the job model as complete. Comparisons include only jobs with saved cost records. Machine, employee and method profit figures allocate whole-job profit by operation time; they are not causal employee-performance claims. Recorded output uses good units per recorded hour. Shared overhead is allocated over productive machine hours.

## Supplier services

**Setup → Connect suppliers** saves S&S account/API key or SanMar Web Services username/password. A saved key is not a successful access test. Check a supplier product ID to verify pricing access. PromoStandards prices are net USD blanks, not the shop’s retail decoration matrix. Select the correct part/size and quantity break before ordering.

On a job’s PO, **Refresh supplier status** requests Order Status 2.0 and Order Shipment Notification 1.0 for that exact PO number. The check retains partial service failures, distinct packages and supplier identifiers. It never changes PO receiving totals or spends money. Existing S&S REST ordering remains available. SanMar electronic PO submission remains a manual portal handoff pending a separately tested implementation and supplier account approval.

Protocol references verified 2026-09-04:

- [S&S published services and WSDLs](https://promostandards.ssactivewear.com/)
- [SanMar integration hub](https://www.sanmar.com/resources/electronicintegration/integrationofferings)
- [SanMar Web Services 24.6](https://d3vudmj4emi09t.cloudfront.net/medias/sys_master/pdf/h7a/ha0/33815499964446/SanMar-Web-Services-Integration-Guide-24.6/SanMar-Web-Services-Integration-Guide-24.6.pdf)

Read paths have protocol fixture coverage; production supplier credentials and physical scanners have not been verified in this local demo. No AI is required for any of these workflows.

## Larger queues and reports

Department queues show ready work before waiting work and page large task lists. Cost comparisons page the job list while keeping totals across every saved job cost record. [Scale verification](SCALE-VERIFICATION.md) records the synthetic fixtures, query bounds, pagination contract and remaining capacity work.
