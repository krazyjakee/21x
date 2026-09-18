/**
 * electron-builder `mac.sign` hook for unsigned releases (issue #26).
 *
 * Releases from this repository are built without an Apple Developer ID, and
 * Apple Silicon refuses to run code with no signature at all. An ad-hoc
 * signature ("-") satisfies that without a certificate. Gatekeeper still
 * treats the app as unidentified, so users open it once with right-click, then
 * Open. Signed builds (docs/macos-signing-notarization.md) do not use this hook.
 */

const { execFileSync } = require('child_process')

module.exports = async function adhocSign(options) {
  const app = options.app
  console.log(`[adhoc-sign] codesign --force --deep --sign - ${app}`)
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' })
}
