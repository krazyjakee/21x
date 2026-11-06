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
- **Electron keeps whole workspaces on a shared profile.** Electron cannot tell from
  its own data that its folders are shared. Left alone it would remove a workspace by
  two routes, whether or not Tauri was running: a Tauri task it has never heard of
  looks like an orphan once the top-level folder `workspaces/<task>` passes retention,
  and a task Completed in its own record is removed even if it was reopened in Tauri.
  So Tauri leaves a permanent file, `.21x-tauri-shares-workspaces`, in the Electron
  profile, and Electron does not remove whole workspaces while it exists.
  - **Writing it.** Every Tauri launch on a shared profile checks for the file, with
    both locks held, and writes it if it is missing, so profiles imported earlier are
    covered on their next launch. It is a short owner-only note with no paths or
    secrets, written to a temporary file and renamed. Links are not followed, and
    anything already at that name is left alone. An unshared profile writes nothing
    into any Electron folder.
  - **If it cannot be written,** the launch is refused with
    `ELECTRON_MARKER_UNWRITABLE`, before the crash log, the database or any folder is
    touched, because a shared profile must not run unprotected. The way forward is to
    make room on the drive or fix the permissions, then reopen. A folder that is fully
    read-only is refused earlier, by the lock (`PROFILE_LOCK_INVALID`).
  - **Reading it.** Electron checks with `lstat` at the start of each pass and again
    before each removal, including between repositories of one task, so a file that
    appears during a pass stops the rest. Presence alone decides. The content is never
    read, and anything at that name counts, as does any error other than `ENOENT`.
  - **What stops while it exists.** Manual Run cleanup, the scheduled pass, and the
    automatic removal when a task moves to Completed with a live session in Electron.
    No process is stopped for a workspace that stays. Run cleanup says how many
    workspaces it kept and why. A scheduled pass that kept any does not count as the
    day's run, so cleanup returns on the next hourly check once the file is gone.
  - **What keeps working.** Idle `node_modules` pruning still runs, by the shared-folder
    rule above: tasks Electron knows are pruned, and a workspace with no task here is
    left alone, including its `node_modules`. The boot and shutdown process sweeps stop
    leaked processes and remove no files.
  - **What it costs.** Old workspaces pile up in that folder, because nothing removes
    them while the file exists. An explicit delete still works.
  - **Tauri is not affected by its own file.** Only the Electron host passes the check
    (`keepWholeWorkspaces`), and the scheduler refuses a host that combines it with the
    Tauri cleanup policy. On a shared profile Tauri's workspaces sit beside the file,
    and it cleans exactly what it cleaned before.
  - **Older Electron builds do not know the file.** An older build still removes
    workspaces by both routes until it is updated. The file protects nothing there, so
    update Electron before running cleanup on a shared profile.
  - **Nothing removes the file automatically.** It stays when Tauri quits or is
    uninstalled, and after **Stop using the old folder**, because the folder can still
    hold that work. A user who has left Tauri for good gets cleanup back by quitting
    both apps and deleting `.21x-tauri-shares-workspaces` from the Electron profile by
    hand. After that, Electron treats any workspace it does not know as an orphan, so
    move out anything worth keeping first. A later Tauri launch on a shared profile
    writes the file again.
  - **What still removes a workspace.** An explicit task delete in Electron is
    unchanged: it removes that task's worktrees and workspace at once, and removing one
    repository from a task removes that worktree. The user asked for those, and whether
    a shared folder should overrule them has not been decided. Deleting a task in
    Electron also removes its `attachments/<task>` folder, even if Tauri's copy of the
    task still uses it.
  - **Limits that remain.** The Tauri route above is not changed: a task that is
    Completed and past retention in Tauri's copy is still removed by Tauri, even if it
    was reopened in Electron after the import. A profile that lost its share marker
    before it ever ran with the settings row runs unshared, so it writes no file.

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
node node_modules/vitest/vitest.mjs run --project main --maxWorkers=1 src/main/platform/profile-lock.test.ts src/main/platform/electron-profile-claim.test.ts src/main/workspace-cleanup-tauri-marker.test.ts src/service/electron-profile-import.test.ts src/service/production-owner.test.ts
```

The tests exercise real cross-process contention, owner crash/reacquisition,
canonical aliases, duplicate owners after module reload, safe release and invalid
sentinel/database aliases. Cross-platform execution remains necessary to establish
the supported OS contract; mocks do not close that gate.
