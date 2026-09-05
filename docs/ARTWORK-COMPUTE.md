# Artwork tools and compute ownership

Decision recorded 2026-09-04. This is an integration design and source review, not a claim that the adapters below are installed or production-tested. PrintShopCRM must work without AI. The free core must not depend on a paid artwork service. Heavy artwork processing belongs on the shop's device or its own provider account. Optional hosted processing requires separate, explicit metering and payment; it must never run inside the CRM request process.

## Current behavior

Manual proof uploads, version history and approval controls work without AI. Autopilot's optional concept uses a fixed-size browser canvas. It now leaves missing art missing, labels the generic garment illustration, and never uploads that illustration as a customer proof. The illustration is not an exact catalog mockup. There is no hosted rendering service, local worker connector, paid compute plan, PSD integration or reliable built-in separation engine in this release. No new vendor account has been connected or billed for this review.

## Shortlist

| Tool | Documented capability | Compute owner | Proposed fit / boundary |
| --- | --- | --- | --- |
| Photopea | Embedded editor with scripting, binary input and export through live messaging | Shop's browser for normal editing | First optional PSD smart-object editor to evaluate. Its free API is documented; white-label/ad removal has separate terms. Keep a native browser compositor and manual uploads available without it. |
| Dynamic Mockups | Render API using a template UUID and design assets; custom PSD templates; separate AI mockup features | Vendor, using the shop's paid account | Best first hosted template adapter to prototype from this shortlist. Exact supplier products require our own SKU-to-template mapping. Do not assume every web AI feature has an API. |
| Adobe Photoshop API | V2 smart-object replacement through Create Composite | Adobe, using the shop's account | Alternative for shops already invested in Adobe templates. Validate V2 compatibility and entitlements before implementing. |
| ComfyUI local server | Queued workflows, progress, output and cancellation endpoints | Shop's workstation/GPU | Optional local AI worker for approved, pinned workflows. Hardware and model licenses vary. Never install or run it on the CRM VPS by default. |
| Separation Studio NXT | Editable separations, export and local RIP/hot-folder workflows | Shop's desktop/RIP | Start with file handoff, not invented API automation. No public general integration API was verified in this review. |
| InkSplit | Vendor describes browser GPU processing; channel/underbase controls and EPS DCS output | Shop's browser for the documented processing | Start with file handoff. No public API or right to embed/repackage its proprietary engine was verified. Its subscription remains optional. |

The comparison above is an engineering recommendation from documentation, not a measured quality ranking. Vendor claims of perfect separations or exact previews are not acceptance evidence.

