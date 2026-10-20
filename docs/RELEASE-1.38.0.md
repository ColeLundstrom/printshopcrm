# 1.38.0 — Task-first redesign, team stores, reports

Base: published v1.37.0 (`8d8b491`). No new runtime dependency, no licence change, no migration of
existing data: two new tables (`merch_stores`, `store_orders`) are created per shop on first use.

## The redesign

The app was organised as a map of every feature — 39 sidebar destinations with overlapping names —
and the three things shops come in to do were buried: mockups only from inside a job's art card,
estimates as a blank spreadsheet with the price typed by hand, automatic follow-ups behind "More
tools" and a rule builder. Now:

- **Home asks "What do you want to do?"** with big tiles, and a **＋ New** button in the top bar
  opens the same list on every screen.
- **Guided screens**, one question at a time:
  - **Make an estimate** (`#/do/estimate`): customer → item, sizes, decoration and print spots,
    priced live by the shop's own price book (`POST /api/quick-price`); paste the customer's email
    to fill it in → create and send.
  - **Make a mockup** (`#/do/mockup`): pick an open order or start one, then the composer.
  - **Automatic follow-ups** (`#/auto-follow-ups`): one switch per situation (quote not answered,
    proof not approved, invoice past due, thank-you, welcome, win-back) with the days and the email
    editable and a preview of what the customer reads.
  - **Bill a customer** (`#/do/invoice`) and **Start a job** (`#/do/job`).
- **Sidebar** shows seven everyday screens; everything else is under **All tools**. No route was
  removed.

## New

- **Team stores** (`#/stores`): a shareable order page for a team, school or company. Members pick
  item, size and quantity; the shop turns the orders into one estimate with per-size totals. No
  online payment in this version.
- **Reports** (`#/reports`, managers): invoiced, collected, sales tax, open A/R, win rate; sales by
  month, customer and decoration; A/R aging; CSV download of each.
