# Check a self-hosted install

PrintShopCRM runs on your own computer or server without a subscription. The optional doctor
checks common installation problems before starting the app, and can be run again on an existing
install without opening or migrating its databases.

From the PrintShopCRM directory:

```bash
node bin/doctor.mjs
```

No npm packages are needed to run the doctor itself. On a fresh checkout, a missing-dependencies
failure is expected. Install the app dependencies and check again:

```bash
npm ci
npm run doctor
```

Use `node bin/doctor.mjs --help` for a short explanation. Node.js **22.13.0 or newer** is required
by the app. On an older Node runtime that can launch the script, the version check reports a
blocking issue before attempting to load SQLite.

## What the result means

- **PASS**: that specific check succeeded under the current account and configuration.
- **WARN**: something needs review. Local evaluation can reasonably have warnings, such as no
  login or a local HTTP address. Warnings do not fail the command.
- **FAIL**: a basic requirement is missing or could not be verified. Fix the issue and run again.

The exit status is **0 when there are no FAIL results**, even if warnings remain, and **1 when
there is a blocking issue**. A passing result is not approval to expose the app to the internet.
Backup reminders remain warnings because the doctor cannot establish that a backup is scheduled,
kept off the machine, or recoverable.

## Run it in the app's environment

The doctor reads `.env` from the **working directory**, using Node's built-in environment parser.
Existing process variables override values in that file, matching `npm start`. It never sources
`.env` as a shell script, changes the current environment, or prints configuration values.

Relative `PSC_DB` and `PSC_CONTROL_DB` paths resolve against that working directory. The default
database is `data/printshop.db` in this checkout; customer artwork is always in this checkout's
`public/uploads`, which may be a symbolic link. A missing or unreadable `.env` is not silently
substituted with defaults: an absent file uses defaults, while an unreadable file blocks further
configuration and storage checks.

Run as the account that runs the app. For the Linux service layout in [INSTALL.md](../INSTALL.md):

```bash
cd /opt/printshopcrm/current
sudo -u printshopcrm node bin/doctor.mjs
```

If you use a container, run the doctor **inside the container with the same mounts and settings**.
Running it on the host checks the host's Node, packages and permissions instead. A service manager
may inject additional variables or restrict filesystem access; a shell check does not reproduce
those restrictions automatically. Root can also pass permission checks that the service account
would fail.

`NODE_OPTIONS` read from `.env` is reported but not applied to the running doctor process. In
particular, the doctor does not execute preloads specified in configuration. Review the real
service's launch flags if its SQLite support differs from the check.

## What it checks

- Stable Node.js version >=22.13.0.
- Resolution of every declared runtime package, without importing package code.
- Built-in `node:sqlite` using a query against `:memory:`, then closing it.
- Whether `.env` can be read, plus a Unix permission warning for group/other access.
- Whether authentication and a non-default share-link secret are configured. The same missing
  secret that prevents `PSC_AUTH=1` from starting is a FAIL. The doctor does not judge secret
  strength or generate credentials.
- Cautions about all-interface binding, missing public origin, local/HTTP public origins, and
  public URLs with credentials, paths, queries or fragments. These do not contact the URL.
- Writable database, tenant and artwork directories; type and read/write access checks on the
  configured database, registry and their existing WAL/SHM files.
- Common persistence and backup-layout mismatches, including artwork outside the backup layout,
  a registry outside the backup root, and a database name without the `.db` suffix used by the
  supplied backup scripts.

Directory checks create a uniquely named `.psc-doctor-*` temporary directory and one small file,
then remove both. If the intended directory does not exist, the doctor probes its nearest
existing parent **without creating the intended directory**. This establishes that the parent is
writable; it does not prove a missing external volume is mounted. A separately configured registry
parent must already exist because application startup does not create that parent.

A failed write still triggers cleanup. If cleanup fails, the result is a FAIL and explicitly says
that a temporary probe remains. An interrupted/killed process can also leave a probe; it contains
only a fixed test message, never shop records or credentials. No existing files are recursively
deleted. Normal temporary creation/removal changes directory timestamps.

## Fixing common failures

- **Node or SQLite**: use an official Node.js build >=22.13.0 with SQLite enabled, reopen the
  terminal, and check `node --version`. Look for SQLite-disabling flags in the launch environment.
