#!/usr/bin/env node
/**
 * Supply-chain gate for embedded connector pieces (issue #18,
 * docs/connectors-security.md). Engineering control, not legal advice.
 *
 * Fails when:
 *  - an @activepieces/* dependency in package.json is not in the allowlist
 *    (src/main/connectors/allowlist.ts) or is not pinned to the exact
 *    allowlisted version (no ^, ~, ranges, tags or URLs);
 *  - an allowlisted piece is not a dependency, or is installed at another version;
 *  - any package in the installed dependency closure of an allowlisted package
 *    has a license outside `allowedLicenses`, or no license at all without a
 *    reviewed exception for that exact name@version;
 *  - an @activepieces/* package in that closure ships files under a
 *    commercially licensed upstream path (`commercialPathPatterns`) or under any
 *    `ee/` directory that has no reviewed path exception.
 *
 * Run after `pnpm install`: it reads the installed node_modules tree.
 *   node scripts/check-connector-pieces.mjs
 */
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ALLOWLIST_FILE = join(ROOT, 'src/main/connectors/allowlist.ts')
const SCOPE = '@activepieces/'
const EXACT_VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/

/** Extracts the strict-JSON allowlist between the ALLOWLIST DATA markers. */
export function parseAllowlistSource(source) {
  const start = source.indexOf('// BEGIN ALLOWLIST DATA')
  const end = source.indexOf('// END ALLOWLIST DATA')
  if (start < 0 || end < 0 || end < start) throw new Error('allowlist.ts: ALLOWLIST DATA markers not found')
  const block = source.slice(start, end)
  const open = block.indexOf('{')
  const close = block.lastIndexOf('}')
  if (open < 0 || close < 0) throw new Error('allowlist.ts: no object literal between the markers')
  try {
    return JSON.parse(block.slice(open, close + 1))
  } catch (err) {
    throw new Error(`allowlist.ts: the ALLOWLIST DATA block must be strict JSON (${err.message})`)
  }
}

/**
 * Evaluates an SPDX expression against the allowed ids. OR needs one allowed
 * side, AND needs both. `WITH` exceptions are judged by their base license.
 */
export function isLicenseAllowed(expression, allowed) {
  if (typeof expression !== 'string' || !expression.trim()) return false
  const tokens = expression.replace(/[()]/g, (p) => ` ${p} `).trim().split(/\s+/)
  let i = 0
  const parseOr = () => {
    let value = parseAnd()
    while (tokens[i] && tokens[i].toUpperCase() === 'OR') {
      i++
      const rhs = parseAnd()
      value = value || rhs
    }
    return value
  }
  const parseAnd = () => {
    let value = parseAtom()
    while (tokens[i] && tokens[i].toUpperCase() === 'AND') {
      i++
      const rhs = parseAtom()
      value = value && rhs
    }
    return value
  }
  const parseAtom = () => {
    const token = tokens[i++]
    if (token === '(') {
      const value = parseOr()
      i++ // ')'
      return value
    }
    if (tokens[i] && tokens[i].toUpperCase() === 'WITH') i += 2
    return allowed.includes(String(token).replace(/\+$/, ''))
  }
  try {
    return parseOr()
  } catch {
    return false
  }
}

/** The declared license of a package.json, normalised to one SPDX expression, or null. */
export function declaredLicense(pkg) {
  if (typeof pkg.license === 'string' && pkg.license.trim()) return pkg.license.trim()
  if (pkg.license && typeof pkg.license.type === 'string') return pkg.license.type
  if (Array.isArray(pkg.licenses) && pkg.licenses.length) {
    const ids = pkg.licenses.map((l) => (typeof l === 'string' ? l : l && l.type)).filter(Boolean)
    if (ids.length) return ids.length === 1 ? ids[0] : `(${ids.join(' OR ')})`
  }
  return null
}

/** Checks the package.json dependency pins against the allowlist. Returns error strings. */
export function checkPins(pkgJson, allowlist) {
  const errors = []
  const allowed = { ...allowlist.packages, ...allowlist.pieces }
  const sections = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']
  const seen = new Set()
  for (const section of sections) {
    for (const [name, spec] of Object.entries(pkgJson[section] ?? {})) {
      if (!name.startsWith(SCOPE)) continue
      seen.add(name)
      const entry = Object.prototype.hasOwnProperty.call(allowed, name) ? allowed[name] : undefined
      if (!entry) {
        errors.push(`${name} (${section}) is not in the connector allowlist`)
        continue
      }
      if (!EXACT_VERSION.test(String(spec))) {
        errors.push(`${name} (${section}) must be pinned to an exact version, found "${spec}"`)
      } else if (spec !== entry.version) {
        errors.push(`${name} (${section}) is pinned to ${spec} but the allowlist says ${entry.version}`)
      }
    }
  }
  for (const name of Object.keys(allowlist.pieces)) {
    if (!seen.has(name)) errors.push(`allowlisted piece ${name} is not a dependency in package.json`)
  }
  return errors
}

