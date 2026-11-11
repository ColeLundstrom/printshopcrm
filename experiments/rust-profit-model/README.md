# PrintShopCRM Rust pricing experiment

This is an isolated migration feasibility experiment. It does not replace the app,
change the current release or database, or provide legal clearance. It retains
AGPL-3.0-or-later and explicitly records its derivation from the existing model.

## Current verification status

- The existing JavaScript pricing-model tests passed: 14 tests on 2026-10-10.
- Generated 1,362 frozen, fictional JavaScript oracle cases: 1,336 successful
  outputs and 26 rejected-input cases.
- Official Rust 1.90.0 CI passed on Linux, Windows and macOS at commit
  `497381d219260b07939761a63feef16c74a5aace`: seven unit tests, all 1,362 parity
  cases, debug and optimized profiles, release build and a synthetic CLI check.
  [Verified run](https://github.com/ColeLundstrom/printshopcrm/actions/runs/38090044043).
  The local environment still has no compiler/Cargo; local Rust execution is not claimed.
- No production, customer data, provider, database, HTTP or browser migration is
  included. This is not a full JavaScript-to-Rust conversion.

## What is implemented

A dependency-free Rust library and stdin/stdout test utility calculate:

- Minimum unit cents and integer total cents for the existing one-operation quote model.
- Monthly break-even and target-sales cents.

Checked `u128` rational arithmetic preserves accepted decimal inputs until ceiling
to cents. It fails closed on unsupported arithmetic range, invalid inputs or totals
above JavaScript's safe-integer cents limit. It has no external crate dependencies.

The input fields follow the existing model; the CLI accepts tab-separated decimal
spellings with a leading `quote` or `month`. The fixture generator converts real
JavaScript number values with `String(value)` so the oracle and Rust parser receive
the same decimal spelling.

## Intentional gaps

The current app uses arbitrary-precision BigInt fractions. This experiment has a
smaller checked range and must not be substituted transparently. It also omits
unrounded cost/profit/per-hour outputs, warning strings, API error-class parity,
browser integration and quantity-list handling. A full replacement must either
match the existing accepted numeric domain or ship a reviewed, versioned contract
change. Zero and negative forecast-profit presentation also need explicit testing.

Fees are a planning assumption, not a reproduction of each processor's actual
rounding rules. No tax, freight, discounts, omitted operating costs or extra
production stages are inferred. Spoilage is an additive materials allowance.

## Run when a Rust toolchain is available

From this directory:

    cargo test --offline
    cargo test --offline --release
    cargo build --offline --release

The integration test reads `tests/parity.tsv`; Node is not required to run those
frozen cases. To regenerate from the exact recorded JavaScript source:

    node tests/generate-fixtures.mjs /path/to/public/js/shared/profit-planning.js

Review and update `tests/fixture-provenance.json` if the source commit changes;
the recorded source content hash must match. Do not regenerate expected answers
from Rust itself.

## Provenance and next decision

The model is derived from PrintShopCRM commit
`7b3d654ada5f94e224269c11701424612425ba62`,
`public/js/shared/profit-planning.js`. The existing LICENSE is included unchanged.
Changing the language does not create an independent clean-room codebase or
remove upstream rights. See `reports/ASSESSMENT.md` for source-backed findings,
specific unknowns, proposed release controls and staged migration gates.
