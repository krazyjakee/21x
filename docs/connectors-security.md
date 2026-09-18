# Connector pieces: security, licensing and supply chain

21x embeds a small number of MIT-licensed [Activepieces](https://github.com/activepieces/activepieces)
pieces behind a host that 21x owns (see [connectors.md](connectors.md)). Every piece is
third-party code that runs with the user's credentials, so it is handled as untrusted
executable code. This page covers the controls for issues #12 and #18.

> **Not legal advice.** These are engineering controls. They reduce the chance of shipping
> code under the wrong license, but they do not replace a legal review. Have counsel review
> redistribution before a release that bundles pieces.

## What runs where

| Part | Where | Can reach |
| --- | --- | --- |
| `PieceHostClient` (`src/main/connectors/piece-host/client.ts`) | main process | the database, via the KV backend and the credential store |
| Piece host (`host-entry.ts` → `out/main/piece-host.js`) | Electron `utilityProcess` with a minimal environment | only the messages the client sends it |
| Piece code | inside the piece host | `context.auth` (resolved for this call), `propsValue`, and `context.store` bound to one instance |

- Pieces never get database access. `context.store` calls go over IPC. The main process picks
  the instance from the call id, so a piece cannot read or write another instance's keys.
- Credentials are resolved for each call and are never stored in the host. Piece error
  messages go through `redactCredentials()` before they leave the client.
- Calls run one at a time, each with a timeout (60 s by default) and an optional
  `AbortSignal`. On timeout or cancellation the host process is killed. If it crashes, the
  call fails with `PieceHostCrashedError`. The next call starts a fresh host.
- Unsupported context use throws a typed `UnsupportedPieceContext` error. This covers flow
  control, pause and resume, waitpoints, webhook URLs, `server.*`, platform file storage,
  connections lookup, tags, output updates, agent tools and `setSchedule`. If the piece
  catches the throw, the call still fails. Unsupported use is never a silent no-op.

## Allowlist

`src/main/connectors/allowlist.ts` is the only list of what may run:

- **`pieces`**: package → exact version → export name → allowed actions and triggers. The host
  loads a piece only if it passes three checks: it is listed here, it is in the static
  registry (`piece-host/piece-registry.ts`), and it is installed at the pinned version. There
  is no runtime `npm install` and no dynamic `require(name)`.
- **`packages`**: supporting `@activepieces/*` packages that are allowed as dependencies.
- **`urlProps`** on an action or trigger: props that hold URLs. The SSRF guard checks them (see below).
- **`reviewedLicenseExceptions`** / **`reviewedPathExceptions`**: packages or paths that the
  automated license check can't decide. Each one needs a human review and a note, and applies
  to one exact `name@version`. A version bump invalidates the exception.

The block between `// BEGIN ALLOWLIST DATA` and `// END ALLOWLIST DATA` must stay strict JSON,
because the CI script parses it directly.

### Current license findings (reviewed 2026-09-18)

| Package | Version | Declared license | LICENSE file | Finding |
| --- | --- | --- | --- | --- |
| `@activepieces/piece-trello` | 0.6.0 | none | none | MIT under the upstream root LICENSE (`packages/pieces/community/trello`). A self-contained esbuild bundle with no runtime dependencies. Inlines MIT code (axios, mime-types, dayjs, ipaddr.js). No enterprise DTOs in the bundle. |
| `@activepieces/pieces-framework` | 0.32.0 | none | none | MIT (`packages/pieces/framework`). Pulls in `ai` (Apache-2.0), `zod`, `semver`, `tslib` and `@activepieces/shared`. Not loaded by the host at runtime. |
| `@activepieces/shared` | 0.95.1 | none | none | MIT (`packages/shared`). Ships `src/lib/ee/**` DTO modules. The root LICENSE reserves only `packages/ee/` and `packages/server/api/src/app/ee/`, so these files are MIT, but they are flagged for re-review on every bump. |
| `@activepieces/pieces-common` | 0.12.5 | none | none | MIT (`packages/pieces/common`). Not a dependency, because Trello bundles its own copy. |

The upstream root LICENSE puts `packages/ee/` and `packages/server/api/src/app/ee/` under a
commercial license. Never copy files from those paths, depend on packages built from them,
embed the Activepieces builder, or call Activepieces-hosted services.

## CI checks

- **`scripts/check-connector-pieces.mjs`** runs in `verify.yml` and `release.yml` after
  `pnpm install`. It fails in any of these cases:
  - an `@activepieces/*` dependency is not allowlisted, or is not pinned to the exact
    allowlisted version (`^`, `~`, ranges and tags all fail);
  - an allowlisted piece is missing from `package.json`, or is installed at another version;
  - a package in the installed dependency closure has a license outside `allowedLicenses`,
    or has no license and no reviewed exception for that exact version;
  - an `@activepieces/*` package ships files that match `commercialPathPatterns`, or files
    under any `ee/` directory that has no reviewed path exception.
- **`release.yml`** (Linux job) also runs three steps:
  - `pnpm audit --prod` (gating on critical advisories; the full report is printed) to scan dependencies;
  - `npm audit signatures` to check registry signatures and provenance attestations;
  - `pnpm dlx @cyclonedx/cdxgen` to generate a CycloneDX SBOM, which it uploads as the
    `sbom-cyclonedx` artifact.

## How to add or update a piece

1. Pick a piece whose source is under `packages/pieces/community/` upstream, not under an
   `ee` path. Read its source for the context features it uses. Pieces that need webhooks,
   `files`, `connections`, flow control or `server.*` either won't work or will fail with
   `UnsupportedPieceContext`.
2. Inspect the tarball: run `npm pack @activepieces/piece-x@<version>`, then `tar tzf` on the
   result. Check the `license` field, any LICENSE files, runtime dependencies, and whether it
   is a self-contained bundle.
3. Add the exact version to `dependencies` in `package.json` (no `^` or `~`), then update
   `pnpm-lock.yaml`.
4. Add the piece to `pieces` in `allowlist.ts`. List only the actions and polling triggers
   that 21x needs. Leave out `custom_api_call`, AI actions and anything that sends arbitrary
   HTTP requests. Declare `urlProps` for every prop that holds a URL.
5. Add a static loader entry in `piece-host/piece-registry.ts`.
6. If the package has no declared license, add a `reviewedLicenseExceptions` entry with the
   upstream path, your conclusion and the date. Do the same for any flagged `ee/` paths.
7. Run `node scripts/check-connector-pieces.mjs` and the tests. Record the per-piece package
   size (#17).

## Security-update SLA and rollback

- **Monitoring:** check upstream Activepieces releases and security advisories, the
  `pnpm audit --prod` (gating on critical advisories; the full report is printed) output, and Dependabot alerts at least once a week.
- **SLA:** start from when the advisory is known.

  | Severity | What to do | Deadline |
  | --- | --- | --- |
  | Critical or high | Ship a fixed version or disable the affected piece | 7 days |
  | Moderate | Fix | Next release, and within 30 days |
  | Low | Fix | Next scheduled dependency update |

- **Disable without a new version:** remove the piece, or just the affected actions and
  triggers, from `allowlist.ts` and ship. The client and the host both refuse non-allowlisted
  calls with `PieceNotAllowedError`. Stored instances and their KV data stay intact, so
  re-enabling later needs no migration.
- **Rollback:** revert the pin in `package.json`, the allowlist entry and the lockfile together
  in one commit, then cut a release. Pins are exact, so an old release always rebuilds with
  the same piece code.
- **Upstream breaking changes:** the host depends on a small structural contract. That
  contract is `Piece.getAction()` and `getTrigger()`, `action.run(ctx)`, and the trigger's
  `onEnable`, `onDisable`, `run` and `test` hooks with `type: 'POLLING'`. It also includes
  `context.store` scopes (`FLOW` and `COLLECTION`) and the `AppConnectionValue` auth shapes
  (`SECRET_TEXT`, `BASIC_AUTH`, `CUSTOM_AUTH`). For each framework bump:
  1. Read the upstream changelog for `packages/pieces/framework`.
  2. Diff `src/lib/context/index.d.ts`.
  3. Run `piece-host.test.ts` against the new version before changing the pin.

## SSRF guard (`src/main/connectors/ssrf.ts`)

Before a piece runs, the host checks every `urlProps` value. It blocks all of these:

- protocols other than `http:` and `https:`;
- URLs with embedded credentials;
- `localhost` and `*.localhost`;
- any host that resolves to a loopback, private (RFC 1918 or ULA), link-local (including
  169.254.169.254), CGNAT, multicast, unspecified or reserved address.

IPv4-mapped and NAT64 IPv6 forms, and decimal, hex and octal IPv4 forms, are normalized
before the check. An allowlist entry can set `allowPrivateNetwork: true` for a self-hosted
service on the LAN.

Limitation: the guard checks the configured value, not the socket that the piece opens later,
so DNS rebinding between the check and the request is not covered. Keep pieces with
free-form URL props off the allowlist until the host routes their HTTP through an agent
that pins the address.

## n8n

n8n is not used. No bundling, no embedding, and no use with end-user credentials without
written clearance from n8n and acceptable commercial terms. This applies to n8n nodes as well
as the n8n platform. The allowlist and the CI check cover only `@activepieces/*`. Adding an
n8n package would need a separate decision, not an allowlist entry.

## Webhooks

The desktop app never opens a public listener or tunnel for pieces. Only `POLLING` triggers
are allowlisted, and the host refuses any other trigger type. Reading `context.webhookUrl`
throws `UnsupportedPieceContext`.

Push triggers may be added later, but only if all of these hold:

- signatures are authenticated;
- replays are blocked;
- queues are bounded;
- the public endpoint is explicit and the user manages it.

Each push trigger needs its own typed contract.
