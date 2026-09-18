import type { LoadedPieceModule, PieceModuleLoader } from './host-runtime'

/**
 * Pieces bundled with this build. A static map, not a dynamic `require(name)`:
 * a piece loads only if it is listed here, pinned in package.json, and
 * allowlisted in ../allowlist.ts (the host checks all three). There is no
 * runtime `npm install` path.
 *
 * Plain `require` keeps the packages external to the Vite bundle; they ship in
 * the app's production node_modules.
 */
const BUNDLED_PIECES: Record<string, () => LoadedPieceModule> = {
  '@activepieces/piece-trello': () => ({
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    module: require('@activepieces/piece-trello') as Record<string, unknown>,
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    version: (require('@activepieces/piece-trello/package.json') as { version: string }).version
  })
}

export const loadBundledPiece: PieceModuleLoader = (pieceName) => {
  const load = Object.prototype.hasOwnProperty.call(BUNDLED_PIECES, pieceName) ? BUNDLED_PIECES[pieceName] : undefined
  return load ? load() : undefined
}
