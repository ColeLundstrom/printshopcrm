# Self-host release rehearsal

Run `node --test test/self-host-release-rehearsal.test.mjs` after `npm ci`, or include it with
`npm run test:all`. It uses only disposable directories under the system temporary directory and
loopback HTTP. The E2E fixture blocks outbound application connections and refuses any database
path outside its new synthetic data directory. It does not open or alter an existing shop.

The rehearsal creates two temporary release directories from the candidate checkout, with a
shared persistent data directory and an artwork link in each release. It starts the first release,
signs up a fictional owner, and creates a fictional contact. It snapshots the control and tenant
databases, copies fictional artwork, switches to the second release, and verifies that the contact
and artwork remain available. It then changes both, stops the server, switches the code pointer
back, previews and applies the restore, and checks strict health, staff login, unauthenticated API
rejection, the original contact, and the original artwork.

Both temporary releases contain **the same candidate commit**. This checks the storage layout,
snapshot and rollback chain on Linux, macOS and Windows. It does not prove migration compatibility
with an older version, Linux systemd/nginx deployment, registry publication, provider behavior,
off-machine backup, or recovery of an operator's own records. Follow [RELEASING.md](../RELEASING.md)
and [INSTALL.md](../INSTALL.md#backups) for those release and backup steps. Keep a separate,
verified copy of real shop data before an actual update.
