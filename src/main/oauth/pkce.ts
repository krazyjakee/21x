import { createHash, randomBytes } from 'crypto'

/**
 * PKCE (RFC 7636) code verifier + S256 challenge. The same construction
 * OAuthManager uses for its providers; exported so other flows (the
 * connector OAuth2 flow) build identical pairs.
 */
export interface PkcePair {
  verifier: string
  challenge: string
}

export function generatePkce(): PkcePair {
  // 32 random bytes -> 43 base64url characters, inside the 43..128 range.
  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}

/** The S256 challenge for a verifier; used by fake providers in tests. */
export function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url')
}
