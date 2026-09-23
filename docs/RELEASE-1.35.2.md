# v1.35.2 — Desktop navigation space

Desktop users can hide and restore navigation, with the choice remembered in this browser. The toggle remains keyboard accessible; hiding a focused sidebar moves focus to the visible toggle. Mobile retains the existing drawer, including correct backdrop/focus cleanup when resizing to desktop. Blocked browser storage does not prevent use.

This release includes only PR #8, release metadata, and the deterministic deadline-test correction. It does not include the separate CRM migration PR #7. No schema, account, permission, pricing or outbound behavior changes.

Acceptance requires the full test suite, browser desktop/mobile checks, exact-commit CI, a fresh stopped production backup, existing-row/file/credential comparison, and current-session authenticated reads after deployment. Evidence is kept in the competitor-watch checkpoint and operator release receipts.