/** Finds `name` as Node would from `fromDir`: walks up through node_modules directories. */
function findPackageDir(name, fromDir) {
  let dir = fromDir
  for (;;) {
    const candidate = join(dir, 'node_modules', name)
    if (existsSync(join(candidate, 'package.json'))) return realpathSync(candidate)
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

function listFiles(dir, base = dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules') continue
    const full = join(dir, entry)
    const st = statSync(full)
    if (st.isDirectory()) listFiles(full, base, out)
    else out.push(relative(base, full).split(sep).join('/'))
  }
  return out
}

/** Walks the installed dependency closure of the allowlisted packages and checks licenses and paths. */
export function checkInstalledTree(allowlist, rootDir) {
  const errors = []
  const notes = []
  const roots = { ...allowlist.packages, ...allowlist.pieces }
  const commercial = (allowlist.commercialPathPatterns ?? []).map((p) => new RegExp(p))
  const visited = new Map()
  const queue = []

  for (const [name, entry] of Object.entries(roots)) {
    const dir = findPackageDir(name, rootDir)
    if (!dir) {
      errors.push(`${name} is allowlisted but not installed (run pnpm install and update pnpm-lock.yaml)`)
      continue
    }
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    if (pkg.version !== entry.version) {
      errors.push(`${name} is installed at ${pkg.version} but the allowlist pins ${entry.version}`)
    }
    queue.push({ dir, via: name })
  }

  while (queue.length) {
    const { dir, via } = queue.shift()
    if (visited.has(dir)) continue
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    const id = `${pkg.name}@${pkg.version}`
    visited.set(dir, id)

    const license = declaredLicense(pkg)
    const exception = (allowlist.reviewedLicenseExceptions ?? []).find(
      (e) => e.package === pkg.name && e.version === pkg.version
    )
    if (license) {
      if (!isLicenseAllowed(license, allowlist.allowedLicenses)) {
        errors.push(`${id} (via ${via}) has license "${license}", which is not allowed`)
      }
    } else if (!exception) {
      errors.push(`${id} (via ${via}) declares no license and has no reviewed exception in allowlist.ts`)
    } else if (!isLicenseAllowed(exception.concludedLicense, allowlist.allowedLicenses)) {
      errors.push(`${id}: reviewed exception concludes "${exception.concludedLicense}", which is not allowed`)
    } else {
      notes.push(`${id}: no declared license; reviewed exception (${exception.concludedLicense}) applies`)
    }

    if (pkg.name.startsWith(SCOPE)) {
      const pathExceptions = (allowlist.reviewedPathExceptions ?? []).filter(
        (e) => e.package === pkg.name && e.version === pkg.version
      )
      const flagged = new Set()
      for (const file of listFiles(dir)) {
        if (commercial.some((re) => re.test(file))) {
          errors.push(`${id} ships ${file}, which matches a commercially licensed upstream path`)
          continue
        }
        if (/(^|\/)ee\//.test(file) && !pathExceptions.some((e) => file.startsWith(e.pathPrefix))) {
          const dirName = file.slice(0, file.search(/(^|\/)ee\//) + (file.startsWith('ee/') ? 3 : 4))
          if (!flagged.has(dirName)) {
            flagged.add(dirName)
            errors.push(`${id} ships files under ${dirName} with no reviewed path exception`)
          }
        }
      }
    }

    for (const [dep, section] of [
      ...Object.keys(pkg.dependencies ?? {}).map((d) => [d, 'dependencies']),
      ...Object.keys(pkg.optionalDependencies ?? {}).map((d) => [d, 'optionalDependencies'])
    ]) {
      const depDir = findPackageDir(dep, dir)
      if (!depDir) {
        if (section === 'dependencies') errors.push(`${id} depends on ${dep}, which is not installed`)
        continue
      }
      queue.push({ dir: depDir, via })
    }
  }
  return { errors, notes, packages: [...new Set(visited.values())].sort() }
}

function main() {
  const allowlist = parseAllowlistSource(readFileSync(ALLOWLIST_FILE, 'utf8'))
  const pkgJson = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  const errors = checkPins(pkgJson, allowlist)
  const tree = checkInstalledTree(allowlist, ROOT)
  errors.push(...tree.errors)

  console.log(`Connector piece check: ${tree.packages.length} packages in the allowlisted closure`)
  for (const note of tree.notes) console.log(`  note: ${note}`)
  if (errors.length) {
    console.error(`\nConnector piece check failed (${errors.length}):`)
    for (const e of errors) console.error(`  - ${e}`)
    console.error('\nSee docs/connectors-security.md for how to add or update a piece.')
    process.exit(1)
  }
  console.log('Connector piece check passed.')
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main()
}