- **Missing packages**: run `npm ci` from the checkout. The doctor does not install anything.
- **Unreadable `.env`**: verify the working directory and service account. For the production
  instructions, `.env` should be owned by that account with mode `600`.
- **Storage**: check the configured path, volume mount and ownership. The app account needs to
  write both the database file and its containing directory for SQLite's journal files. If a
  path contains a regular file where a directory belongs, correct the path. Do not use `seed`
  or `reset` as repair tools for a working shop.
- **A fresh local setup copied the production example**: `.env.example` points `PSC_DB` at
  `/var/lib/printshopcrm/printshop.db`. For a brand-new local shop, use
  `PSC_DB=./data/printshop.db` in `.env` instead if you want the checkout's local storage. For an
  existing shop, restore access to its original data path; choosing an empty path is not recovery.
- **Missing secret with login enabled**: follow the random-secret instructions in
  [INSTALL.md](../INSTALL.md#5-configure). Keep the value private.

For local evaluation, use a loopback listener (`PSC_HOST=127.0.0.1`) if only your computer should
reach the app. Before exposing it, follow the full [production install](../INSTALL.md#production-install)
for authentication, HTTPS, proxy configuration and firewall rules. Turning on `PSC_AUTH=1`
selects per-shop tenant storage; it does not automatically move existing single-shop records.
Back up an existing install before changing its storage or authentication mode.

## Backups: check the paths, then test a restore

The app writes artwork to `public/uploads`. The Linux `deploy/backup.sh` script archives artwork
from **`DATA_ROOT/uploads`** and searches below `DATA_ROOT` for `.db` files. Those locations must
refer to the same artwork directory for that script to cover uploads. The persistent-directory
and symlink setup in [INSTALL.md](../INSTALL.md#4-put-your-data-outside-the-app-directory) covers
this. Keep existing artwork when changing the layout; do not blindly remove a populated directory.

`backup.sh` defaults to `/var/lib/printshopcrm`, which is not a local checkout's `data/` directory.
Set `DATA_ROOT` explicitly when running it. It does not read `DATA_ROOT` from `.env`. The doctor's
layout comparison uses an exported `DATA_ROOT` when supplied, otherwise the directory containing
`PSC_DB`, with a warning to configure the actual backup command. A layout PASS is not evidence
that cron uses the same settings or that an archive exists.

`npm run snapshot -- <data-root> <new-output-directory>` makes SQLite-aware **database** snapshots;
it defaults to `/data` if no data root is supplied and **does not copy artwork**. Choose a new
output directory: the snapshot tool replaces its output directory. Doctor never invokes it.
Keep all required databases, including `control.db` and per-shop tenant databases, together with
an artwork backup and the private configuration needed to recover the install. A custom
`PSC_CONTROL_DB` outside the data root needs explicit coverage.

Follow the [backup and restore instructions](../INSTALL.md#backups), keep a copy off the machine,
and test a restore to a separate location. Do not copy a live SQLite database as your backup.
If `DATA_ROOT/uploads` links to another persistent volume, `bin/restore.mjs` preserves that link
and restores artwork into its resolved target. It keeps the previous target files in a
`.psc-restore-art-*` directory beside the target; retain that safety copy until the restored
shop's proofs and mockups have been checked. A broken uploads link stops the restore before any
database is replaced, so repair the target or deliberately use `--skip-art`.

## Deliberate limits

The doctor does not start the server, bind a port, contact providers, test credentials, make a
backup, inspect customer records, open an on-disk database, run migrations, or seed data. It does
not verify database integrity, all existing tenant-file permissions, remaining disk capacity,
backup retention, filesystem durability, DNS, TLS, proxy/firewall correctness, or service health.
Symbolic links and unusual backup layouts still require manual review. Treat it as a quick
installation preflight alongside the installation guide, not a security audit or recovery tool.

Developer regression checks:

```bash
node --test test/doctor.test.mjs
```

A custom PSC_DB or PSC_CONTROL_DB name without the .db suffix is flagged: the supplied backup walkers select .db files. Do not rename a live database or registry to resolve a warning; plan an explicit SQLite-aware backup or a documented offline migration.
