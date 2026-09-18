import { PieceNotAllowedError } from './piece-host/errors'
import type { SsrfPolicy } from './ssrf'

/**
 * Connector piece allowlist (issues #12 and #18, docs/connectors-security.md).
 *
 * The piece host loads only packages listed in `pieces`, only at the exact
 * pinned version, and only runs the listed actions and triggers.
 * scripts/check-connector-pieces.mjs enforces the same list in CI: every
 * `@activepieces/*` dependency in package.json must appear here (in `pieces`
 * or `packages`) with the identical exact version, and every package in their
 * installed dependency closure must carry an allowed license or a reviewed
 * exception below.
 *
 * The block between the ALLOWLIST DATA markers must stay strict JSON (double
 * quotes, no comments, no trailing commas): the CI script parses it directly.
 * Use the `note` fields for commentary.
 */

export interface AllowedPieceOperation extends SsrfPolicy {
  /** Props holding URLs. Each value is checked by the SSRF guard before the piece runs. */
  urlProps?: string[]
  note?: string
}

export interface AllowedPieceTrigger extends AllowedPieceOperation {
  /** Only polling triggers are supported: 21x never opens a public webhook listener. */
  strategy: 'POLLING'
}

/**
 * OAuth2 settings for a piece declared with `PieceAuth.OAuth2` (issue #15,
 * docs/taskSources.md "Connector OAuth2"). Per-provider decisions live here as
 * data; no client secret ever does.
 */
export interface AllowedPieceOAuth {
  /**
   * `user-supplied`: the user registers an OAuth app with the provider and
   * pastes its client id (and secret) into the config form.
   * `registered`: a 21x-registered public client whose id is `clientId`
   * below; only for providers that accept PKCE without a secret. None yet.
   */
  mode: 'user-supplied' | 'registered'
  /** Only for `registered` mode. Never a secret. */
  clientId?: string
  /** Must equal the piece's `PieceAuth.OAuth2({ authUrl, tokenUrl })`. */
  authUrl: string
  tokenUrl: string
  /** The smallest scopes the allowlisted operations need. */
  scopes: string[]
  /** Send a PKCE S256 challenge. False when the provider does not document PKCE. */
  pkce: boolean
  /** Whether the provider accepts http://localhost:<port>/callback for desktop apps. */
  loopbackRedirect: boolean
  /** Extra authorization query parameters. */
  authParams?: Record<string, string>
  note?: string
}

export interface AllowedPiece {
  /** Exact version; package.json must pin the same string. */
  version: string
  /** Named export holding the Piece object. */
  exportName: string
  actions: Record<string, AllowedPieceOperation>
  triggers: Record<string, AllowedPieceTrigger>
  /** Present for OAuth2 pieces; absent pieces use secret_text / basic / custom_auth credentials. */
  oauth?: AllowedPieceOAuth
  note?: string
}

export interface AllowedSupportPackage {
  version: string
  /** Why the package is a dependency and whether it is needed at runtime. */
  note: string
}

export interface ReviewedLicenseException {
  package: string
  version: string
  /** The license we concluded applies after review. */
  concludedLicense: string
  note: string
  reviewedOn: string
}

export interface ReviewedPathException {
  package: string
  version: string
  /** Path prefix inside the published tarball. */
  pathPrefix: string
  note: string
  reviewedOn: string
}

export interface ConnectorPieceAllowlist {
  /** SPDX ids acceptable for allowlisted packages and everything they pull in. */
  allowedLicenses: string[]
  /** Regexes (tested against package-relative paths) that mark commercially licensed upstream code. */
  commercialPathPatterns: string[]
  pieces: Record<string, AllowedPiece>
  packages: Record<string, AllowedSupportPackage>
  reviewedLicenseExceptions: ReviewedLicenseException[]
  reviewedPathExceptions: ReviewedPathException[]
}

