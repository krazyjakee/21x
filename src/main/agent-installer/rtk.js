import { detectInstalledAgents } from './detect.js'
import { fail, finish, streamProcess } from './installer-utils.js'
import { getRtkInitPlans } from './rtk-integrations.js'

export { detectRtkIntegrations, getRtkInitPlans, RTK_INTEGRATIONS } from './rtk-integrations.js'

/** Configure RTK's native hook/plugin for every installed 21x backend. */
export async function configureRtk(onProgress, options = {}) {
  const detect = options.detect || detectInstalledAgents
  const run = options.run || streamProcess
  const status = options.status || await detect()
  const plans = getRtkInitPlans(status)

  if (plans.length === 0) {
    return finish(
      onProgress,
      { success: true, error: null },
      'RTK installed. Install a coding agent, then run RTK setup again to enable output compression.\n'
    )
  }

  const failures = []
  for (let index = 0; index < plans.length; index++) {
    const plan = plans[index]
    const percent = 70 + Math.round(((index + 1) / plans.length) * 25)
    onProgress({
      stage: 'installing',
      output: `Configuring RTK for ${plan.label}...\n`,
      percent
    })
    const result = await run('rtk', plan.args, onProgress, percent, {
      shell: process.platform === 'win32',
      windowsHide: true,
      env: { ...process.env, RTK_TELEMETRY_DISABLED: '1' }
    })
    if (result.error || result.code !== 0) {
      failures.push(`${plan.label}: ${result.error?.message || `exit code ${result.code}`}`)
    }
  }

  if (failures.length > 0) {
    return fail(`RTK setup failed for ${failures.join('; ')}`, onProgress)
  }

  return finish(
    onProgress,
    { success: true, error: null },
    `RTK configured for ${plans.map((plan) => plan.label).join(', ')}. Restart active agent sessions to use it.\n`
  )
}
