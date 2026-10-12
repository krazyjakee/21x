# Native credential candidate and real legacy proof

This is the runnable T03 candidate tracked in #201. It preserves shipping
Electron storage and does not convert a live profile. A passing unit test is
separate from an actual OS proof report; the reports have to be generated on
the supported platform matrix before accepting the credential feasibility gate.

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

The helper uses no default/mock store, keyutils-only store, or plaintext fallback.
The fixed service is `com.krazyjakee.21x.credentials.v1`; the account identifies
the profile. Native create refuses an existing entry and never treats locked or
unreadable storage as permission to replace it. Generic credential APIs do not
provide an atomic compare-and-create operation: **trusted bootstrap must hold the
future cross-host profile lock before key creation**. The probe uses unique
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
or files. The helper refuses terminal stdin/stdout, suppresses panic/provider
details, and emits fixed error codes. This binary must only be invoked by the
trusted pipe client: redirecting its private response to a file is outside this
interface's contract. Child environments include only required OS/keychain,
locale, display, and D-Bus/XDG variables; arbitrary API tokens and preload hooks
are dropped. Calls have a deadline and bounded output.

[run.mjs](../../scripts/credential-proof/run.mjs) stages three small service modules
without an application build, then runs a real Electron main process with the
`21x` product name and a separate temporary profile. It creates random synthetic
canaries in the actual secret BLOB, prefixed provider-setting, OAuth access/refresh
BLOB, and connector OAuth JSON formats, plus explicitly proven legacy plaintext.
The real Electron `safeStorage` encryptor/decryptor is used for every encrypted
class. Corrupted source ciphertext must be rejected by Electron itself.

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

[linux-session.mjs](../../scripts/credential-proof/linux-session.mjs) owns a
disposable D-Bus/display session and separate XDG/keyring directories. Its random
keyring password stays in memory and is passed only through private stdin.
It records real unlocked Secret Service conversion, `basic_text` source conversion
to the protected candidate, a verified locked collection and rejected new key
bootstrap/legacy access, key survival after unlock, and a rejected missing-bus
bootstrap. It does not lock a developer's login keyring. `basic_text` is never
accepted as destination protection.

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

## Evidence boundaries and future integration

Do not mark T03 passed merely because these scripts exist. Retain actual reports,
the source commit/tool versions, successful fixture cleanup, and platform/account
conditions. Hosted CI proves the developer Electron binary under the `21x` product
name, not compatibility with an existing signed installation. The report includes
`isPackaged`; a consistently signed transitional Electron build under the installed
identity/account is still needed to prove existing macOS Keychain ACL access.
Actual user-profile ciphertext compatibility and rollback remain separate from
these synthetic fixtures. Windows existing DPAPI data and Linux's other supported
keyring backends also require installed-profile rehearsal.

The candidate's versioned ciphertext is distinct from Electron `safeStorage`.
Current serializers' `safeStorage:v1:` setting wrapper and their availability-based
fallback policy cannot simply be reused for the candidate. T10 must introduce
reviewed format-aware serialization, reject native-provider unavailability without
plaintext writes, and preserve explicit legacy read/import paths. No current
shipping bootstrap registers this candidate provider.

Profile locking, consistent database/WAL backup, import journaling, atomic database
apply, JSON configuration credential extraction, repeated/interrupted import
recovery, native helper signing/path verification, key rotation/write-volume policy,
and post-cutover rollback are outstanding release integration work. The current
process uses randomized GCM nonces; total key lifetime usage and rotation must be
bounded in the final persistent-provider contract. A locked OS store does not
erase a key already loaded into a running service; shutdown/disposal is the current
cache boundary, and any stronger lock-event behavior needs a reviewed host policy.
