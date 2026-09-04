# An isolated evaluation shop

Use this for a walkthrough or an evaluation with fictional customers. The complete app runs in a
separate directory, with its own registry, database, artwork, and owner account.

```bash
npm ci
npm run demo -- /absolute/path/to/a-new-demo-directory 4380
node /absolute/path/to/a-new-demo-directory/start.mjs
```

Open `http://127.0.0.1:4380/login`. The new directory's `LOGIN.txt` contains a generated password
and the local demo username `dylan@example.test`. That address is an evaluation identifier, not
Dylan's real email. Keep that file and `demo-env.json` private and outside Git.

The creator refuses an existing directory. It never loads the caller's `.env` or opens its
production databases. It copies the installed dependencies, so run `npm ci` first.

The supplied `start.mjs` must be used: it starts the app with a preload that blocks outbound
fetch, HTTP, HTTPS, SMTP, TLS, and socket connections. Inbound browser requests still work.
Email/SMS, payment gateways, supplier APIs, cloud AI, and accounting integrations cannot operate
in this instance. Manual payments are fictional bookkeeping entries. Do not enter real customer
information or credentials. This application safeguard is not an operating-system sandbox.

## Suggested walkthrough

1. Today: see outstanding work and balances.
2. Customers: eight fictional businesses with contact and order history.
3. Estimates: draft, sent, and approved examples. Create another quote using the shop's rates.
4. Invoices: unpaid, partial, paid, and overdue balances, with fictional payment history.
5. Job Board: production work in multiple stages, linked to the quotes and invoices.
6. Art: upload a sample proof, open the customer link, and approve it.
7. Profitability and pricing: inspect how the example jobs and rate settings affect margin.
8. Settings: explore exports, users, and customization.

All sample dates are relative to the day the instance was created. No public URL is created by
this command. A remotely accessible evaluation needs a separately approved deployment, TLS, and
an isolated service/data directory. Review it locally before sharing it.
