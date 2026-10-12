# Legacy credential conversion rehearsal

`prepareCredentialMigration` in
[credential-migration.ts](../../src/main/platform/credential-migration.ts)
prepares a bounded, deeply immutable, encrypted-only conversion plan in the
trusted service process. It accepts raw legacy rows and injected legacy and
destination providers; it reads or writes no database, files, IPC, or logs.
It cannot convert a live profile. The preparation harness tracked in #199 now
feeds the separate [journaled owned-fixture import rehearsal](profile-import-rehearsal.md).
The [four-target real OS-store candidate evidence](credential-proof-evidence.json)
completes #201's synthetic T03 proof scope. #193 retains signed installed-profile
compatibility, complete credential coverage and live migration gates.

## Formats found in the shipping code

| Location | Stored representation and policy | Harness input |
| --- | --- | --- |
| `secrets.value` | Untagged BLOB: Electron `safeStorage` ciphertext, or UTF-8 plaintext when encryption was unavailable. | `blob` with trusted `safeStorage` or `plaintext-utf8` interpretation. |
| `oauth_tokens.access_token`, `oauth_tokens.refresh_token` | Same untagged BLOB policy. Access is required; refresh is nullable. Applies to source and MCP OAuth rows. | Explicitly interpreted BLOBs; omit absent/null refresh fields. Empty token payloads fail conversion. |
| `settings.value`, when `settings.key` ends in `_api_key` | Legacy TEXT: `safeStorage:v1:` followed by standard base64 ciphertext, or legacy/fallback plaintext. The authenticated candidate uses `21x-credential:21x.aes256gcm.v1:` plus ciphertext base64. Empty values remain empty. | Legacy `setting`, with the setting key as `location.rowId`. Canonical legacy v1 base64 is decoded; other reserved `safeStorage:` prefixes fail closed. Native candidate wrappers are consumed by the matching production serializer, not guessed as legacy planner input. |
| `connector_instances.auth`, paired with `auth_type` | Nullable untagged BLOB containing encrypted credential JSON. Persistent connectors refuse plaintext fallback. Explicit session credentials exist only in memory and clear the persisted BLOB. | Explicit `safeStorage` BLOB plus the persisted `connectorAuthType`; omit absent/null BLOBs and session-only credentials. |

The relevant implementations are
[serializers.ts](../../src/main/database/serializers.ts),
[database manager](../../src/main/database/manager.ts),
[connector credentials](../../src/main/connectors/credentials.ts), and
[connector store](../../src/main/connectors/connector-store.ts).
Provider-key startup encryption upgrades plaintext settings only; it does not
tag or classify old secret/OAuth BLOBs. A profile can therefore contain mixed
plaintext and ciphertext. Bytes, UTF-8 validity, current keychain availability,
or a failed decrypt do not establish how an untagged BLOB was originally written.
The trusted exporter must establish that interpretation separately; this harness
never guesses or retries ciphertext as plaintext.

The database manager writes false/empty refresh tokens as SQL NULL. Deserialization also
maps an empty decoded refresh value to null. The rehearsal treats a supplied
empty token BLOB/value as invalid and requires an explicit recovery decision,
instead of creating a newly encrypted empty token. Genuine empty secret or
setting values are preserved; decode exceptions never become empty values.
UTF-8 plaintext decoding rejects malformed sequences and preserves a leading
U+FEFF BOM, matching the legacy string contents.

Credential-bearing JSON also exists in `agents.config.api_keys`,
`mcp_servers.headers`, `mcp_servers.environment`,
`mcp_servers.oauth_metadata.client_secret`, and `task_sources.config`.
These columns are JSON TEXT written without the secret serializer. Connector
configuration/KV and plugin-defined config can contain further sensitive values.
This harness refuses unsupported locations. It does not rewrite arbitrary JSON
or claim that converting the four supported credential classes completes a
profile audit; typed extraction/reference formats for those additional fields
remain part of T03/T10 design.

## Preparation contract

The trusted caller supplies a destination `SecretStorage`, a versioned
`formatId`, and `persistentProtection: 'os-protected'`. The protection field is
a bootstrap trust assertion, not proof that a plugin, keychain, or test fixture
provides secure encryption. The destination must be available for every operation,
produce nonempty ciphertext distinct from plaintext, and decrypt its output back
to the exact original string. These sanity checks do not prove crypto strength
or cross-host compatibility. No bespoke cipher or plaintext fallback is provided.
The legacy provider is required only when ciphertext must be decrypted.

