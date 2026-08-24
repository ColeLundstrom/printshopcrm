# Getting help

| What you need | Where |
|---|---|
| Something is broken | [Open an issue](https://github.com/ColeLundstrom/printshopcrm/issues/new/choose) |
| "This isn't how shops work" | [Same place](https://github.com/ColeLundstrom/printshopcrm/issues/new/choose) — there's a template, and it needs no code |
| A question, or "would you accept a PR for…" | [Discussions](https://github.com/ColeLundstrom/printshopcrm/discussions) |
| Installing it | [INSTALL.md](../INSTALL.md), then [DEPLOY.md](../deploy/DEPLOY.md) |
| A security problem | [Privately](https://github.com/ColeLundstrom/printshopcrm/security/advisories/new) — never a public issue |
| Someone to run it for you | [HOSTING.md](../HOSTING.md) |

How long you should wait, and what happens next: [GOVERNANCE.md](../GOVERNANCE.md).

**Locked out of your own install?** Password reset goes by email and a fresh install has none
configured. Recover it from the server:

```bash
npm run admin -- reset-password you@yourshop.com
```
