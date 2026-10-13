/** Opaque sandbox frame: no same-origin, popups, navigation, downloads or native grants. */
(() => {
  let started = false;
  const report = { parentAccessDenied: false, parentGlobalDenied: false,
    frameBridgeAbsent: typeof window.__TAURI__?.core?.invoke !== 'function',
    relayDesktopDenied: false, relayStatusDenied: false, relayListenDenied: false,
    directAttempted: false, directDesktopDenied: false, directStatusDenied: false, directListenDenied: false,
    directDeadlineReached: false, directUnrecognizedFailure: false, directAccepted: false };
  const pending = new Set(['desktop', 'status', 'listen']);
  let directComplete = report.frameBridgeAbsent;
  const finish = () => {
    if (started && directComplete && !pending.size) parent.postMessage({ kind: 'artifact-complete', ...report }, '*');
  };
  async function direct(epoch) {
    const native = window.__TAURI__;
    if (report.frameBridgeAbsent) return;
    report.directAttempted = typeof native?.core?.invoke === 'function' && typeof native?.event?.listen === 'function';
    if (!report.directAttempted) { directComplete = true; finish(); return; }
    const commands = [
      ['directDesktopDenied', () => native.core.invoke('desktop_invoke', { operation: 'db:getTasks', payload: {}, engineEpoch: epoch })],
      ['directStatusDenied', () => native.core.invoke('engine_status', {})],
      ['directListenDenied', () => native.event.listen('desktop:event', () => {})]
    ];
    for (const [key, command] of commands) {
      let timeout;
      try {
        const value = await Promise.race([command(), new Promise((_, reject) => {
          timeout = setTimeout(() => reject({ code: 'PROOF_DEADLINE' }), 2000);
        })]);
        if (typeof value === 'function') value();
        report.directAccepted = true;
      } catch (error) {
        report[key] = error?.code === 'UNAUTHORIZED' || typeof error === 'string' && /not allowed|not authorized|denied/i.test(error);
        if (error?.code === 'PROOF_DEADLINE') report.directDeadlineReached = true;
        else if (!report[key]) report.directUnrecognizedFailure = true;
      } finally { clearTimeout(timeout); }
    }
    directComplete = true;
    finish();
  }
  window.addEventListener('message', event => {
    if (event.source !== parent || !event.data || typeof event.data !== 'object') return;
    if (event.data.kind === 'artifact-start' && !started) {
      started = true;
      try { void parent.document.body; } catch { report.parentAccessDenied = true; }
      try { void parent.__TAURI__; } catch { report.parentGlobalDenied = true; }
      for (const command of pending) parent.postMessage({ kind: 'artifact-attempt', command }, '*');
      void direct(event.data.engineEpoch);
    } else if (event.data.kind === 'artifact-result' && pending.delete(event.data.command)) {
      const key = { desktop: 'relayDesktopDenied', status: 'relayStatusDenied', listen: 'relayListenDenied' }[event.data.command];
      report[key] = event.data.denied === true;
      finish();
    }
  });
})();
