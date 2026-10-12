# Cross-host profile ownership

Both the transitional Electron main process and the Node service must acquire
[acquireProfileLock](../../src/main/platform/profile-lock.ts) before opening a
profile database, applying identity migration, or initializing/creating its
credential key. The returned `profileRoot` is the canonical physical path. Every
subsequent profile path must use it; the service checks `assertHeld()` before
operations. Close the application database, dispose retained credential keys,
and stop all owned writers before `release()`.

The existing `better-sqlite3` dependency holds `BEGIN EXCLUSIVE` on a dedicated
permanent `.21x-profile-lock.sqlite` connection in rollback/DELETE mode. SQLite's
[OS-backed locking](https://sqlite.org/lockingv3.html) releases ownership when the
writer process exits or crashes. No stale-PID guesses, lock deletion, heartbeat,
helper process, new native dependency or extra SQLite/PTY ABI rebuild is needed.
The empty sentinel contains no profile data. Acquisition is bounded (default
immediate failure, maximum 1 second), and unavailable/invalid locking fails closed.

Physical directory identity rejects same-process duplicate owners, including
symlink/case aliases and module reloads, before another sentinel connection opens.
Symlink or hard-link sentinels/application databases are rejected. A held guard
checks that its sentinel and directory still identify the original physical files.
Do not read/copy/open/replace/unlink the sentinel through other code: on POSIX,
closing another descriptor for the same file can release process-scoped locks.
Exclude it from backups and identity/profile copies; retain it after release.
Only this module manages its SQLite connection.

Supported profiles reside on local filesystems that correctly implement SQLite
locking (normal NTFS, APFS and local Linux filesystems). Network shares, FUSE/cloud
sync mounts and filesystems without reliable locking are outside the supported
contract. Trusted bootstrap must enforce this profile placement; this module
cannot prove filesystem lock correctness from a mount name. Same-user malicious
filesystem replacement is outside this cooperative ownership mechanism.

Older Electron releases do not know this lock. Shut those releases down before
migration or cutover; an old instance cannot be made cooperative by adding a new
sentinel. A separately copied legacy profile also requires a consistent database
snapshot and stopped/locked source: destination ownership alone does not make
legacy identity copy safe against an unpatched source writer. This lock preserves
original data and performs no credential/profile conversion.

At the central batch boundary run:

```sh
node node_modules/vitest/vitest.mjs run --project main --maxWorkers=1 src/main/platform/profile-lock.test.ts
```

The tests exercise real cross-process contention, owner crash/reacquisition,
canonical aliases, duplicate owners after module reload, safe release and invalid
sentinel/database aliases. Cross-platform execution remains necessary to establish
the supported OS contract; mocks do not close that gate.
