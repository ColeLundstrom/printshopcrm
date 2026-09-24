# v1.35.4 — Customer tag combinations and exclusions

Customers can now be filtered by all selected tags or any selected tag, with explicit tag exclusions. For example, choose school or repeat and exclude net-30. Search works together with these filters; Clear tags restores the full tag scope. Results announce their count, selected tags retain keyboard focus, and delayed responses cannot overwrite a newer filter or another shop's screen.

Tag matching is literal: percent signs and underscores in a tag no longer act as SQL wildcards. Existing single-tag queries remain supported; repeated `tag` parameters provide inclusion, `tag_mode=all|any` selects the combination, and repeated `exclude_tag` parameters remove matches. Each group is bounded to 20 tags. Matching retains SQLite's existing ASCII case-insensitive behavior.

This is read-only filtering with no schema, dependency, account, credential or pricing changes. It does not add a shared/saved filter registry or product-catalog import. Product catalog CSV requires a separate tenant-owned storage and quoting design; CRM migration PR7 remains separate.

Acceptance covers literal matching, combined search/includes/exclusions, empty/unknown tags, malformed inputs, existing staff access and anonymous denial, tenant isolation, unchanged records, stale response behavior, browser all/any/exclude/reset workflows, full regression and E2E, exact-commit CI, copied-data rehearsal, and fresh stopped backup/session preservation before deployment.
