import { useEffect, useId, useSyncExternalStore } from 'react'

/**
 * Motion ownership (#95): at most one moving indicator per region, and one
 * per entity across every region that mirrors it.
 *
 * An indicator that wants to move claims its region and entity. The earliest
 * claim still wanting motion owns both; everything else renders static. When
 * the owner stops wanting motion or unmounts, the next claimant takes over.
 * Nothing moves while the document is hidden.
 */

interface Claim {
  token: string
  region: string
  entity: string
}

let claims: Claim[] = []
let version = 0
const listeners = new Set<() => void>()

function emit(): void {
  version += 1
  for (const l of listeners) l()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function getVersion(): number {
  return version
}

export function claimMotion(token: string, region: string, entity: string): void {
  if (claims.some((c) => c.token === token && c.region === region && c.entity === entity)) return
  claims = [...claims.filter((c) => c.token !== token), { token, region, entity }]
  emit()
}

export function releaseMotion(token: string): void {
  if (!claims.some((c) => c.token === token)) return
  claims = claims.filter((c) => c.token !== token)
  emit()
}

/** True when `token` owns both its region and its entity. */
export function ownsMotion(token: string): boolean {
  const mine = claims.find((c) => c.token === token)
  if (!mine) return false
  const regionOwner = claims.find((c) => c.region === mine.region)
  const entityOwner = claims.find((c) => c.entity === mine.entity)
  return regionOwner?.token === token && entityOwner?.token === token
}

/** Test-only reset. */
export function __resetMotionOwners(): void {
  claims = []
  emit()
}

let visibilityListening = false
function ensureVisibilityListener(): void {
  if (visibilityListening || typeof document === 'undefined') return
  visibilityListening = true
  document.addEventListener('visibilitychange', emit)
}

function documentVisible(): boolean {
  return typeof document === 'undefined' || document.visibilityState !== 'hidden'
}

/**
 * Claims motion for this indicator while `wants` is true. Returns whether it
 * may animate right now.
 */
export function useMotionOwner(region: string, entity: string, wants: boolean): boolean {
  const token = useId()
  useSyncExternalStore(subscribe, getVersion, getVersion)
  useEffect(() => {
    ensureVisibilityListener()
    if (wants) claimMotion(token, region, entity)
    else releaseMotion(token)
    return () => releaseMotion(token)
  }, [token, region, entity, wants])
  return wants && documentVisible() && ownsMotion(token)
}
