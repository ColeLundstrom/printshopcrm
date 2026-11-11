# Rust migration and provenance assessment

Reviewed 2026-10-10. This is an engineering/provenance assessment, not legal advice,
a non-infringement opinion or a guarantee against claims.

## Recommendation

Preserve the working app while evaluating an AGPL-preserving Rust migration in
isolated stages. Address provenance and license compliance directly. Calling a
translation "unique" or "clean-room" would overstate what this experiment does.

The Copyright Office distinguishes copyrightable program expression from
functional elements such as algorithms and logic. Copyright also includes the
right to authorize derivative works. Consequently, our engineering inference is
that changing languages alone cannot establish independent authorship or remove
the need for permission. [Computer programs](https://www.copyright.gov/circs/circ61.pdf)
and [17 USC 103/106](https://www.copyright.gov/title17/92chap1.html#106).

Ordinary licensed infrastructure can coexist with original application code.
"Original application work" should mean documented independent authorship or
authorized derivation, not a claim that every standard library, protocol, screen
convention or arithmetic formula has never existed elsewhere.

## Verified repository facts

- Candidate initially inspected: `7b3d654ada5f94e224269c11701424612425ba62`,
  version 1.36.0. Later release changes are owned by the release task and are
  outside this experiment. Individual inventories record their snapshot commit.
- Node 22.13+, Express 5, built-in SQLite, server-rendered public pages and plain
  browser JavaScript. Approximately 81,669 tracked JavaScript/MJS/HTML lines include
  test code; 73 server modules, 66 browser-JS modules, 301 top-level app route or
  middleware declarations and 87 Node unit-test files at the inspected snapshot.
- SQLite uses per-shop databases plus `control.db`, WAL, foreign keys, transaction
  boundaries and request-local tenant context. Auth hashes use scrypt. Migration
  must preserve these contracts, not merely route names.
- The lockfile has 121 npm packages: 108 MIT after manual resolution of two missing
  metadata labels, 11 ISC, one MIT-0, one BSD-3-Clause. Direct dependencies:
  Express 5.2.1, fast-xml-parser 5.11.1, Multer 2.3.0, Nodemailer 9.1.1, QRCode
  1.5.4 and ws 8.21.3. Busboy 1.6.0 and streamsearch 1.1.0 omit lockfile license
  metadata but include MIT license text. This is not a vulnerability assessment
  or a determination that every distributed component satisfies its obligations.
- No repository-level third-party notices file or per-asset rights register was
  found. Installed npm packages retain notices; generated review snapshots are
  included here. A CycloneDX SBOM records the package-lock dependency graph.
- **Specific packaging gap:** `@nodable/entities` 3.0.0 declares MIT but the
  installed package has no license text file. The upstream repository has an MIT
  license; the supplemental exact upstream notice is included in this report bundle
  and must be included in distribution. Eight package/runtime files match upstream
  version-3.0.0 commit `ac48e7ea591da372be023a481875c747535812b3`. The remaining
  declaration matches earlier commit `d2070d76a8ba07e6c7fa142caeb51ffd756e47eb`
  exactly; both revisions have identical MIT license text. The package retained
  older declarations (default export and no `setXmlVersion`) subsequently corrected
  upstream. This specific content-provenance gap is resolved; ownership is not
  certified by matching hashes. See `nodable-notice-verification.json`.
  This is a notice-packaging issue to resolve, not evidence of proprietary code.
  `emoji-regex` has its notice in `LICENSE-MIT.txt` and is not a missing-notice case.
- Nine tracked standalone visual assets: seven PNG app screenshots and two SVG
  app logos. Inline SVG artwork needs separate source-level review. Supplier
  images fetched at runtime are outside the npm/checked-in-asset inventory.

## Full public history, not just the shallow checkout

GitHub's main history was read to its root: 502 commits from 2026-08-23 to
2026-10-01. GitHub attributes all to `ColeLundstrom`, under author names
`shirtagency` and `Cole Lundstrom`. Attribution does not prove ownership or the
origin of material in the initial import.

The concrete licensing sequence on August 23 is:

1. [Initial v1.0.0](https://github.com/ColeLundstrom/printshopcrm/commit/756d5fb04d5cbf5ebe78e40d22a772a1f89a42be)
   at 16:56 UTC, MIT, with a PrintShopCRM-contributors copyright notice.
2. [MIT to BSL 1.1](https://github.com/ColeLundstrom/printshopcrm/commit/da738eb8f8f7ccc836fc38ff55ebe2828679aa4e)
   at 17:24 UTC, naming Cole Lundstrom as licensor and restricting hosted service use.
3. [BSL to AGPL](https://github.com/ColeLundstrom/printshopcrm/commit/0b30f55ff50928bb6e9193c2f58796b28ead9710)
   at 17:48 UTC. This also introduced contributor terms for commercial relicensing.

The current candidate contributor policy says contributors retain ownership and
does not request that additional proprietary-relicensing grant. Keep the applicable
historical contribution terms and any actual grants; changing today's policy is
not evidence of rights over all past contributions. These transitions are a review
item, not evidence that a violation occurred.

Both app SVG logos originate in the initial commit. Screenshot-directory changes
occur in the initial commit, the AGPL commit and the August 24 price-matrix commit.
Commit history alone does not establish who created depicted artwork or whether
names/logos in screenshots are authorized. See the asset inventory for exact hashes.

## Concrete controls before release

1. **Ownership ledger:** for application source, inline icons, standalone artwork,
   docs and fixtures, record author, source, creation/import commit, license and
   evidence of permission. Resolve the initial import and historical relicensing
   authority with the maintainer. Do not erase earlier attribution or history.
2. **Dependency controls:** commit the lockfile, generate version-pinned CycloneDX
   or SPDX SBOMs at release, retain actual notices/license texts in distributed
   images/packages, fail CI on new unknown or unapproved licenses, and review
   transitive changes. An allowlist is a workflow control, not a legal conclusion.
3. **Exact source offer:** the app already renders AGPL source links. For every
   hosted build, point `PSC_SOURCE_URL` to the corresponding public source commit
   or complete source bundle, including build/install scripts. Test anonymous app,
   auth, customer approval/payment/art, widget and embed paths. A link to generic
   upstream while running unpublished modifications is insufficient evidence of
   correspondence. Preserve required notices and license text in a Rust port.
4. **Contribution evidence:** ask contributors to identify copied or adapted code,
   external assets, dependencies and their authority to contribute; retain the
   review record. Do not assume a GitHub author string is an assignment agreement.
5. **Assets and service terms:** confirm rights for screenshots, logos, inline SVGs,
   sample artwork, supplier photos and any model weights or fonts added later.
   Record source/allowed use/attribution separately from the application license.
   Keep customer uploads and secrets out of source distributions and fixtures.
6. **Original implementation guardrail:** work from independently written feature
   specifications and authorized sources. Do not copy proprietary competitor
   source, distinctive wording, logos or private assets. Record derivation where
   existing open-source code is adapted. A code-similarity search is only a signal,
   not proof of originality or infringement.
7. **Legal review scope:** software counsel should review ownership and license
   transitions, contribution grants, trademark/branding and comparative claims,
   supplier/media permissions and relevant contractual restrictions, and any
   specifically identified infringement concern. Patent, privacy and contract
   risks are not removed by a copyright/license scan or a Rust rewrite.

AGPL sections 4–6 cover notices and distribution/source conditions; section 13
requires a source opportunity for users of a modified networked version. The
precise text, including qualifications, controls. [AGPL v3 text at OSI](https://opensource.org/license/agpl-3.0).

## Staged migration and stopping gates

The narrow Stage 1 experiment has passed official Rust 1.90.0 CI on Linux,
Windows and macOS: debug/release tests, all 1,362 frozen cases, build and CLI check.
This does not satisfy the full-domain/full-output replacement gate below.
[Verified experiment run](https://github.com/ColeLundstrom/printshopcrm/actions/runs/38090044043).

**Stage 0: provenance and baseline.** Record source SHA, schema snapshots, a complete
tested backup/restore set, API fixtures and release-test results. Resolve identified
rights gaps before releasing affected material. No production data in test fixtures.

**Stage 1: pure arithmetic.** Compile/test this no-dependency pricing experiment in
debug and release modes. Compare frozen independent JS oracle outputs. Expand
coverage to every accepted numeric boundary, all result fields and validation
behavior before considering it a replacement. Benchmark only after correctness.

**Stage 2: read-only Rust backend slice.** Preserve the same API/JSON/status/auth
contracts and tenant isolation. Use synthetic database copies in read-only mode.
Compare queries, pagination, money/date/null handling and response semantics.

**Stage 3: writes and integrations.** Migrate one domain at a time behind an explicit
rollback switch. Verify transactions, foreign keys, unique constraints, IDs,
idempotency, session/password/API-key compatibility, signed links and webhooks,
retries, customer approvals and reconciliation. Avoid dual writes without a reviewed
consistency/recovery design. Require provider-sandbox acceptance tests.

**Stage 4: browser code choice.** Rust can compile to WebAssembly, but browser APIs
commonly still involve JavaScript glue; a Rust backend does not make the existing UI
Rust. A Wasm UI is a separate engineering decision with accessibility, navigation,
print/PDF, offline/service-worker, performance and cross-browser gates. HTML/CSS
remain browser presentation technologies. [Official wasm-bindgen guide](https://wasm-bindgen.github.io/wasm-bindgen/introduction.html).

**Stage 5: deployment only after explicit acceptance.** Run the complete legacy and
new tests on the exact commit, restore to a disposable environment, rehearse rollback,
check Windows/macOS/Linux filesystem behavior, verify the source offer and third-party
notices in the actual artifact, and obtain release approval. No silent production swap.

Rust's ownership model improves memory safety in safe Rust. It does not validate
pricing rules, authorization, licensing or business correctness. [Rust ownership](https://doc.rust-lang.org/book/ch04-01-what-is-ownership.html).

## Decision options

- Keep Node and apply provenance/release controls immediately: least migration risk.
- Rust backend and calculation core first, existing UI temporarily retained:
  recommended if Rust remains a technical requirement.
- Rust backend plus Wasm UI: largest compatibility and maintenance investment;
  requires a separate agreed UI migration scope.

None of these options can promise immunity from being sued.
