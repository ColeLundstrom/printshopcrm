# Browser mockup composer implementation contract

Implemented in the v157 source. This contract describes the native composer, optional S&S photo adapter and transactional save. It does not certify a supplier account, production output or future artwork-provider integration. User instructions are in [ARTWORK.md](ARTWORK.md).

Manual compositing runs on the device without AI. The original raster bytes remain unchanged. Staff choose a product photo and overlay artwork with locked aspect ratio, placement and rotation. The canvas does not recolor products, redraw logos, generate artwork, remove backgrounds, distort artwork, make separations or create machine output. Placement is visual, without calibrated physical dimensions or printable areas. Saving creates a draft only; ordinary customer send/approval and a separate staff production release follow.

## Routes and frontend

- `#/jobs/:id/mockup` calls exported `mockupComposerView(jobId)` from `public/js/views/mockup-composer.js`.
- `GET /api/jobs/:id` supplies job context and `art_revision`.
- `GET /api/catalog/ss/products/:sku/media` requires an exact SKU and the shop's S&S credentials. It returns the identity for that SKU and only explicitly available views with opaque `media_id` values. There is no style search or substitute product fallback.
- `GET /api/catalog/ss/media/:media_id` returns same-origin bounded image bytes and `X-PSC-Media-Ticket` for verified image digest/provenance.
- `POST /api/jobs/:id/mockup-compositions`: multipart `photo`, `artwork`, `proof` (one each), `revision`, `request_id`, JSON `recipe`, optional `media_ticket`. Response `{proof_id,version,job_id,revision,replayed}`. The frontend returns to the job after a confirmed save. An uncertain retry retains the exact files, PNG blob, recipe, original revision and request ID; editing creates a new request ID.

The frontend retains a draft on validation, network or session errors, and can refresh a stale job revision without discarding its images or placement. Navigation asks before discarding unsaved work; leaving during a pending save is blocked within the app. Reload/close protection is browser-dependent, and drafts are not persisted across tab closure or reload. Cancelling an image load discards its late result; `createImageBitmap` itself is not abortable. Native selections stay blocked until outstanding image work settles, so repeated cancellation does not create unbounded decodes. Replaced/stale bitmaps are closed, rendering is coalesced with animation frames, and exit clears bitmap/canvas references. No server-render fallback exists.

## Image and resource limits

| Resource | Current bound |
| --- | --- |
| Photo and original artwork | Still PNG, JPEG or WebP; 10 MiB each; 4096 pixels per edge; 8,000,000 decoded pixels combined. |
| Exported proof | Still PNG with normal orientation; 2000 pixels per edge; 4,000,000 pixels; 16 MiB. |
| Shared header inspection | 256 KiB of non-pixel headers/metadata and at most 4096 chunks/segments. JPEG geometry/orientation must be available through its first scan header within a 256 KiB prefix. |
| Save operations | Two concurrently per server process, including multipart upload, file inspection and cleanup. |
| Job source/prepared attachments | 100 total; each new composition adds two source assets. |

The shared [raster parser](../public/js/shared/raster-header.js) exports `readRasterHeader(Uint8Array)`, `RASTER_HEADER_BYTES = 262144`, and `MOCKUP_LIMITS` with `inputBytes`, `inputEdge`, `combinedPixels`, `outputBytes`, `outputEdge`, `outputPixels`. Its return value is `{format,mime,width,height,orientation,orientedWidth,orientedHeight,animated}`; orientation is EXIF 1–8 and formats are `png`, `jpeg`, `webp`. Callers reject `animated: true` before decoding or saving.

PNG/WebP require the complete, size-bounded file because EXIF may follow compressed pixel chunks. The parser skips those pixel payloads and inspects container metadata without inflating or decoding them. JPEG scanning stops at the first scan header. Oversized, incomplete or ambiguous headers produce an actionable error. These checks are not full compressed-image validation. The browser then uses `createImageBitmap` with `imageOrientation: 'from-image'` and verifies its oriented dimensions; unsupported decoding or a mismatch requires a fresh upright image export. Original bytes are retained.

The server checks staged file size before allocating its bounded buffer, reads in 64 KiB chunks, verifies the filename extension against inspected format and hashes the bytes. It does not decode, paint, run AI or call a renderer. Network transfer, file storage and validation still consume server resources; the bounds are not a complete storage quota or paid compute system.

## Recipe

Recipe v1:

```js
{
  version: 1,
  renderer: 'browser-canvas-v1',
  sizing_mode: 'visual',
  canvas: {width, height},
  placement: {x, y, width, rotation},
  requested_print: {width, height, units} // optional, explicitly requested notes only
}
```

Placement is artwork center `x,y` in [0,1] of canvas; `width` in [0.01,2] of canvas width; rotation in [-180,180] degrees. Aspect ratio is original oriented artwork aspect ratio. Canvas follows oriented photo aspect ratio, scaled by `min(1,2000/max(photoWidth,photoHeight))`, rounded to nearest positive integer. Requested physical dimensions are optional positive values with in/mm/cm and do not calibrate the photo or generate production files.

The server requires that the proof's dimensions equal the calculated canvas. Requested physical dimensions must be positive, at most 10,000 in the stated units, and remain notes. Unknown recipe fields are rejected.

