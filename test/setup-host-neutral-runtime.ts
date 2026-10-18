import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertHostNeutralRuntime } from '../scripts/host-neutral-runtime.mjs'

assertHostNeutralRuntime(resolve(dirname(fileURLToPath(import.meta.url)), '..'))