The planner checks manifest locations, duplicate destinations, explicit BLOB
interpretations, and size limits before encryption. It decodes settings strictly
and validates connector JSON against its `auth_type`, including complete OAuth
client/access/refresh metadata. It preserves the original JSON text rather than
normalizing it. Provider exceptions become fixed error codes and record indices;
error messages and causes are never forwarded.

Only after every record decrypts, validates, encrypts, and verifies does the
planner return `{ planVersion, destinationFormat, changes, inputBytes,
encryptedBytes }`. Each change contains a frozen location and ciphertext base64.
There are no original/plaintext values in the result. The plan is an in-memory
conversion result; only the separately scoped fixture importer applies it to a
candidate database under its held lock and encrypted journal. A plan alone is
not permission to persist or activate a live profile. Source values remain
unchanged, including when a provider mutates the defensive ciphertext buffer
passed to it, or a later row fails conversion.

Hard limits are 10,000 records, 1 MiB per source/decoded value, 16 MiB total source
values, and 32 MiB total destination ciphertext. Callers may lower these limits.
Base64 adds encoding overhead to the returned plan; record metadata is bounded
by the record cap and 256-character row identifiers. Exceeding a limit fails
without a usable partial plan. Encryption providers must not persist profile
changes as a side effect of these encryption operations.

Scratch buffers are cleared where practical. JavaScript plaintext strings and
provider-internal caches cannot be reliably wiped by this harness; keep them
within the trusted service process, do not inherit them into worker children,
and dispose of provider state on shutdown. Raw manifests must never be serialized
to logs, files, argv, or renderer messages.

## Completed evidence and remaining integration

Planner unit tests use opaque in-memory lookup fixtures; they perform no real OS
encryption. The separate [native candidate proof](credential-native-proof.md)
has passed actual Electron `safeStorage` to protected native-store conversions on
macOS x64/arm64, Windows x64 and Linux x64. The
[retained source-linked reports](credential-proof-evidence.json) cover all four
credential classes, trusted legacy plaintext provenance, source/destination
corruption rejection, independent native key reload, unchanged originals reopened
by another Electron process, and fixture key cleanup. Linux also proves locked
legacy/native refusal, unavailable bus refusal, protected-key survival after an
owned-daemon restart and `basic_text` source conversion. `basic_text` is never
accepted as destination protection.

The [lifetime profile lock](profile-lock.md) now guards updated Electron/service
hosts before database opens. Trusted native key creation must hold the same lock.
The
[owned-fixture importer](profile-import-rehearsal.md) performs bounded consistent
SQLite/WAL snapshotting, encrypts the immutable original SQLite capsule before
its first filesystem write, updates exact credential fields in one transaction,
and publishes the candidate with an authenticated encrypted journal. Repeated and
interrupted commit/recovery and explicit owned-output rollback have concrete
coverage. Original database representations remain intact. Declared resources are
retained and verified, not archived: this is not a whole-profile encrypted backup.

[Format-aware production setting serialization](../../src/main/database/serializers.ts)
matches the candidate's `21x-credential:21x.aes256gcm.v1:` wrapper using the
[typed provider format contract](../../src/main/platform/secret-storage.ts).
Unsupported provider IDs fail registration atomically; absent IDs retain only
the transitional legacy provider contract. Unknown reserved setting versions and
provider mismatches fail closed, while Electron's legacy wrapper bytes and
fallback behavior remain compatible. Ordinary settings are unaffected. The
[actual DatabaseManager integration test](../../src/main/platform/profile-migration-settings-integration.test.ts)
reopens a copied rehearsal candidate with the matching authenticated provider,
reads all four classes and verifies encrypted setting writes across reopen.
Its synthetic keys do not add an OS-store or live-activation claim.

The developer Electron fixtures are not signed installed applications or actual
historical user profiles. Existing macOS Keychain ACL access under a consistently
signed installation, installed Windows DPAPI/Linux backend compatibility, complete
typed configuration credential coverage, real-exporter integration with the
journaled importer, platform filesystem/power-loss rehearsal and full resource
archival remain gates. Live activation and post-cutover rollback are not
implemented. The planner's all-or-nothing return does not make OS-store writes
transactional or authorize those operations.

Preserve the complete original profile for rollback under the backup policy,
including any historical plaintext fields; do not create a separate plaintext
credential export. After converted-profile writes, rollback requires the matching
pre-cutover profile or a separately proven reverse conversion. Shipping bootstrap
does not activate the rehearsal candidate. Explicit owned-fixture
rollback refuses to persist legacy plaintext credentials and leaves those
originals inside the encrypted capsule; it never overwrites the source database.

Run the focused harness tests at the end of a work batch:

```sh
node node_modules/vitest/vitest.mjs run --project main --maxWorkers=1 src/main/platform/credential-migration.test.ts
```