The saved canonical recipe adds `photo` and `artwork` objects containing the private `asset_id`, stored filename, original name, MIME, size, SHA-256 and inspected `header`. `output` records the proof's original name, MIME, size, digest and header. `provenance` is either null or the stable verified S&S identity, source URL and photo digest. It is supplied only by server-side ticket verification, never copied from client recipe JSON. The server validates geometry, originals and limits but cannot prove that rendered pixels follow the recipe without re-rendering; customer and staff review remain necessary.

## Save module

The synchronous [save module](../lib/mockup-compositions.mjs) uses the current tenant database:

```js
saveMockupComposition(jobId, {
  revision, request_id, recipe,
  photo, artwork, proof, // inspected {filename,original_name,mime,size,sha256,header}
  provenance: null,    // or the server-verified stable supplier record
  replay_only: false,  // optional server control; never permits a new save when true
}, actor) // {name,id}, or a staff name
// => {proof_id,version,job_id,revision,replayed}
```

The server owns multipart I/O, staged-file inspection and cleanup. The module performs no filesystem operations. One transaction validates the job/revision and file count, adds two immutable `art_assets` rows with role `source`, and inserts the next draft `art_versions` row with purpose `appearance_mockup`, original artwork `source_asset_id` and canonical `composition_json`. It clears `jobs.art_approved_at`, enables `art_release_required`, calls `recordArtChange` once and saves a `mockup_composition_receipts` row. This revokes an existing release and updates an enrolled job's production revision/event without enrolling legacy jobs. A database error rolls all those writes back.

Receipt identity is `(job_id, request_id)` within the tenant database. Its hash binds the original request revision, normalized recipe, each file's original name/MIME/size/hash/header and stable verified supplier provenance. Regenerated staging filenames, staff identity and the transport-only `replay_only` flag do not change that hash. Receipt lookup precedes stale-revision rejection. An exact retry returns the original proof and original save revision even if a later proof is now current; it changes no proof decision or job state. A reused ID with different content returns `409 mockup_request_conflict`. Missing/changed referenced proof or source records return `409 mockup_receipt_unavailable`; a deleted proof's receipt reference is set to null, preventing attachment to a reused row ID. With `replay_only: true`, a missing receipt also returns that error before any insertion.

Successful new saves return `replayed: false`; exact receipt replay returns true. Requests without an existing receipt must match the current artwork revision or return `409 art_revision_conflict`. Cleanup removes only newly staged files with no committed asset/proof ownership, retaining bytes if database ownership is uncertain. The receipt does not establish filesystem integrity after saving; direct external file edits remain outside the monitoring boundary.

## Catalog module

The [catalog module](../lib/catalog-media.mjs) exports `createCatalogMedia({secret,transport,resolver,now,limits})`. Production uses a server signing secret; transport/resolver/clock and lowered limits are injectable for fixtures. Its methods are `resolveProduct({tenant,sku,settings})`, `fetchMedia({tenant,media_id})`, `verifyTicket({tenant,ticket,sha256,allowExpired})`, `clearTenant(tenant)` and `stats(tenant)`. Tenant scope is explicit. Credentials come from the shop's `ss_account` and `ss_api_key` settings and stay server-side.

The exact-SKU lookup calls S&S's product API and rejects zero, multiple or mismatched product rows. It returns only present color-specific views: front, back, side, direct side and on-model front/back/side. The download path accepts opaque handles, not client URLs. It allows only HTTPS `www.ssactivewear.com` and `cdn.ssactivewear.com` image paths accepted by the adapter, validates/pins public DNS addresses, refuses redirects and HTTP content encoding, and sends no account credentials to image hosts. Response MIME must match inspected bytes, and animated/oversized/invalid images are rejected.

| Catalog resource | Current bound |
| --- | --- |
| Product JSON / photo bytes | 512 KiB / 10 MiB per response. |
| Supplier operation | 12 seconds; four concurrent globally and two per shop. |
| Outgoing photo response | Four concurrent globally, two per shop; lease held through socket completion with a 30-second ceiling. |
| Opaque handles | Ten-minute lifetime; 256 globally and 32 per shop. |
| Handle metadata | 512 KiB globally and 64 KiB per shop; photo bytes are not cached. |
| Signed photo ticket | One-hour lifetime; binds tenant, exact identity/view/URL, SHA-256, retrieval time and expiry. |

`fetchMedia` returns `{bytes,mime,sha256,ticket,provenance}`. The HTTP response carries `X-PSC-Media-Ticket`. Saved provenance includes `supplier`, `sku`, `style_id`, `style`, `brand`, `color`, `color_code`, `size`, `view`, `source_url`, `sha256`; transient ticket token, tenant, retrieval time and expiry are not copied into the canonical recipe. A renewed ticket for identical identity and bytes therefore does not alter the receipt hash.

Invalid signatures, another shop's ticket, changed photo bytes and expired tickets cannot create a verified save. The server may accept an expired ticket solely to replay an existing matching receipt: it still verifies the signature, tenant and digest, and invokes the save module with `replay_only: true`. Without a matching receipt that path cannot insert assets or a proof. For a new save, select the photo again or explicitly use it as an unverified shop photo. There is no silent fallback to verified status, another supplier or a generic photo.

## Outside this implementation

SanMar media, S&S PromoStandards Media Content, calibrated printable templates, PSD/smart-object editing, local GPU workers, provider rendering/AI, automated separations/digitizing, and hosted compute quotas/billing are not implemented by this composer. They remain optional future work, never requirements for ordinary CRM operations or manual mockups. Source files may use wider formats through the separate production-attachment workflow; that does not make those formats editable in the raster composer.
