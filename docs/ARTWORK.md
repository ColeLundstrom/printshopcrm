# Artwork and proof approvals

PrintShopCRM records proofs and customer decisions without requiring AI. Upload the actual proof you want reviewed from the job’s **Art & Proofs** section. Each upload becomes a new version. Only the newest version can be sent for approval or decided; older versions remain visible as history on the job.

A replacement clears the job’s artwork approval. A superseded customer link shows the old proof for reference and cannot approve or reject it. Sending an already-approved proof for another decision is refused; upload a new version instead. A current rejected proof may be explicitly sent again when the customer asks to reconsider it. The original rejection remains on the activity timeline.

The art queue and follow-up lists show current versions. Deleting the current proof clears approval and does not reactivate an older sign-off. Deleting an older historical version leaves the current approval intact. Deletion requires a manager and records any previous sign-off on the activity timeline. A Drive copy may remain in the shop’s Drive after the CRM version is deleted; the delete response reports that boundary.

For reusable workflows, proof uploads, sends, decisions and current-proof deletions change the job revision. A phone or tablet showing an earlier revision must refresh before completing a task. Artwork-gated production tasks also reject a stale historical approval timestamp when the current stored proof is not approved. Shops that explicitly use manual approvals without stored proofs retain that existing behavior.

The print package selects the current approved proof only and uses its recorded Drive or local URL. Approval is permission to use that proof; it does not verify resolution, dimensions, separations, trapping, stitch paths or production-machine compatibility. Automated digitizing and production-ready art generation are not promised. Reliable preflight, proof composition and machine-specific output validation remain separate work.

Decision records, job approval, scheduling and activity updates commit together. Customer automation hooks run afterward; they do not have an exactly-once delivery guarantee across a process crash. Actual email/Drive delivery and physical production acceptance require the shop’s own configuration and review.

Autopilot's optional illustration is a local concept, visibly labelled as a generic garment with approximate placement and color. It is not uploaded into the proof queue. No attachment means no generated logo or proof. Upload the actual proof on the job when ready. See [artwork tools and compute ownership](ARTWORK-COMPUTE.md) for the researched integration direction and its implementation status.
