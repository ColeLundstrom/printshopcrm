# Desktop navigation space

On screens wider than 900px, Hide navigation gives the current screen the sidebar space. Show navigation restores every permitted destination. The preference survives reloads in this browser; blocked storage falls back to an in-memory preference. Mobile keeps its existing menu drawer. Resizing back to desktop closes any mobile backdrop and moves focus out of a hidden sidebar. No customer records, permissions, or database schema change.

Functional reference: InkSoft Collapsible Navigation, February 13, 2026, https://ideas.inksoft.com/changelog. This implementation provides explicit hide/show controls; hover-only navigation is not implemented. No competitor code or visual assets used.

Validation (September 20, 2026): 298 existing Node tests and two focused navigation tests passed. The final regression gate passed all 955 assertions; the isolated E2E suite passed. Browser checks covered desktop collapse, reload persistence, expansion at 901px, mobile drawer at 375px, and restoring keyboard focus when resizing an open mobile drawer to collapsed desktop. The synthetic demo launcher blocked external connections. Storage-denial behavior is covered by the focused test. No database migration or permissions change is involved.

The gate's expired September 15 deadline fixture was also refreshed using the existing date-relative fix from commit 6c483ac in the separate CRM migration branch. No CRM migration runtime changes are included here. Exact-commit CI is recorded in the competitor-watch checkpoint; local checks alone do not authorize deployment.
