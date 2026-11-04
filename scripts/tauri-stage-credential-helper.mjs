/** Build and stage the protected-key-store helper for the production closure. */
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { constants } from 'node:fs'
import { copyFile, lstat, mkdir, readFile, realpath, rename, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..')

async function physicalDirectory(path, create = false) {
  if (create) {
    try { await mkdir(path) }
    catch (error) { if (error.code !== 'EEXIST') throw error }
  }
  const details = await lstat(path)
  if (!details.isDirectory() || details.isSymbolicLink()) throw new Error(`Credential helper directory must be physical: ${path}`)
}

async function physicalFile(path) {
  const details = await lstat(path)
  if (!details.isFile() || details.isSymbolicLink()) throw new Error(`Credential helper must be a physical regular file: ${path}`)
}

export async function stageCredentialHelper({ projectRoot = repository, platform = process.platform, cargo = 'cargo', run = spawnSync } = {}) {
  projectRoot = await realpath(projectRoot)
  const tauri = join(projectRoot, 'src-tauri')
  const credentials = join(tauri, 'credentials')
  const target = join(tauri, 'target')
  const resources = join(tauri, 'resources')
  const native = join(resources, 'native')
  const name = `twentyonex-credential-key${platform === 'win32' ? '.exe' : ''}`
  const source = join(target, 'release', name)
  const destination = join(native, name)
  await physicalDirectory(tauri)
  await physicalDirectory(credentials)
  await physicalDirectory(resources, true)
  await physicalDirectory(native, true)
  try { await physicalFile(destination) }
  catch (error) { if (error.code !== 'ENOENT') throw error }

  const built = run(cargo, ['build', '--locked', '--release', '--bin', 'twentyonex-credential-key', '--target-dir', target], {
    cwd: credentials, stdio: 'inherit'
  })
  if (built.error || built.status !== 0) throw new Error(`Credential helper cargo --locked build failed${built.error ? `: ${built.error.message}` : ''}`)
  await physicalDirectory(target)
  await physicalDirectory(join(target, 'release'))
  await physicalFile(source)
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`
  try {
    await copyFile(source, temporary, constants.COPYFILE_EXCL)
    await physicalFile(temporary)
    // A repeated build leaves the staged file intact; a changed build replaces it.
    try {
      await physicalFile(destination)
      if ((await readFile(destination)).equals(await readFile(temporary))) return { path: destination, changed: false }
    } catch (error) { if (error.code !== 'ENOENT') throw error }
    await rename(temporary, destination)
    await physicalFile(destination)
    return { path: destination, changed: true }
  } finally { await rm(temporary, { force: true }) }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(await stageCredentialHelper(), null, 2)) }
  catch (error) { console.error(error.message); process.exitCode = 1 }
}
