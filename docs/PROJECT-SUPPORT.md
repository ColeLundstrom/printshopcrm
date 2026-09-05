# Voluntary project support

PrintShopCRM is free to run yourself. Optional contributions help fund maintenance, testing,
documentation and outside help. Giving does not change features, seats, data access or community
participation. [Managed hosting](../HOSTING.md) is a separate service: operating the installation
and handling basic setup. A contribution does not buy hosting, custom development, a response-time
commitment or priority over other shops.

The **Support the project** page provides outbound support and contribution links. There are no
popups, payment forms, donation reminders or automatic charges in the CRM. The payment provider
shows the amount and terms before the supporter chooses to pay. Code, bug reports, documentation,
testing and practical workflow feedback are welcome without a financial contribution.

## Operator setup

**Before configuring a link, open it and verify the intended recipient, amount, billing frequency,
published/test status and cancellation route.** The app checks allowed URL shapes only. It does
not verify an account, visit checkout links, detect successful contributions or confirm the
recipient. Do not present a configured URL as independently verified by PrintShopCRM.

All links default to blank. No working public GitHub Sponsors checkout for `ColeLundstrom` was
verified during the September 4, 2026 implementation: its Sponsors URL redirected to the ordinary
profile. Do not fill that setting until the intended public page is actually available. This
feature does not create an account, payment link or sponsorship profile.

Configure these optional variables in the **server environment**, then restart through the normal
deployment procedure. They apply to the installation, not individual shops. They are public
destinations, not API keys; do not put processor credentials in them. There is no in-app write API
or per-shop override.

| Variable | Allowed URL |
| --- | --- |
| `PSC_PROJECT_SUPPORT_ONCE_URL` | `https://buy.stripe.com/<token>` |
| `PSC_PROJECT_SUPPORT_MONTHLY_URL` | `https://buy.stripe.com/<token>` |
| `PSC_PROJECT_SUPPORT_MANAGE_URL` | `https://billing.stripe.com/p/login/<token>` |
| `PSC_PROJECT_SUPPORT_GITHUB_URL` | `https://github.com/sponsors/<username>` |

Use exact lowercase scheme/host/path prefixes. Stripe tokens contain 1–200 ASCII letters, digits
or underscores. GitHub usernames contain 1–39 letters/digits/single hyphens and cannot start or
end with a hyphen. Queries, fragments, extra paths, trailing slashes, encoded characters,
whitespace, credentials, ports and URLs longer than 2048 characters are rejected. Bracketed
placeholders in this table are descriptions, not usable checkout URLs. Custom domains and other
payment platforms are not supported by this first allowlist.

Invalid or absent settings become null and produce no payment button; they do not interrupt the
CRM. A monthly Stripe option requires a valid manage/cancel portal URL. A management link alone
does not enable contributions. No raw URL or environment value is logged by the config module.
The operator must check that the monthly checkout and management portal belong to the intended
account and let that supporter cancel; matching URL shapes cannot establish that relationship.

[Stripe Payment Links](https://docs.stripe.com/payment-links/create) support a one-time
customer-chosen amount. Recurring Payment Links require a fixed recurring price; they do not
provide a recurring choose-your-own-amount option. Set up the
[no-code customer portal](https://docs.stripe.com/customer-management/activate-no-code-customer-portal)
for monthly cancellation. [GitHub Sponsors](https://docs.github.com/en/sponsors/receiving-sponsorships-through-github-sponsors/managing-your-sponsorship-tiers)
supports one-time, monthly and custom sponsorship amounts after the profile is published.

Use accurate project-support wording. This feature does not establish charitable status or issue
tax-deductible donation receipts. Review the provider's requirements for the intended activity,
including [Stripe's distinction between tips for provided goods/services and charitable donations](https://support.stripe.com/questions/requirements-for-accepting-tips-or-donations?locale=en-GB).

## Public configuration API

`GET /api/project-support` returns the following object under the installation's normal access
rules. It is a read only response with no database writes or outgoing provider calls:

```json
{
  "version": 1,
  "enabled": false,
  "one_time_url": null,
  "monthly_url": null,
  "manage_url": null,
  "github_url": null,
  "community_url": "https://github.com/ColeLundstrom/printshopcrm/discussions",
  "source_url": "https://github.com/ColeLundstrom/printshopcrm"
}
```

`enabled` means at least one one-time, monthly or GitHub link passed local shape validation.
It is not a payment status or a reachability/account verification result. The source and
community URLs identify the upstream project; they do not replace a modified installation's
separate corresponding-source link. Returned fields contain no shop identity, keys, payment
history or subscription state. Frontends should show only configured options and open them with
`rel="noopener noreferrer"`, without adding tenant IDs or customer emails.

## Hosting and payment separation

Project support must never use a shop's invoice-payment keys, add customer invoice records or
grant/revoke hosting. A failed or cancelled support payment must leave hosting unchanged. When
support shares the platform Stripe account, its events must be excluded from hosting updates by
the exact hosting subscription/customer binding; a customer match alone is insufficient. Keep
support and hosting products/purposes distinct. Use separate support infrastructure until that
event isolation is configured and verified. The link configuration module itself does not handle
Stripe events, change hosting state or implement a contribution ledger.

No payment SDK or provider account is needed to run the page or the application. Links are not
fetched at startup or while reading configuration. Server storage/hosting fees and the separate
future artwork-compute work are unaffected by voluntary project support.
