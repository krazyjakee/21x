process.on('message', message => {
  if (message.kind !== 'invoke') return;
  process.send({ kind: 'result', id: message.id, ok: true, output: {
    executable: process.execPath, version: process.version,
    electron: Boolean(process.versions.electron),
    systemNodeHidden: process.env.PATH === '',
    preloadsAbsent: process.env.NODE_OPTIONS === undefined,
    secretsAbsent: process.env.OPENAI_API_KEY === undefined,
    electronModeAbsent: !Object.keys(process.env).some(key => key.toUpperCase() === 'ELECTRON_RUN_AS_NODE'),
    bytes: message.invocation.propsValue.bytes
  }});
});
process.once('disconnect', () => process.exit(0));
process.send({ kind: 'ready' });
