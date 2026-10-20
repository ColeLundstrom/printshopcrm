# Time zone

Due dates, overdue invoices, net payment terms, ship dates, "due today" on the Today screen and the
capacity calendar all depend on what date it is **for the shop**. That date comes from one place:
the shop's time zone.

## Where it is set

- **Settings → Shop → Time zone.** An IANA zone name such as `America/Los_Angeles`,
  `America/Chicago` or `Europe/London`. The first time an owner or manager opens the app, a shop
  that has never chosen one is set to the browser's zone automatically; change it here at any time.
- **API:** `PUT /api/settings` with `{"timezone": "America/Denver"}`. A name the server cannot use
  is refused with `400` and `code: "timezone_invalid"`; the stored value is the canonical spelling.
  An empty string clears it.

## When it is blank

A shop with no time zone uses the server's: `PSC_TIMEZONE` from `.env` if set, otherwise the
process zone (`TZ`, or the operating system's). Docker images and most VPS installs run in UTC, so
without a shop setting "today" rolls over at 5pm in California — an invoice due today reads overdue
that evening and a job shipped at 6pm is stamped tomorrow. Set the shop's zone (or `PSC_TIMEZONE`)
on any server that is not in the shop's own zone.

## What it does not change

Stored timestamps (`created_at`, `sent_at`, payment times) stay in UTC. Only calendar dates — the
`YYYY-MM-DD` values a person types or reads as a day — are decided by the shop's zone.
