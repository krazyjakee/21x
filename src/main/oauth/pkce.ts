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
