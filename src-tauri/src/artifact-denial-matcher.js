(error, command) => {
  if (error?.code === 'UNAUTHORIZED') return true;
  if (typeof error !== 'string') return false;
  const names = { desktop: ['desktop_invoke', 'desktop_invoke'],
    status: ['engine_status', 'engine_status'], listen: ['plugin:event|listen', 'event.listen'] };
  const namesForCommand = names[command];
  if (!namesForCommand) return false;
  const [raw, pretty] = namesForCommand;
  // Exact pinned Tauri release/debug ACL formats. A missing command/plugin,
  // network denial or invalid Origin is not an authenticated ACL rejection.
  return error === `Command ${raw} not allowed by ACL` ||
    error.startsWith(`${pretty} not allowed on window "`) &&
      error.includes('\n\nallowed on: ') && error.includes('\n\nreferenced by: ') ||
    error.startsWith(`${pretty} explicitly denied on origin `) && error.includes('\n\nreferenced by: ');
}
