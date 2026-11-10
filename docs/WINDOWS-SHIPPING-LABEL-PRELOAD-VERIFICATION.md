# Windows shipping-label test preload

## Failure

The v1.40.0 main commit, `c3ddd57fa1c88246643602b4e2ed718acd88db52`, failed
[Windows CI](https://github.com/ColeLundstrom/printshopcrm/actions/runs/42756737053/job/129632744451)
before the shipping-label HTTP fixture's server started. Node rejected the absolute `D:` path
passed to `--import` with `ERR_UNSUPPORTED_ESM_URL_SCHEME`. The other eight jobs passed;
Windows E2E, seed/reset and server-boot checks did not run after the unit-test failure.

The [image workflow](https://github.com/ColeLundstrom/printshopcrm/actions/runs/42756739099)
failed at the same preload and skipped publication. The
[v1.40.0 source release](https://github.com/ColeLundstrom/printshopcrm/releases/tag/v1.40.0)
already exists. Source publication, container publication and production deployment are distinct.
This failure does not establish a production shipping-label defect or a successful live-provider test.

## Bounded change

Keep the fake EasyPost module as a file URL rather than converting it to a filesystem path.
The fixture's existing network guard and all HTTP assertions remain intact. No production code,
workflow threshold, dependency, database schema, release tag or deployment changes.

The added regression checks the actual preload argument's file-URL contract and starts a child
process with a rejecting fetch guard followed by the fake. It verifies that the fake answers its
supported host and still rejects an unrelated outbound request. It uses no provider credentials
or external service.

## Local verification, November 10, 2026

An isolated checkout from the exact main commit above used Node 22.23.2 on macOS and only
synthetic data. No working shop database or configuration was copied.

- The new regression failed first on the original code with `ERR_INVALID_URL`.
- After the fix, both the preload regression and full shipping-label HTTP fixture passed.
- All 621 Node tests passed with zero failures or skips.
- `git diff --check` and `node --check test/shipping-labels-http.test.mjs` passed.
- `npm run test:all` was interrupted by the local runner's network policy at the existing
  webhook DNS-rebinding probe (`http://rebind.test:9`). The repository gate did not complete.
- A separate `npm run test:e2e` reached the existing off-loopback bind assertion, then the
  runner's network policy blocked its LAN-address probe. E2E did not complete.

Neither blocked probe was retried or bypassed; no assertion or security setting was weakened.
These are local verification limits, not passing aggregate gates. Exact-commit GitHub CI,
including the full Windows job, must pass before merge consideration. Existing review,
release, backup/rollback and deployment holds remain in force.
