/** Opaque sandbox frame: no same-origin, popups, navigation, downloads or native grants. */
(() => {
  let started = false;
  const report = { parentAccessDenied: false, parentGlobalDenied: false,
    frameBridgeAbsent: typeof window.__TAURI__?.core?.invoke !== 'function',
    relayDesktopDenied: false, relayStatusDenied: false, relayListenDenied: false };
  const pending = new Set(['desktop', 'status', 'listen']);
  window.addEventListener('message', event => {
    if (event.source !== parent || !event.data || typeof event.data !== 'object') return;
    if (event.data.kind === 'artifact-start' && !started) {
      started = true;
      try { void parent.document.body; } catch { report.parentAccessDenied = true; }
      try { void parent.__TAURI__; } catch { report.parentGlobalDenied = true; }
      for (const command of pending) parent.postMessage({ kind: 'artifact-attempt', command }, '*');
    } else if (event.data.kind === 'artifact-result' && pending.delete(event.data.command)) {
      const key = { desktop: 'relayDesktopDenied', status: 'relayStatusDenied', listen: 'relayListenDenied' }[event.data.command];
      report[key] = event.data.denied === true;
      if (!pending.size) parent.postMessage({ kind: 'artifact-complete', ...report }, '*');
    }
  });
})();