// BEGIN ALLOWLIST DATA
export const CONNECTOR_PIECE_ALLOWLIST: ConnectorPieceAllowlist = {
  "allowedLicenses": [
    "MIT",
    "ISC",
    "0BSD",
    "BSD-2-Clause",
    "BSD-3-Clause",
    "Apache-2.0",
    "CC0-1.0",
    "Unlicense",
    "BlueOak-1.0.0"
  ],
  "commercialPathPatterns": [
    "(^|/)packages/ee/",
    "(^|/)server/api/src/app/ee/",
    "(^|/)ee/LICENSE"
  ],
  "pieces": {
    "@activepieces/piece-trello": {
      "version": "0.6.0",
      "exportName": "trello",
      "note": "Self-contained esbuild bundle (framework, pieces-common, axios inlined); no runtime dependencies. Webhook triggers new_card and card_moved_to_list, custom_api_call and *_ai actions are deliberately excluded.",
      "actions": {
        "list_boards": {},
        "get_board": {},
        "list_lists": {},
        "get_list": {},
        "list_cards_in_board": {},
        "list_cards_in_list": {},
        "search_cards": {},
        "get_card": {},
        "create_card": {},
        "update_card": {},
        "move_card": {},
        "archive_card": {},
        "add_comment_to_card": {}
      },
      "triggers": {
        "deadline": { "strategy": "POLLING" }
      }
    },
    "@activepieces/piece-todoist": {
      "version": "0.5.0",
      "exportName": "todoist",
      "note": "OAuth2 proof piece (issue #15). Self-contained esbuild bundle (framework, pieces-common, dayjs, mime-types, ipaddr.js inlined); no runtime dependencies. Only the read and task-state actions the task mapping needs are listed: create, quick-add, move, delete, comment, label, section, project-write, activity-log, completed-task listings and custom_api_call are deliberately excluded.",
      "oauth": {
        "mode": "user-supplied",
        "authUrl": "https://todoist.com/oauth/authorize",
        "tokenUrl": "https://todoist.com/oauth/access_token",
        "scopes": ["data:read_write"],
        "pkce": false,
        "loopbackRedirect": true,
        "note": "Todoist does not document PKCE and needs the client secret at the token endpoint, so the user pastes their own app's id and secret (developer.todoist.com/appconsole.html) and the secret is stored with the connector credentials, never in the repo. data:read_write is the smallest scope that can read tasks and update/close/reopen them (data:read cannot write). Tokens do not expire and no refresh token is issued; revocation shows up as HTTP 401. Any redirect URL can be registered in the app console, including the loopback http://localhost:<3000-3010>/callback."
      },
      "actions": {
        "todoist_filter_tasks": {},
        "todoist_get_task": {},
        "todoist_list_projects": {},
        "todoist_update_task": {},
        "todoist_complete_task": {},
        "todoist_reopen_task": {}
      },
      "triggers": {
        "task_completed": { "strategy": "POLLING" }
      }
    }
  },
  "packages": {
    "@activepieces/pieces-framework": {
      "version": "0.32.0",
      "note": "Type definitions and the stub pieces in tests. Not loaded by the piece host at runtime (piece-trello bundles its own copy)."
    }
  },
  "reviewedLicenseExceptions": [
    {
      "package": "@activepieces/piece-trello",
      "version": "0.6.0",
      "concludedLicense": "MIT",
      "note": "package.json has no license field and the tarball has no LICENSE file. Source lives in packages/pieces/community/trello of github.com/activepieces/activepieces, outside the commercially licensed packages/ee and packages/server/api/src/app/ee; the root LICENSE grants MIT for it. The bundle inlines MIT third-party code (axios, mime-types, dayjs, ipaddr.js). No ee DTOs appear in the bundle.",
      "reviewedOn": "2026-09-18"
    },
    {
      "package": "@activepieces/piece-todoist",
      "version": "0.5.0",
      "concludedLicense": "MIT",
      "note": "package.json has no license field and the tarball has no LICENSE file. Source lives in packages/pieces/community/todoist of github.com/activepieces/activepieces, outside the commercially licensed packages/ee and packages/server/api/src/app/ee; the root LICENSE grants MIT for it. The bundle inlines MIT third-party code (mime-types, dayjs, ipaddr.js, form-data). No ee paths appear in the bundle.",
      "reviewedOn": "2026-09-18"
    },
    {
      "package": "@activepieces/pieces-framework",
      "version": "0.32.0",
      "concludedLicense": "MIT",
      "note": "No license field or LICENSE file. Source: packages/pieces/framework (MIT under the root LICENSE).",
      "reviewedOn": "2026-09-18"
    },
    {
      "package": "@activepieces/shared",
      "version": "0.95.1",
      "concludedLicense": "MIT",
      "note": "Transitive via pieces-framework. No license field or LICENSE file. Source: packages/shared (MIT under the root LICENSE).",
      "reviewedOn": "2026-09-18"
    },
    {
      "package": "@activepieces/pieces-common",
      "version": "0.12.5",
      "concludedLicense": "MIT",
      "note": "Not a dependency today; listed so adding it does not skip review. Source: packages/pieces/common (MIT under the root LICENSE).",
      "reviewedOn": "2026-09-18"
    }
  ],
  "reviewedPathExceptions": [
    {
      "package": "@activepieces/shared",
      "version": "0.95.1",
      "pathPrefix": "src/lib/ee/",
      "note": "Type/DTO modules compiled from packages/shared/src/lib/ee. The root LICENSE reserves only packages/ee/ and packages/server/api/src/app/ee/, so these are MIT, but the name is flagged so every version bump is re-reviewed.",
      "reviewedOn": "2026-09-18"
    }
  ]
}
// END ALLOWLIST DATA

export type PieceTarget =
  | { type: 'action'; name: string }
  | { type: 'trigger'; name: string; hook: 'onEnable' | 'onDisable' | 'run' | 'test' }

/**
 * Returns the allowlist entry for `target` in `pieceName@version`, or throws
 * PieceNotAllowedError. Used by both the main-side client and the host.
 */
export function resolveAllowedOperation(
  pieceName: string,
  version: string,
  target: PieceTarget,
  allowlist: ConnectorPieceAllowlist = CONNECTOR_PIECE_ALLOWLIST
): AllowedPieceOperation {
  const piece = Object.prototype.hasOwnProperty.call(allowlist.pieces, pieceName) ? allowlist.pieces[pieceName] : undefined
  if (!piece) throw new PieceNotAllowedError(pieceName, 'package is not in the connector allowlist')
  if (piece.version !== version) {
    throw new PieceNotAllowedError(pieceName, `version ${version} is not the pinned version ${piece.version}`)
  }
  const table: Record<string, AllowedPieceOperation> = target.type === 'action' ? piece.actions : piece.triggers
  const entry = Object.prototype.hasOwnProperty.call(table, target.name) ? table[target.name] : undefined
  if (!entry) throw new PieceNotAllowedError(pieceName, `${target.type} "${target.name}" is not allowlisted`)
  return entry
}

export function getAllowedPiece(
  pieceName: string,
  allowlist: ConnectorPieceAllowlist = CONNECTOR_PIECE_ALLOWLIST
): AllowedPiece | undefined {
  return Object.prototype.hasOwnProperty.call(allowlist.pieces, pieceName) ? allowlist.pieces[pieceName] : undefined
}
