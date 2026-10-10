# Locked npm dependency notices

Reviewed on 2026-10-10. This is a notice-packaging record, not legal advice,
ownership verification, an independent-authorship claim, or a guarantee that a
release meets every applicable obligation. The application license is unchanged.

## Distributed files and evidence

- [THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md) retains the complete
  license texts for all 121 locked npm dependency entries: 120 packaged notices
  and one supplemental upstream notice. The original wording, authors and
  copyright notices are preserved. CRLF line endings are normalized to LF, as
  required by this repository's checkout rules.
- [dependency-inventory.json](dependency-inventory.json) records each installed
  path, package name, locked version and integrity, license metadata, and license
  file paths. `source_commit` identifies the original inventory snapshot;
  `packaging_verified_commit` identifies the release checkout against which its
  121 entries were rechecked. `lockfile_sha256` identifies the exact lockfile.
  The two copies of `content-type` 2.0.0 remain separately attributed by path.
  `busboy` and `streamsearch` lack lockfile license metadata but include the MIT
  texts recorded here.
- [third-party/nodable-entities/LICENSE](../../third-party/nodable-entities/LICENSE)
  is the unchanged supplemental upstream MIT text omitted from the npm archive
  for `@nodable/entities` 3.0.0.
- [nodable-notice-verification.json](nodable-notice-verification.json) records
  upstream source URLs, installed/source Git blob hashes and the supplemental
  license's SHA-256. Eight installed files, including `package.json` and all
  runtime JavaScript, match upstream commit
  [`ac48e7ea591da372be023a481875c747535812b3`](https://github.com/nodable/val-parsers/tree/ac48e7ea591da372be023a481875c747535812b3).
  The installed `src/index.d.ts` differs from that snapshot and exactly matches
  [an earlier declaration](https://github.com/nodable/val-parsers/blob/d2070d76a8ba07e6c7fa142caeb51ffd756e47eb/Entity/src/index.d.ts).
  Both commits have the identical MIT license blob. All nine installed files
  have identified upstream sources across these two commits; this is not a
  single-commit match. The package carries stale declarations (a default export
  and no `setXmlVersion`). This packaging change does not alter that dependency
  or its declarations.

These records cover the npm lockfile only. They do not cover Node, Alpine,
operating-system packages in the container, isolated browser/test tooling,
images, fonts, screenshots, inline artwork, supplier media or other non-npm
assets. Those components require their own source and notice review. No
conclusion about ownership or the absence of infringement follows from an
npm license identifier or a matching source hash.

## Offline regression checks

After the normal `npm ci`, run:

```sh
node --test test/third-party-notices.test.mjs
```

The test performs no network requests and also runs within `npm test`. It checks:

1. Exact inventory coverage of locked paths, names, versions and integrities,
   installed package identities, and the lockfile digest.
2. Complete installed license text in each dependency's attributed section,
   allowing only CRLF-to-LF line-ending normalization.
3. Exact supplemental license bytes, its pinned SHA-256 and Git blob hash.
4. Installed file hashes against the recorded upstream evidence, including the
   separate declaration source and the explicit single-snapshot mismatch.

CI's Docker job builds the normal image and reads both `/app/THIRD_PARTY_NOTICES.md`
and `/app/third-party/nodable-entities/LICENSE` from it with networking disabled.
Each must be byte-identical to its source file. This catches accidental exclusions
or changes in the shipped notices. The Dockerfile's existing `COPY . .` includes
these files; the container entry point and runtime dependencies are unchanged.
The isolated demo launcher also copies the complete notices, supplemental license and this
evidence directory; its existing integration test compares all of those files byte-for-byte.

## When dependencies change

1. Install from the updated lockfile and review every added or changed dependency,
   including nested copies. Reconcile removed entries too. Preserve all author,
   copyright and license text; never replace it with the application's license.
2. Update the inventory and its lockfile digest. Update the corresponding notice
   sections using the complete installed license texts. Keep the package-path
   section markers unique even when names and versions repeat.
3. For a package missing its notice, verify the specific source version and
   required text before distribution. Retain pinned links, file hashes and any
   mismatches or limits; do not assume the latest upstream license applies.
4. Update supplemental evidence and tests deliberately if the package contents or
   relevant source change. Do not just change expected hashes to make tests pass.
5. Run the focused check, `npm test`, and `npm run test:e2e`. Let the normal CI
   Docker job verify the actual built artifact before publishing. Broader rights,
   source-offer and non-npm asset questions remain separate review tasks.
