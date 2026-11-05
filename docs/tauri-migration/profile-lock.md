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

## Electron and Tauri on one profile

An imported Tauri profile has its own database but keeps using the Electron
profile's `workspaces/`, `repos/` and `attachments/` in place, so the two apps
must never run together on them. Both therefore take the same lock on the Electron
profile for their whole session. Whoever gets it first runs; the other is refused.

- **Electron** claims `userData` at module load, before the crash logger and before
  `ready` ([electron-profile-claim.ts](../../src/main/platform/electron-profile-claim.ts)).
  A refused launch starts no crash log and moves `userData` and `sessionData` to a
  scratch folder, so Chromium stays out of the profile. It tries the system temp
  folder, then the app data folder, never one inside the profile. It then shows the
  message once `ready` allows a dialog, discards the scratch folder and exits with
  status 1. If no folder works, it exits before `ready` instead, because Chromium
  must not start on the profile. On Linux that message goes to stderr, since there
  is no dialog before `ready`, so a launch from the desktop shows nothing at all.
- **Tauri** receives `legacyProfileRoot` on every launch that has one, not only the
  import, and takes the lock straight after its own, in the `profile-lock` stage.
  `release()` of the joint lease frees both. A refusal is
  `ELECTRON_PROFILE_IN_USE`, shown in the app window.
- **Which app holds it.** `.21x-tauri-holder` exists only while a Tauri session runs
  on the Electron profile. It is read only after a real `PROFILE_IN_USE`, to word
  the message. It never decides ownership, so a copy left by a crash cannot block
  anything, and Electron removes it on its next start. It is not the sentinel,
  which other code must not open. Electron itself writes no such file.
- **Simultaneous starts** use a 250 ms lock wait. With no wait, two starts that
  collide can both get `SQLITE_BUSY` and both be refused; neither outcome lets two
  win, but the wait gives one winner.
- **Copies are not refused.** The lock belongs to a directory and a running process,
  not to the bytes, so a copied profile, even one copied with its sentinel and note,
  has no owner. A Tauri profile with neither a usable `.legacy-profile-root` nor the
  settings row below shares nothing and runs beside Electron. A copied Tauri profile
  carries its share with it: on the same machine it is locked like the original,
  and where the folder is not there it gets the missing-folder refusal below.
- **A shared profile stays shared when the Electron database goes.** Once a Tauri
  profile has its own database, the marker alone decides, because the workspaces,
  repositories and attachments of its tasks live in those folders. A new profile is
  shared only if there is an Electron database to import; a marker left by an
  interrupted first launch is removed if there is not, so a fresh profile does not
  look shared.
- **A stale marker from an earlier build reads as shared.** Such a build could leave a
  marker on a profile that then made its own database, and the two cannot be told
  apart. On that profile `workspaces/`, `attachments/` and `repos/` switch to the
  Electron folder, its own folders stop being used, and Electron is locked out while
  it runs.
- **Cleanup leaves unknown workspaces alone.** That is why, while a profile is shared,
  neither manual Run cleanup nor a scheduled pass touches a workspace with no matching
  task, not even its `node_modules`. It may be the other app's work, and removal
  cannot be undone. This also protects tasks created in Electron after the import,
  which the Tauri database cannot see. It does not protect a task both databases
  know. The import copies tasks with their IDs, and after that the two copies change
  separately. So if a task is Completed and past retention in Tauri's copy, Tauri
  still removes its workspace, even if the task was reopened in Electron after the
  import.
- **A lost marker comes back.** The share is also held in a settings row,
  `__electron_shared_root`, written in the import copy and added on the next launch
  to profiles imported before it existed. The native host cannot read SQLite, so if
  the marker has gone it sends no folder, and the service finds the row, puts the
  marker back and refuses with `ELECTRON_LINK_RESTORED`. The next launch is locked. A
  profile that lost its marker before it ever ran with this record cannot be told
  from an unshared one, and still runs unlocked.
- **A missing folder is refused, not recreated.** If the marker names a path that
  does not resolve to a directory, the host uses the profile's own folders and still
  sends that path, and the service refuses with `ELECTRON_FOLDER_MISSING` before taking
  the lock, because the lock would recreate the folder. A link that resolves counts as
  present: a folder moved elsewhere and linked back has not gone, and both apps lock
  the real path, so they still meet on the same file. A first import still needs a
  real folder. The same refusal covers a marker
  the host cannot use, such as a path from another system, which it recognises
  because the marker already equals the row. So a copied profile gets the same way
  forward.
- **Two ways forward from that refusal:** put the folder back and reopen, or choose
  **Stop using the old folder** on the failure screen, which asks once more first.
  Neither refusal offers Try again, because the service starts once per launch and a
  page reload cannot change the result. The service has already stopped, so the
  action is a native command, `stop_using_old_folder`, which takes no arguments, runs
  only after this refusal, and does nothing if the folder has come back. It writes
  `detached` to a temporary file and renames it over the marker, so a failed write
  leaves the marker as it was. On the next launch the host reads that as no share, and
  the service deletes the row and runs on the profile's own folders. Every task stays,
  but its workspace, repositories and attachments start empty, because they are worked
  out from the current folders. The two apps no longer exclude each other, and the
  folder is not taken back if it reappears.
- **Still open, Electron's own cleanup:** Electron cannot tell that the folders are
  shared. Its Run cleanup needs no setting, a scheduled pass needs auto-cleanup on,
  and Tauri does not have to be running. Either can remove a workspace by two routes:
  - **A task Electron does not know.** A workspace of a Tauri-created task looks like
    an orphan to Electron, and it is removed once its age passes the retention period.
    That age comes from the modification time of the top-level task folder,
    `workspaces/<task>`, only. Worktrees sit one level down, at
    `workspaces/<task>/<repo>`, so editing files inside a repository does not change
    it. An older Tauri task can be selected while it is still being worked on,
    whatever its status in Tauri.
  - **A task both databases know.** A task that is Completed and past retention in
    Electron's copy has its workspace removed, even if it was reopened in Tauri after
    the import and is being worked on in that same folder. This route uses Electron's
    own task record, not the folder's age.

  Uncommitted work in a removed workspace cannot be recovered. Commits on the task
  branch stay in the shared repository. How to close this is an open user decision.

A refused launch writes nothing to the profile, with one limit on Linux: the native
Tauri host creates missing `workspaces/` and `attachments/` before the service runs,
because its file owners open those roots at launch. So a first Tauri launch against
an Electron profile that never made those folders can leave them empty. No file is
written, Electron creates the same folders on demand, and later launches find them
in place. Closing this needs those owners to open their roots lazily.

Older Electron releases do not know this lock. Shut those releases down before
migration or cutover; an old instance cannot be made cooperative by adding a new
sentinel. A separately copied legacy profile also requires a consistent database
snapshot and stopped/locked source: destination ownership alone does not make
legacy identity copy safe against an unpatched source writer. This lock preserves
original data and performs no credential/profile conversion.

At the central batch boundary run:

```sh
node node_modules/vitest/vitest.mjs run --project main --maxWorkers=1 src/main/platform/profile-lock.test.ts src/main/platform/electron-profile-claim.test.ts src/service/electron-profile-import.test.ts src/service/production-owner.test.ts
```

The tests exercise real cross-process contention, owner crash/reacquisition,
canonical aliases, duplicate owners after module reload, safe release and invalid
sentinel/database aliases. Cross-platform execution remains necessary to establish
the supported OS contract; mocks do not close that gate.
