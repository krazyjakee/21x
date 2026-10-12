# Legacy credential conversion rehearsal

`prepareCredentialMigration` in
[credential-migration.ts](../../src/main/platform/credential-migration.ts)
prepares a bounded, deeply immutable, encrypted-only conversion plan in the
trusted service process. It accepts raw legacy rows and injected legacy and
destination providers; it reads or writes no database, files, IPC, or logs.
It has no application bootstrap integration and cannot convert a live profile.
This prepares the harness tracked in #199. The real T03 gate in #193 remains open.

## Formats found in the shipping code

| Location | Stored representation and policy | Harness input |
| --- | --- | --- |
| `secrets.value` | Untagged BLOB: Electron `safeStorage` ciphertext, or UTF-8 plaintext when encryption was unavailable. | `blob` with trusted `safeStorage` or `plaintext-utf8` interpretation. |
| `oauth_tokens.access_token`, `oauth_tokens.refresh_token` | Same untagged BLOB policy. Access is required; refresh is nullable. Applies to source and MCP OAuth rows. | Explicitly interpreted BLOBs; omit absent/null refresh fields. Empty token payloads fail conversion. |
| `settings.value`, when `settings.key` ends in `_api_key` | TEXT: `safeStorage:v1:` followed by standard base64 ciphertext, or legacy/fallback plaintext. Empty values remain empty in the current serializer. | `setting`, with the setting key as `location.rowId`. Canonical v1 base64 is decoded; other reserved `safeStorage:` prefixes fail closed. |
| `connector_instances.auth`, paired with `auth_type` | Nullable untagged BLOB containing encrypted credential JSON. Persistent connectors refuse plaintext fallback. Explicit session credentials exist only in memory and clear the persisted BLOB. | Explicit `safeStorage` BLOB plus the persisted `connectorAuthType`; omit absent/null BLOBs and session-only credentials. |

The relevant implementations are
[serializers.ts](../../src/main/database/serializers.ts),
[database.ts](../../src/main/database.ts),
[connector credentials](../../src/main/connectors/credentials.ts), and
[connector store](../../src/main/connectors/connector-store.ts).
Provider-key startup encryption upgrades plaintext settings only; it does not
tag or classify old secret/OAuth BLOBs. A profile can therefore contain mixed
plaintext and ciphertext. Bytes, UTF-8 validity, current keychain availability,
or a failed decrypt do not establish how an untagged BLOB was originally written.
The trusted exporter must establish that interpretation separately; this harness
never guesses or retries ciphertext as plaintext.

`database.ts` writes false/empty refresh tokens as SQL NULL. Deserialization also
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
There are no original/plaintext values in the result. The plan describes an
in-memory rehearsal format, not a committed SQLite storage format or permission
to persist it. Source values remain unchanged, including when a provider mutates
the defensive ciphertext buffer passed to it, or a later row fails conversion.

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

## Evidence and integration still required

The tests use opaque in-memory lookup fixtures to exercise transformations and
failure behavior. They perform no real OS encryption. Actual Electron-produced
ciphertext and protected destination storage must be rehearsed on macOS x64/arm64,
Windows x64, and Linux x64, under the existing app identity and OS account.
Cover every supported credential class, legacy plaintext provenance, locked and
unavailable stores, corrupt data, and Linux `basic_text`. A legacy provider may
decode `basic_text`; a destination must not claim it as OS-protected storage.

The separate [native candidate and real proof](credential-native-proof.md) now
provides executable Electron/OS-store canary scripts. Its reports must actually
pass on the platform matrix; these planner unit fixtures still cannot close T03.

T03 still needs the selected native provider and synchronous/async strategy,
real fixture generation, trusted BLOB provenance, and an authenticated private
legacy-to-destination transfer. T10 still needs the one-writer profile lock,
consistent SQLite backup/WAL handling, import journal, atomic database apply,
repeated/interrupted import recovery, configuration credential coverage, and
rollback safeguards. This planner's all-or-nothing return does not make future
database or OS-store writes transactional.

Preserve the complete original profile for rollback under the backup policy,
including any historical plaintext fields; do not create a separate plaintext
credential export. After converted-profile writes, rollback requires the matching
pre-cutover profile or a separately proven reverse conversion. Neither existing
Electron serializers nor the Tauri runtime currently consume the rehearsal plan.

Run the focused harness tests at the end of a work batch:

```sh
node node_modules/vitest/vitest.mjs run --project main --maxWorkers=1 src/main/platform/credential-migration.test.ts
```