Sources: [Photopea live messaging](https://www.photopea.com/api/live), [API and pricing boundary](https://www.photopea.com/api/), [local processing policy](https://cdn.photopea.com/privacy.html); [Dynamic Mockups API guide](https://help.dynamicmockups.com/en/articles/13251427-dynamic-mockups-api-complete-guide), [product capabilities](https://help.dynamicmockups.com/en/articles/13251205-what-is-dynamic-mockups); [Adobe V2 smart-object migration](https://developer.adobe.com/firefly-services/docs/photoshop/guides/photoshop-v2/v1-to-v2/convenience-apis/smart-object-replace); [ComfyUI local server routes](https://docs.comfy.org/development/comfyui-server/comms_routes); [Separation Studio NXT](https://solutionsforscreenprinters.com/separation-studio-nxt/); [InkSplit processing](https://www.inksplit.com/), [export capabilities](https://app.inksplit.com/).

## Catalog-connected mockups

The first reliable path should be deterministic: select the actual supplier/style/color/view, place the original artwork, specify print dimensions, review, then save a new proof version. AI may make a scene or visual concept, but must not silently redraw a customer's logo or become the source of production dimensions.

S&S publishes product image fields and a PromoStandards Media Content service. SanMar offers PromoStandards and web services. These are sources for a catalog adapter; no reviewed mockup provider was verified to automatically resolve both suppliers. Current S&S normalization keeps one front image. The media adapter must preserve supplier product/part identity, color, front/back/side, original URL, retrieval time and any use restrictions. Never silently substitute a generic shirt for a hoodie or an approximate color for the ordered color.

Sources: [S&S product API](https://api.ssactivewear.com/V2/Products.aspx), [S&S PromoStandards services](https://promostandards.ssactivewear.com/), [SanMar integration offerings](https://info.sanmar.com/resources/electronicintegration/integrationofferings). SanMar's indexed v24.3 guide returned 404 on direct retrieval during this review, so its exact current media response contract still needs verification.

Use calibrated templates with explicit printable areas and transforms. A product photograph alone does not establish inches or account for size-dependent placement. Store original art separately from the mockup, with artwork hash, supplier identifiers, template version, dimensions and processing provenance. Missing view/calibration means request a manual template, not fabricate accuracy. Templates require appropriate distribution rights before inclusion in the open-source repository.

The native compositor should handle ordinary placement, rotation, sizing and export on the device without AI. PSD support is an optional extension, not a reason to make Photopea a mandatory closed-source dependency. Cross-origin catalog images may require a tightly restricted, cached download proxy; that proxy must enforce supplier hosts, redirects, response size and timeouts, and never become an arbitrary URL fetcher. Prefer binary messages to an embedded editor; validate both message origin and source window, serialize requests and bound returned file sizes. Do not copy wildcard-origin examples into the CRM's authenticated integration.

## Execution and billing boundaries to implement

1. **Browser:** Show “Runs on this device.” Use bounded image dimensions and memory estimates, cancellation and a worker where supported. An underpowered phone can review results or hand off to a shop computer. Never silently fall back to hosted compute.
2. **Shop worker:** Pair a revocable, tenant-scoped worker. It pulls jobs outbound over HTTPS; no public GPU port or exposed LAN endpoint. Lease each task, heartbeat, hash inputs/outputs and reject expired or superseded results. Permit only supported workflow versions and typed parameters, not arbitrary scripts or ComfyUI custom nodes from a job request.
3. **Shop provider account:** Show the provider and payer before submission. Separate artwork-provider credentials from the agent's model credentials. A shop's chat-model subscription does not imply access to any image API. Apply per-shop concurrency and spending caps; reconcile uncertain provider submissions before retrying so a timeout cannot repeatedly spend money. An unavailable provider leaves a retryable draft.
4. **Optional hosted compute:** Disabled until configured by the operator and explicitly enabled by the shop. Use separate workers and queues with CPU/GPU, memory, runtime, pixels, storage and concurrency ceilings. Reserve budget atomically before dispatch, use idempotent requests and durable usage records, reconcile provider charges, and refund unused reservations. Show estimated cost and hard caps; never bill an automatic retry twice. No unlimited processing bundled into basic CRM hosting.

These are required implementation boundaries, not existing enforcement controls. Ordinary file storage, network transfer and bounded validation still consume server resources; local rendering does not make hosting cost-free. Put storage/retention limits in the hosting plan as well.

## Production acceptance

Keep customer appearance approval separate from technical production approval. An attractive mockup is not separation, digitizing or machine validation. Attach reviewed separation files plus screen count, inks, print size, underbase, mesh/LPI/angles and RIP profile as applicable. Preserve original vectors and spot channels. An embroidery texture effect is not a stitch file.

Before promoting an adapter, test it against real shop fixtures: front/back of the correct tee and hoodie, dark/light garments, fine text, transparency, spot colors, gradients, large files, limited-memory devices and provider failures. Compare exported dimensions/channels and run a physical test print or RIP check where applicable. Automated digitizing remains out of scope until stitch output can be independently verified; importing a professionally prepared file remains useful.

First delivery order: native catalog/photo compositor and source preflight; optional PSD editor; reviewed separation-file handoff; shop-owned worker/provider adapters; separately metered hosted compute last. No paid connector should gate quoting, proofs, production, invoicing or other manual workflows.
