# How this project is run

Public rules, so you know what happens to your contribution before you spend an evening on it.

## Who decides

PrintShopCRM is maintained by **[@ColeLundstrom](https://github.com/ColeLundstrom)**, who runs a
print shop and built this to run it. One maintainer, stated plainly rather than implied by a vague
"the team" — you should know whose judgement you're dealing with.

That has an obvious failure mode: a busy week means slow reviews. The commitments below exist to
bound that, and if they slip you're entitled to say so in the thread.

## What happens to your contribution

### Response times

| | |
|---|---|
| **First response to an issue** | within 5 working days |
| **First response to a PR** | within 7 working days |
| **Security report** | within 3 working days, ahead of everything else |

"First response" means a human reads it and tells you where it stands — accepted, needs changes,
needs discussion, or declined with a reason. It doesn't mean merged. Silence past these windows is
a failure on our side; `@`-mention the maintainer and it isn't rude.

### The states a PR can be in

- **Merged.** It does what it says, it has a test, and it fits how the project works.
- **Changes requested.** Specific and actionable. If the request is vague, ask — an unclear review
  is the reviewer's problem to fix, not yours to guess at.
- **Discussion needed.** Usually design, not code: the change is reasonable but there's a better
  seam for it, or it interacts with something you couldn't have known about. Expect a
  counter-proposal, not a "no".
- **Declined.** With a reason, in the thread. See what gets declined below.

### Stale PRs

Nothing is auto-closed by a bot. If a PR goes quiet, it stays open. If the maintainer went quiet,
that's on the maintainer.

## What gets merged

**Bug fixes with a failing test.** The strongest possible contribution. Write the test, watch it
fail, then fix it. Every regression test in `bin/gate.mjs` is a bug that shipped once, several of
which cost real money — a quantity of `"24.00"` importing as `2400`, European `1.200` reading as
`1.2`, a quote pricing one piece instead of a hundred.

**"This isn't how shops work."** The most valuable input here, and it needs no code. The hard part
of this software isn't the code, it's modelling how shops actually quote, schedule and cost work —
and that knowledge lives in print shops. There's an issue template for exactly this.

**Supplier integrations and decoration methods.** S&S and SanMar are in; the regional distributors
aren't. Screen print, embroidery, DTF and UV DTF are modelled; sublimation, vinyl, patches and laser
are thin.

**Documentation that fixes something that misled you.** If a doc cost you an hour, the fix is worth
merging.

## What gets declined

Said upfront so you don't build it first:

- **A new runtime dependency without a strong reason.** There are four. That's a feature: the
  install is `npm ci` and nothing else, and a shop owner can run it without a build toolchain.
- **A build step.** No bundler, no transpiler. The browser loads the same files that are in the
  repo. This is load-bearing for how easy the thing is to run and audit.
- **Money computed in a second place.** `public/js/shared/pricing.js` is imported by both the server
  and the browser so the total in the editor is produced by the same code that writes the invoice.
- **Coercing bad input on a write path.** Reject it. A silently-defaulted quantity or price produces
  a clean `201` and a wrong number on a document a customer signs.
- **A query that assumes one shop.** Multi-tenancy works because every request runs inside its
  shop's database; use the `all`/`get`/`run` helpers and it's automatic.
- **An unreviewed expansion of a major workflow.** Stores, design tools, and accounting need an
  agreed scope, data model, migration plan, and recovery tests before implementation.
- **Large refactors that arrive as a surprise.** Not because they're unwelcome — because reviewing
  4,000 changed lines against a codebase you didn't write is how mistakes get merged. Open a
  discussion first and it can probably happen in reviewable pieces.

## How review actually works

Every PR gets CI automatically: unit and end-to-end tests on Node 22 and current LTS on Ubuntu,
plus Windows and macOS coverage, a Docker build that boots the container, and a credential scan.
**CI must be green before a human review starts** — that isn't gatekeeping, it's so review time goes
on judgement rather than on things a machine can catch.

Then the maintainer checks, in this order:

1. **Is the problem real?** A reproduction, a failing test, or a shop owner describing it.
2. **Does the fix hold under a bad case?** Empty state, a shop with no data, a hostile input, a
   second shop's data nearby.
3. **Does money still only get computed once?** See the declined list.
4. **Is there a test that fails without this change?**
5. **Does it read like the code around it?** Match the file you're in.

## Releases

Reviewed changes on `main` are candidates for the next release. Stable container images publish
only from version tags after the full CI workflow succeeds for that tag. There's no private branch and no
held-back "enterprise" version — the hosted product runs the same code, and you can
[verify that](RELEASING.md) with `deploy/verify-sync.sh`.

Release process and the rule that GitHub, the app server and the website move together is in
[RELEASING.md](RELEASING.md).

## Community funding and licensing

The project is supported by voluntary contributions and optional server hosting and basic setup.
Contributions help fund maintenance, documentation, release testing and outside contributors.
One-time support and recurring sponsorship are optional; they do not buy feature access,
merge priority or a support contract. Funding does not override review and release safeguards.
See [project support](docs/PROJECT-SUPPORT.md) for setup and payment boundaries. Every shop gets the same
software. New contributions are AGPL-3.0-or-later, with no additional proprietary relicensing
grant. Contributors keep ownership. See [CONTRIBUTING.md](CONTRIBUTING.md).

## If you have a problem with how this is run

Say so in the issue or discussion. If it's about the maintainer's conduct specifically, raise it
publicly — a project where that can't be said out loud isn't worth contributing to. See
[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## If this project goes quiet

It could. One maintainer, a real shop to run. What protects you:

- **AGPL grants are irrevocable.** Every version ever published stays free, forever, whatever
  happens to the company or the maintainer.
- **Your data is a single SQLite file**, every table exports as one JSON file, and the records a
  shop reconciles against — customers, quotes, invoices, payments, jobs, artwork, the timeline and
  every line item — each export to CSV.
- **Fork it.** That's not a threat to us, it's the point of the licence.
