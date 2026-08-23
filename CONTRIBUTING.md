# Contributing to PrintShopCRM

Bug reports, fixes, and features are all welcome. This document is short because the project is
deliberately simple.

## Getting set up

```bash
git clone https://github.com/ColeLundstrom/printshopcrm.git
cd printshopcrm
npm install
npm run seed      # demo shop, so screens aren't empty
npm run dev       # restarts on change → http://localhost:3333
```

Node 22 or newer. There is no build step, no bundler, and no transpiler — the browser loads the
same ES modules that are in the repository. If you edit a view and don't see the change, it's the
module cache: hard-reload.

## Tests

```bash
npm test                 # bin/gate.mjs — 61 unit tests, no network, a few seconds
npm run test:e2e         # bin/gate-e2e.sh — 17 checks against a throwaway database
```

Both must pass before anything merges. CI runs them on every push and pull request.

### The one hard rule: a bug fix needs a failing test first

Write the test, watch it fail, then fix the code. Every regression test in `bin/gate.mjs` is a bug
that shipped once — several of them cost real money before they were caught (a quantity of `"24.00"`
importing as `2400`, European `1.200` reading as `1.2`, an estimate quoting one piece instead of a
hundred). A test that never failed doesn't prove anything.

Name the test after the behaviour, not the function:

```js
await t('a stored screen_fee of 0 is honoured, not re-defaulted to 25', async () => { … })
```

Add unit tests to `bin/gate.mjs` under the closest existing section. Add route-level tests to
`bin/gate-e2e.sh` with `chk "<label>" "$RESPONSE" '<regex>'`.

## Style

Match the file you're in. Broadly:

- ES modules, `async`/`await`, no semicolon-heavy formatting — read a neighbouring file.
- No new runtime dependencies without a good reason. There are four, and that's a feature: the
  install is `npm ci` and nothing else. Dev-only tooling is a separate conversation.
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
- **A query that assumes one shop.** Multi-tenancy works because every request runs inside its
  shop's database via `AsyncLocalStorage`. Use the `all`/`get`/`run` helpers and it's automatic.
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

Some things are deliberately absent: an online store / product designer, and a general ledger.
Those are big surfaces that a shop is generally better served buying elsewhere, and adding them
would compromise how simple this is to run.

## License

PrintShopCRM is licensed under the [Business Source License 1.1](LICENSE). You can run it for your
own shop commercially and free of charge; what the license reserves is offering it to other people
as a hosted service. Each version converts to Apache 2.0 four years after its release.

By opening a pull request you agree that your contribution is licensed under the same terms, and
that the Licensor may also distribute it under the Change License (Apache 2.0) and under commercial
licenses. That last part is what makes it possible to sell hosting exceptions without having to
track down every past contributor — it isn't a copyright assignment, and you keep your own rights
to your work.

If that's a problem for you, say so in the PR and we'll figure something out rather than merging
something you're uncomfortable with.
