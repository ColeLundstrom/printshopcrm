# Artwork, customer proofs and production release

PrintShopCRM records proofs and customer decisions without requiring AI. Upload the actual proof you want reviewed from the job’s **Art & Proofs** section. Each upload becomes a new version. Only the newest version can be sent for approval or decided; older versions remain visible as history on the job.

A replacement clears the job’s artwork approval. A superseded customer link shows the old proof for reference and cannot approve or reject it. Sending an already-approved proof for another decision is refused; upload a new version instead. A current rejected proof may be explicitly sent again when the customer asks to reconsider it. The original rejection remains on the activity timeline.

The art queue and follow-up lists show current versions. Deleting the current proof clears approval and does not reactivate an older sign-off. Deleting an older historical version leaves the current approval intact. Deletion requires a manager and records any previous sign-off on the activity timeline. A Drive copy may remain in the shop’s Drive after the CRM version is deleted; the delete response reports that boundary.

For reusable workflows, proof uploads, sends, decisions and current-proof deletions change the job revision. A phone or tablet showing an earlier revision must refresh before completing a task. Artwork-gated production tasks also reject a stale historical approval timestamp when the current stored proof is not approved. Shops that explicitly use manual approvals without stored proofs retain that existing behavior.

The work ticket selects the current approved appearance proof only. It does not show a superseded sign-off as current. Customer appearance approval does not verify resolution, dimensions, separations, trapping, stitch paths or production-machine compatibility.

## Create an appearance mockup in the browser

Open **Create mockup** from a job's **Art & Proofs** section. Choose a photo of the actual product and color, then the customer's original raster artwork. Drag the artwork, use the arrow keys, or enter its position, width and rotation. The artwork keeps its aspect ratio; a transparent PNG or WebP avoids an unwanted background. A warning shows when artwork extends beyond the photo and will be cropped in the proof.

Compositing and PNG export run on the current device without AI, a provider account or server rendering. This is visual placement: the photo does not calibrate inches, perspective, printable area or garment-size differences. **Requested print size** records optional review notes in inches, millimeters or centimeters; it does not resize the original or prepare a machine file. The composer does not redraw logos, recolor garments, remove backgrounds, generate separations or digitize embroidery.

Both inputs must be still PNG, JPEG or WebP, at most **10 MiB each**, **4096 pixels per edge**, and **8 million pixels combined**. The browser checks bounded headers before decoding and applies the recorded EXIF orientation. Images it cannot decode consistently must be exported as an upright supported image first. The proof is PNG, at most **2000 pixels per edge**, **4 million pixels** and **16 MiB**. Its canvas follows the oriented photo's aspect ratio and never enlarges that photo. These composer limits are narrower than the separate production-file attachment limits below.

**Save draft mockup** uploads the unchanged photo and artwork as two private source assets, plus the browser-generated appearance proof. The server stores their SHA-256 digests and a canonical placement recipe. In one database transaction it creates the draft proof, clears current customer approval, invalidates any technical release, requires a new technical release and saves a retry receipt. Saving does not send anything to the customer. Return to the job to review and send the draft, then record the separate staff production review after customer approval. The two source assets count toward the job's 100-file limit and remain separate from the public proof.

The current tab retains files, placement and the exact exported PNG if validation or a save request fails. **Retry same draft save** reuses the request ID and bytes, so a committed save with a lost response returns its existing proof rather than adding another. Changing the draft creates a new request. A stale job version requires refreshing while keeping the draft; a removed saved proof or original cannot be silently replaced by a retry. Unsaved work is not stored across browser reloads or tab closure. See the [composer contract](MOCKUP-COMPOSER-CONTRACT.md) for retry and inspection boundaries.

### Optional S&S catalog photo

Under **Use an S&S catalog photo**, enter the exact S&S SKU for the color and size variant. This requires the shop's S&S account number and API key in Settings. The adapter uses S&S's product API, not the PromoStandards media service. It offers only the views returned for that SKU; it does not search by style or substitute another product or color. No credentials are needed to use a manually uploaded photo. SanMar catalog photos are not connected to this composer.

S&S photos pass through a restricted, bounded download route. A signed, expiring ticket binds the shop, supplier identity, selected view and exact photo digest. The save records verified supplier provenance only when that ticket matches the uploaded bytes. Verification establishes where the photo came from, not its physical accuracy or production suitability. A new save with an expired or mismatched ticket requires a new selection, or the user's explicit **Use as unverified shop photo** choice. An expired ticket can still recover an existing exact save receipt after its signature, shop and digest are verified; that path cannot create a new proof. The server does not silently remove verification. Supplier images are not redistributed as a bundled template library.

## Original artwork and prepared production files

On a job, **Production files & review** separates the customer’s **Original artwork** from **Prepared production files**. Upload the unchanged original and the separate files your team will print, cut or stitch. An appearance mockup is not a machine input. These file uploads do not create customer proof versions or send anything to a customer. The existing estimate proof workflow remains available; the technical file and release workflow is job-based.

Staff can upload and download files from their own shop. Source and prepared-file downloads are authenticated attachments on staff API routes; customer proof links and proof tokens do not grant access to them. Authentication-disabled single-shop installations retain their existing access model and need an appropriately restricted network. Files currently use the installation’s upload storage, including when customer proofs are stored in Google Drive. The new asset workflow does not automatically copy these files to Drive.

