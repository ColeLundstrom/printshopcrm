# Contributing to PrintShopCRM

Bug reports, fixes, and features are all welcome. This document is short because the project is
deliberately simple.

**If you run a print shop, you are the most useful contributor here** — even if you never write a
line of code. The hardest thing to get right in this software is how shops actually quote, schedule,
and cost work, and that knowledge doesn't come from reading code. "This is not how pricing works in
embroidery" is a great issue to open.

## Good first contributions

- **Tell us where it's wrong for your shop.** Decoration methods we've modelled badly, a pricing
  rule that doesn't match reality, a workflow that doesn't exist in your building.
- **Supplier integrations.** S&S and SanMar are in; alphabroder, Carhartt, and the regional
  distributors are not. `lib/suppliers.mjs` is the pattern.
- **Decoration methods.** Screen print, embroidery, DTF and UV DTF are modelled. Sublimation, vinyl,
  patches, and laser have partial support at best.
- **Translations.** Nothing is externalised yet — strings are inline. Doing the extraction is a real
  contribution on its own.
- **Anything labelled [`good first issue`](https://github.com/ColeLundstrom/printshopcrm/labels/good%20first%20issue).**

Not sure if an idea fits? Open a
[discussion](https://github.com/ColeLundstrom/printshopcrm/discussions) before writing code. Better
to find out early than to have a PR sit.

## Getting set up

```bash
git clone https://github.com/ColeLundstrom/printshopcrm.git
cd printshopcrm
npm ci
npm run seed      # demo shop, so screens aren't empty
npm run dev       # restarts on change → http://localhost:3333
```

Node 22.13.0 or newer. There is no build step, no bundler, and no transpiler — the browser loads the
same ES modules that are in the repository. If you edit a view and don't see the change, it's the
module cache: hard-reload.

## Tests

```bash
npm test                 # regression and isolated demo tests
npm run test:e2e         # complete workflow checks against throwaway databases
```

Both must pass before anything merges. CI runs on pull requests and pushes to `main`.
Use sample data and an isolated checkout; never test against a shop's working database.

### The one hard rule: a bug fix needs a failing test first

Write the test, watch it fail, then fix the code. Every regression test in `bin/gate.mjs` is a bug
that shipped once — several of them cost real money before they were caught (a quantity of `"24.00"`
importing as `2400`, European `1.200` reading as `1.2`, an estimate quoting one piece instead of a
hundred). A test that never failed doesn't prove anything.

Name the test after the behaviour, not the function:

```js
await t('a stored screen_fee of 0 is honoured, not re-defaulted to 25', async () => { … })
```

Use `test/*.test.mjs` for focused Node tests, including isolated HTTP fixtures. Existing regression
checks live in `bin/gate.mjs`; complete workflow checks live in `bin/gate-e2e.mjs`. Match the
nearest relevant suite. Documentation-only fixes need source and link verification rather than
tests that simply repeat their wording.

## Style

Match the file you're in. Broadly:

- ES modules, `async`/`await`, no semicolon-heavy formatting — read a neighbouring file.
- No new runtime dependencies without a good reason. Keep the dependency list small and reviewed;
  the install uses `npm ci`. Dev-only tooling is a separate conversation.
- Comments explain **why**, not what. The valuable comments in this codebase record a decision or a
  trap — "transitioning the `background` shorthand between CSS vars gets stuck", "invoice status is
  derived, never set". Write those. Skip `// loop over items`.
- SQL is parameterised, always. No string interpolation into a query.

### Things that will get a change sent back

- **Money computed in two places.** `public/js/shared/pricing.js` is imported by both the server (as
  a path) and the browser (as a module URL) so the total a customer sees is computed by the same
  code that writes the invoice. Don't reimplement pricing on one side.
- **Setting invoice status by hand.** It's derived from the payments table via
  `syncInvoiceStatus()`. Delete a payment and the invoice must reopen on its own.
- **Coercing bad input on a write path.** Reject it. A silently-defaulted quantity or price produces
  a correct-looking `201` and a wrong number on a document a customer signs.
- **A query that assumes one shop.** Resolve the authorised shop before using its database handle
  or tenant-scoped `all`/`get`/`run` helpers. Background work and callbacks need the same scope.
- **Timestamps parsed without a `Z`.** They're stored UTC as `YYYY-MM-DD HH:MM:SS`; parsing them
  naively yields negative ages. Use the `parseUtc` / `ageInDays` helpers.

## Pull requests

1. Branch from `main`.
2. Keep it to one concern. A PR that fixes a bug *and* reformats a file is two PRs.
3. Say what broke and how you know it's fixed. A reproduction beats a description.
4. Run both gates.

## Reporting bugs

Open an issue with: what you did, what happened, what you expected, your Node version, and whether
you're in single-shop or multi-tenant mode. A pasted stack trace or the failing request/response is
worth a page of prose.

**Please don't file security issues as public issues** — see [SECURITY.md](SECURITY.md).

## Feature requests

Say what you're trying to do in your shop, not just the feature you have in mind. The useful part of
a request is usually the workflow behind it.

Online stores, a customer product designer, and accounting are substantial future work. Propose
the shop workflow, data model, migration, and failure recovery before implementing a large module.
Current releases do not replace those systems. See [docs/ROADMAP.md](docs/ROADMAP.md).

## License

New contributions use the project's [AGPL-3.0-or-later license](LICENSE). Contributors retain
ownership of their work. We do not request an additional grant for proprietary relicensing.

Submit work you have the right to contribute and identify any third-party code or assets and
their licenses. Do not include customer records, artwork, credentials, or production databases.

The project is supported by optional hosting and basic setup. Every shop receives the same
open-source software; there is no feature tier reserved for paying customers.
