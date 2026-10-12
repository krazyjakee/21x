# Native credential candidate and real legacy proof

The T03 synthetic candidate proof tracked in #201 has passed real OS-store
fixtures on Linux x64, macOS x64/arm64 and Windows x64. The
[retained evidence](credential-proof-evidence.json) links each exact report to its
source commit, workflow run and tool versions. This closes that issue's candidate
proof scope; #193 retains the installed-profile and live-cutover gates. Shipping
Electron storage remains compatible, and no live profile is converted.

## Candidate provider

[AuthenticatedSecretStorage](../../src/main/platform/authenticated-secret-storage.ts)
uses Node/OpenSSL AES-256-GCM with a random 32-byte application key, a fresh
12-byte nonce per encryption, and an explicitly fixed 16-byte authentication tag.
The experimental `21x.aes256gcm.v1` format is a binary magic/version header,
nonce, tag, and ciphertext. The magic/version and profile identity are additional
authenticated data. Decryption returns no plaintext until authentication succeeds,
rejects malformed UTF-8, and preserves a BOM. Encryption rejects lossy unpaired
surrogates and values over 1 MiB. See the
[official Node crypto APIs](https://nodejs.org/docs/latest-v22.x/api/crypto.html).

The application key is loaded once during asynchronous trusted bootstrap through
[NativeApplicationKeyStore](../../src/main/platform/native-application-key-store.ts).
Subsequent serialization is synchronous within the service process and makes no
native RPC. Disposal clears the retained key buffer and throws a fixed unavailable
error, including from `isEncryptionAvailable()`. Returning false there would let
legacy serializers silently select their historical plaintext fallback.
JavaScript strings and OpenSSL/provider-internal copies cannot be fully wiped.

The GTK-independent [native helper](../../src-tauri/credentials/src/lib.rs)
stores binary keys using explicit concrete `keyring` 3.6.3 backends:

| OS | Candidate key store | Legacy Electron source |
| --- | --- | --- |
| Linux | Secret Service over encrypted D-Bus sessions (`sync-secret-service`, `crypto-rust`) | `gnome-libsecret`, plus separately classified `basic_text` legacy evidence |
| macOS | User Keychain generic credential | Electron Keychain-backed `safeStorage` |
| Windows | Windows generic Credential Store | Electron DPAPI-backed `safeStorage` |

Electron's Linux API reports `gnome_libsecret`; its command-line selector is
`--password-store=gnome-libsecret`. The probe checks the actual reported backend.

The helper uses no default/mock store, keyutils-only store, or plaintext fallback.
The fixed service is `com.krazyjakee.21x.credentials.v1`; the account identifies
the profile. Native create refuses an existing entry and never treats locked or
unreadable storage as permission to replace it. Generic credential APIs do not
provide an atomic compare-and-create operation: **trusted bootstrap must hold the
cross-host profile lock before key creation**. The probe uses unique
`t03-` accounts and never touches production profile keys. Only fixture accounts
may be deleted through the helper protocol.

See [keyring's documented store features](https://docs.rs/keyring/3.6.3/keyring/)
and [binary-secret entry methods](https://docs.rs/keyring/3.6.3/keyring/struct.Entry.html).
These are OS-account protection mechanisms, not a sandbox against every process
already running with the user's credentials. Electron's documented
[platform semantics and `basic_text` distinction](https://www.electronjs.org/docs/latest/api/safe-storage)
remain relevant to the source side.

## Private bootstrap and conversion proof

The key helper is selected by trusted host code using an absolute packaged path.
It receives one bounded request through private stdin and returns one bounded
response through the parent's private stdout pipe. No shell is involved.
Keys never enter argv, environment variables, renderer messages, diagnostic logs,
or files. The helper and exporter require pipe/socket stdin/stdout and refuse
terminal or regular-file redirection, suppress provider details, and emit fixed
error codes. The helper uses the official
[Win32 pipe handle type](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-getfiletype)
on Windows. Child environments include only required OS/keychain,
locale, display, and D-Bus/XDG variables; arbitrary API tokens and preload hooks
are dropped. Calls have a deadline and bounded output.

The Windows exporter uses the trusted native helper's
`--attest-private-stdio` mode to inspect its inherited handles without reading
queued control bytes or accessing a key store. It then reads fd 0 directly:
[Electron 44's initialization](https://github.com/electron/electron/blob/v44.0.0/lib/common/init.ts)
replaces `process.stdin` with an EOF-only stream on Windows. This preserves
regular-file rejection without relying on CRT `fstat` pipe classification.

[run.mjs](../../scripts/credential-proof/run.mjs) stages three small service modules
without an application build, then runs a real Electron main process with the
`21x` product name and a separate temporary profile. It creates random synthetic
canaries in the actual secret BLOB, prefixed provider-setting, OAuth access/refresh
BLOB, and connector OAuth JSON formats, plus explicitly proven legacy plaintext.
The real Electron `safeStorage` encryptor/decryptor is used for every encrypted
class, including a leading BOM and Unicode secret. Corrupted source ciphertext
must be rejected by Electron itself. Input is bounded before newline completion
and split UTF-8 pipe chunks are decoded without losing characters.

Electron exports the original representations, their actual decoded values, and
canary hashes only to the trusted Node candidate over an anonymous pipe. A random
session nonce binds the response to the spawned exporter. No listener, browser
window, live database, or general-purpose export endpoint is created. The temporary
decoded cache supplies synchronous source reads to the bounded migration planner;
it is already-decoded real exporter data, not simulated OS decryption or hidden
synchronous RPC. The cache is cleared after conversion and is never inherited
by worker children.

The candidate creates an OS-protected key, converts all supported classes, checks
ambiguous/corrupt import rejection and unchanged originals, disposes its provider,
loads the key through another helper process, and verifies the converted values.
Tampered destination ciphertext must fail authentication. A second independent
Electron process then decrypts the untouched original fixtures again, proving
their continuing legacy usability. Output is metadata and pass/fail booleans;
raw manifests, canary plaintext, keys, ciphertext, and hashes are not reports.
Temporary profiles/modules and the fixture key are removed after the run.
Exporter errors await bounded termination of the owned process/group before
profile cleanup; failed termination retains the isolated directory and fails the
proof. The Linux controller has a bounded startup and overall session deadline.
Successful exporters flush their private metadata frame, then call graceful
`app.quit()`: Windows OSCrypt's protected profile-key preferences must persist
before an independent process can reopen original ciphertext. Immediate
`app.exit()` bypasses normal quit events. The parent still requires the owned
process to close successfully and enforces its bounded termination deadline;
failures emit fixed private frames and exit under a separate short deadline.
See [Electron's quit/exit lifecycle](https://www.electronjs.org/docs/latest/api/app)
and [OSCrypt initialization in Electron](https://github.com/electron/electron/blob/v44.0.0/shell/browser/browser_process_impl.cc).

[linux-session.mjs](../../scripts/credential-proof/linux-session.mjs) owns a
disposable D-Bus/display session and separate XDG/keyring directories. Its random
keyring password stays in memory and is passed only through private stdin.
It records real unlocked Secret Service conversion, `basic_text` source conversion
to the protected candidate, a verified locked collection and rejected new key
bootstrap/legacy access, key survival after unlock, and a rejected missing-bus
bootstrap. It does not lock a developer's login keyring. `basic_text` is never
accepted as destination protection.

Before its first Secret Service call, the controller checks the bus name owner
without auto-activation and verifies that its PID is the owned daemon's PID.
This prevents readiness polling from activating a second daemon with the outer
session's XDG environment. The outer bus activation environment also uses separate
temporary XDG roots, protecting original account keyrings even if the daemon
loses its name between the ownership check and a call. Failed outer sessions
retain these isolated activation files to avoid racing another daemon's exit.
Failure reports include fixed phase names, fixed
provider/planner codes, owned-daemon exit metadata and boolean ownership/alias
observations. They never include raw provider errors, D-Bus responses or canaries.
The bounded `21x.aes256gcm.v1` format identifier is accepted by the planner.

## Execute at a batch boundary

The helper manifest and lockfile must be integrated with the source before the
single native build:

```sh
cargo build --locked --manifest-path src-tauri/Cargo.toml -p twentyonex-credentials --bin twentyonex-credential-key
```

Linux needs `libdbus-1-dev`, an actual Secret Service (`gnome-keyring`), `gdbus`,
`dbus-run-session`, `xvfb-run`, and the installed Electron binary. Invoke:

```sh
node scripts/credential-proof/linux-session.mjs --helper /absolute/path/twentyonex-credential-key --electron /absolute/path/electron
```

macOS/Windows use their actual account stores:

```sh
node scripts/credential-proof/run.mjs --helper /absolute/path/twentyonex-credential-key --electron /absolute/path/electron
```

The helper has an `.exe` suffix on Windows. The manual
[credential workflow](../../.github/workflows/tauri-credentials.yml) runs Linux x64,
macOS x64/arm64, and Windows x64 serially and uploads only metadata reports.
Its dependency/bootstrap steps do not rebuild SQLite/PTY or compile the GUI host.
Focused unit checks are:

```sh
node node_modules/vitest/vitest.mjs run --project main --maxWorkers=1 src/main/platform/authenticated-secret-storage.test.ts src/main/platform/native-application-key-store.test.ts src/main/platform/credential-migration.test.ts
```

## Evidence boundaries and remaining integration

The retained reports establish the four-target synthetic proof, with successful
fixture cleanup and explicit platform/account conditions. Hosted CI proves the
developer Electron binary under the `21x` product
name, not compatibility with an existing signed installation. The report includes
`isPackaged`; a consistently signed transitional Electron build under the installed
identity/account is still needed to prove existing macOS Keychain ACL access.
Actual user-profile ciphertext compatibility and rollback remain separate from
these synthetic fixtures. Windows existing DPAPI data and Linux's other supported
keyring backends also require installed-profile rehearsal.

The candidate's versioned ciphertext is distinct from Electron `safeStorage`.
[SecretStorage](../../src/main/platform/secret-storage.ts) now declares a typed
provider format contract, with unsupported runtime format IDs rejected atomically
at registration. An absent format ID means only the transitional three-method
legacy contract. [Production serializers](../../src/main/database/serializers.ts)
retain Electron's `safeStorage:v1:` wrapper and historical availability fallback;
the authenticated provider writes and reads
`21x-credential:21x.aes256gcm.v1:<ciphertext-base64>`. Credential setting reads
reject unknown reserved versions, incompatible providers and malformed native
ciphertext with fixed errors. Native setting access refuses unavailable/disposed
providers instead of writing plaintext. Ordinary settings bypass this codec.

The [actual DatabaseManager reopen test](../../src/main/platform/profile-migration-settings-integration.test.ts)
initializes a copied, rehearsal-owned candidate with the matching destination
provider, reads all four credential classes, writes/reopens an encrypted setting,
and checks that startup does not re-encrypt its wrapper. The original profile
and committed candidate remain unchanged. This is synthetic-key integration
evidence, separate from the real OS-store reports. No shipping bootstrap registers
this candidate provider.

The [profile lock](profile-lock.md) now provides local lifetime ownership for updated
Electron/service hosts before database opens; trusted native bootstrap must hold
the same lock before key creation. The
[journaled SQLite import rehearsal](profile-import-rehearsal.md) now snapshots a
stopped fixture with explicit WAL handling, encrypts its immutable original SQLite
capsule in memory before persistence, and transactionally converts credential
fields. Authenticated journal states and fsync/rename publication support repeated
and interrupted candidate commit/recovery. Explicit rollback writes only an owned
rehearsal output and refuses to persist historical plaintext credentials. It never
overwrites the original database or activates a candidate. Declared resources are
retained and verified byte-for-byte, not archived; this is not an encrypted backup
of an entire profile.

Installed cross-host/filesystem rehearsal, actual exporter-to-journal integration,
typed JSON configuration credential extraction, full resource archival and
power-loss durability, native helper signing/path verification, key rotation and
write-volume policy, live activation and post-cutover rollback remain release
integration work. The current process uses randomized GCM nonces; total key
lifetime usage and rotation must be
bounded in the final persistent-provider contract. A locked OS store does not
erase a key already loaded into a running service; shutdown/disposal is the current
cache boundary, and any stronger lock-event behavior needs a reviewed host policy.

Real synthetic OS-store conversion now passes on all four supported targets.
The [retained metadata record](credential-proof-evidence.json) preserves exact
reports, source commits and tool versions after hosted artifact retention expires.
The successful runs used different commits as platform-specific fixture defects
were corrected; these are not a claim that one revision was rerun on every target.

| Target | Source commit | Passing run |
| --- | --- | --- |
| Linux x64 | `f5a35ea` | [38288066977](https://github.com/krazyjakee/21x/actions/runs/38288066977) |
| macOS x64 | `e135643` | [38282440311](https://github.com/krazyjakee/21x/actions/runs/38282440311) |
| macOS arm64 | `e135643` | [38282440311](https://github.com/krazyjakee/21x/actions/runs/38282440311) |
| Windows x64 | `eb5c81e` | [38291150315](https://github.com/krazyjakee/21x/actions/runs/38291150315) |

All successful reports prove converted values survive independent native key
reload, source/destination corruption is rejected, original representations remain
unchanged and reopen through a second Electron process, and native fixture keys
are deleted. Linux additionally proves locked legacy/native refusal, missing-bus
refusal and protected-key survival after labelled owned-daemon restart. This
completes #201's synthetic candidate proof scope; #193 still owns signed installed
macOS ACL access, actual user ciphertext rehearsal and transactional live import.

The reports expose provenance checks and fixed runtime failure categories before
any conversion is accepted. The Linux synthetic fixture
can retry a specifically classified Chromium sandbox startup failure without a
sandbox; this is a fixed main-only exporter with no renderer, listener, arbitrary
code or live profile, and reports `proofOnlyLinuxSandboxDisabled`. Shipping host
sandbox configuration is unaffected. Raw startup stderr is privately bounded,
classified into fixed categories, discarded, and never exported.

For Linux key survival after a verified collection lock, the controller terminates
its owned daemon, reopens the same isolated keyring with the same private password,
verifies the new daemon PID and unlocked property, then loads the original key.
Reports label this `unlockMethod: owned-daemon-restart`. It proves lock rejection
and persistent protected-key survival/reopen; it does not prove interactive unlock
of the same daemon. GNOME's
[daemon implementation](https://github.com/GNOME/gnome-keyring/blob/46.2/daemon/gkd-main.c)
uses `--unlock` during daemon initialization, so starting an additional daemon was
not a reliable way to unlock the originally owned process. The workflow's optional
`target` selector retries one affected platform while retaining `max-parallel: 1`.