Each file is limited to 40 MiB; each job can hold up to 100 source and prepared files combined. Supported extensions are PNG, JPG/JPEG, WebP, SVG, PDF, EPS, AI, PSD, TIF/TIFF, DST, PES, JEF and EXP. The server checks extension, size and basic format signatures, then computes a SHA-256 digest without decoding or executing the file. JEF and EXP are opaque handoff formats with only basic size checks. Passing these checks does not establish that a file is complete, safe for a particular machine, or ready to print. Asset metadata is immutable: upload a new file to record a correction.

## Record a technical release

A manager opens **Review and release**, checks the files in the shop’s production software and selects 1–20 prepared files and, optionally, up to 20 originals. Record the decoration method, reviewed width and height in inches, millimeters or centimeters, equipment/profile information and applicable ink, thread or material notes. For multiple placements, identify each file and placement in the review notes. The dimensions record the review; entering them does not resize or generate files.

The manager must explicitly confirm the review. The current customer proof must already be approved. The server re-reads and hashes every selected source/prepared file before saving the release, rejecting missing or changed bytes. It then rechecks the artwork revision and records the reviewer, time, specifications, exact proof/job snapshot and file manifests together. A stale request returns 409. The form keeps entered notes and dimensions and requires refreshing the files before retrying.

The release records a human review, not automatic machine, RIP, separation or digitizing validation. Any needed sew-out, RIP check or physical test remains the shop’s responsibility. Original bytes and technical review records are preserved separately from the customer’s appearance decision.

## Requirements and invalidation

The migration is additive. Existing proofs receive the `legacy_proof` purpose, existing jobs retain their task/status records, and no old approval becomes a technical release. Ordinary jobs default to an optional technical requirement until a manager enables it or records a release. Optional means the existing manual workflow can continue; it does **not** mean `technical_ready` is true.

Recording a release automatically requires a current technical release on that job going forward. A manager can enable or disable the job requirement under **Advanced production controls**; changing the requirement revokes any active release. The native composer creates proofs with the `appearance_mockup` purpose. Such a current proof always requires a separate release and cannot have that requirement disabled.

Uploading a source/prepared file, replacing or changing the current proof, or changing the job’s garment, decoration or quantity/size breakdown invalidates the release. For jobs that inherit their garment lines from an estimate, changing those lines also revokes the release; price-only and customer-note edits do not. Sending a current proof for review, recording a decision or deleting the current proof also changes the artwork revision. Normal mutations record revocation; readiness additionally compares the saved proof, production-relevant job fields and selected-file metadata against current database records. Due dates, title and rush changes alone do not invalidate the technical snapshot. Deleting an unrelated historical proof does not revoke the current release.

When a release is required, production, QC, shipping and completion transitions are held until a current release exists, including transitions from tasks, board/API/scan and automation paths. A workflow step can also require **Technical production release**. See [reusable workflows](PRODUCTION-WORKFLOWS.md). A manager may explicitly revoke a release with a reason; previous review records stay in the audit history.

File integrity is checked on asset upload and again when recording a release. Readiness queries compare database snapshots; they do not continuously monitor or hash the external filesystem. Replacing bytes directly on disk after release is outside that monitoring boundary. Restore files from verified backups or upload them as new assets and review them again; do not replace stored files in place.

## Production manifest API

**Production manifest** downloads `GET /api/jobs/:id/print-package?download=1`, a JSON record, not a rendered print file or a RIP package. Its contract is:

| Field | Meaning |
| --- | --- |
| `appearance_proof` | Current approved customer proof, with its local/Drive URL, version and purpose; otherwise null. |
| `approved_art` | Compatibility alias for `appearance_proof` only. Never treat it as prepared machine input. |
| `appearance_approved` | Whether the current customer proof is approved. |
| `technical_ready` and `ready` | Both require a current staff release matching the proof, job specifications and selected-file metadata. Customer approval alone no longer sets `ready`. |
| `release_required` | Whether this job enforces the technical hold. A false value does not certify any file. |
| `production_files` | The released prepared-file manifest and authenticated download paths when technically ready; an empty list otherwise. |
| `release` | Current ready release summary, reviewer and specifications; otherwise null. |
| `blocking_reasons` | Reasons the technical record is not currently ready. |

Clients that previously interpreted `ready` or `approved_art` as a production-file guarantee must update. The manifest retains garment quantities and any legacy separation notes, but those notes are not generated separations or evidence of machine validation.

Decision records, job approval, scheduling and activity updates commit together. Customer automation hooks run afterward; they do not have an exactly-once delivery guarantee across a process crash. Actual email/Drive delivery and physical production acceptance require the shop’s own configuration and review.

Autopilot's optional illustration is a separate local concept, visibly labelled as a generic garment with approximate placement and color. It is not uploaded into the proof queue. No attachment means no generated logo or proof. Use the job's native photo composer or upload an actual prepared proof when ready. PSD editing, artwork-provider adapters, shop worker connections, automated separations and digitizing are not implemented. See [artwork tools and compute ownership](ARTWORK-COMPUTE.md) for the remaining integration direction. All current proof, composer, file and technical-release controls work without AI.
