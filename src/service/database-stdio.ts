/** Checked packaged bootstrap imports this entry only after native containment checks. */
for (const method of ['log', 'info', 'debug', 'warn', 'error'] as const) {
  console[method] = () => { process.stderr.write('[database-service] dependency diagnostic redacted\n') }
}

// Import domain/native-addon modules only after stdout diagnostics are diverted.
void import('./database-service').then(({ startDatabaseStdio }) => startDatabaseStdio()).catch(() => {
  process.stderr.write('[database-service] startup failed\n')
  process.exitCode = 1
  process.stdin.destroy()
  process.stdout.destroy()
})
