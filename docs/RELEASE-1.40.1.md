# 1.40.1 — Container image for the 1.40 line

Base: published v1.40.0 (`c3ddd57`). No application code changed.

The v1.40.0 container image was never published: one shipping-label test passed a Windows drive
path to `--import`, the Windows job failed, and the image workflow skips publication when any
validation job fails. This release carries the test fix (#34) so the image can be built from a
tag that passes on every platform.

- `ghcr.io/colelundstrom/printshopcrm:latest`, `:1.40` and `:1.40.1` now carry everything in
  [1.40.0](RELEASE-1.40.0.md).
- If you run from source at v1.40.0 there is nothing to update.

Known limits are unchanged from 1.40.0.
