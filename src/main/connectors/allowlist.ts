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

export interface AllowedPiece {
  /** Exact version; package.json must pin the same string. */
  version: string
  /** Named export holding the Piece object. */
  exportName: string
  actions: Record<string, AllowedPieceOperation>
  triggers: Record<string, AllowedPieceTrigger>
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
