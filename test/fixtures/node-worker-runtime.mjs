/** Synthetic real-file IPC control, never a packaged worker entry. */
if (!process.send || !process.connected) process.exit(1)
process.once('message', value => {
  if (!value || Object.keys(value).length !== 1 || value.ping !== true) process.exit(2)
  process.send({ nodeVersion: process.version, executable: process.execPath,
    electron: Boolean(process.versions.electron), electronMode: Object.keys(process.env).some(name => name.toUpperCase() === 'ELECTRON_RUN_AS_NODE'),
    systemNodeHidden: process.env.PATH === '', pong: true
  }, () => process.disconnect())
})
