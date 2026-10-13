/** Compile-selected fixed diagnostic; exports Boolean metadata only. */
(configuration => {
  const result = { complete: false, phase: configuration.mode };
  window.__21X_ARTIFACT_PROOF__ = result;
  const native = window.__TAURI__;
  const nativeDenial = __21X_DENIAL_MATCHER__;
  result.transportAvailable = typeof native?.core?.invoke === 'function' && typeof native?.event?.listen === 'function';
  const commands = {
    desktop: () => native.core.invoke('desktop_invoke', { operation: 'db:getTasks', payload: {}, engineEpoch: configuration.engineEpoch }),
    status: () => native.core.invoke('engine_status', {}),
    listen: () => native.event.listen('desktop:event', event => {
      if (event.payload?.engineEpoch === configuration.engineEpoch && event.payload?.operation === 'task:created' &&
          event.payload?.payload?.task?.title === 'Artifact isolation canary') result.eventReceived = true;
    })
  };
  async function denied(command) {
    result.attempt = command;
    let timeout;
    try { const value = await Promise.race([commands[command](), new Promise((_, reject) => {
      timeout = setTimeout(() => reject({ code: 'PROOF_DEADLINE' }), 2000);
    })]); if (typeof value === 'function') value(); return false; }
    catch (error) {
      // Accept only recognized native authorization errors, never absence,
      // malformed arguments, unknown commands, generic failure or timeout.
      if (error?.code === 'PROOF_DEADLINE') result.deadlineReached = true;
      return nativeDenial(error, command);
    } finally { clearTimeout(timeout); }
  }
  if (configuration.mode === 'main') {
    result.desktopAccepted = false; result.statusAccepted = false; result.listenAccepted = false; result.eventReceived = false;
    (async () => {
      if (!result.transportAvailable) return;
      const response = await commands.desktop();
      result.desktopAccepted = response?.engineEpoch === configuration.engineEpoch && response?.result?.defined === true;
      const status = await commands.status();
      result.statusAccepted = status?.engineEpoch === configuration.engineEpoch && status?.syntheticDesktop === true;
      window.__21X_ARTIFACT_PROOF_UNLISTEN__ = await commands.listen();
      result.listenAccepted = typeof window.__21X_ARTIFACT_PROOF_UNLISTEN__ === 'function';
    })().catch(() => {}).finally(() => { result.complete = true; });
  } else if (configuration.mode === 'excluded') {
    result.desktopDenied = false; result.statusDenied = false; result.listenDenied = false;
    (async () => {
      if (!result.transportAvailable) return;
      result.desktopDenied = await denied('desktop');
      result.statusDenied = await denied('status');
      result.listenDenied = await denied('listen');
    })().catch(() => {}).finally(() => { result.complete = true; });
  } else if (configuration.mode === 'frame') {
    const frame = document.querySelector('#hostile-artifact');
    result.frameLoaded = false;
    const receive = async event => {
      if (event.source !== frame?.contentWindow || !event.data || typeof event.data !== 'object') return;
      if (event.data.kind === 'artifact-attempt' && Object.hasOwn(commands, event.data.command)) {
        const authorized = result.transportAvailable ? await denied(event.data.command) : false;
        event.source.postMessage({ kind: 'artifact-result', command: event.data.command, denied: authorized }, '*');
      } else if (event.data.kind === 'artifact-complete') {
        const names = ['parentAccessDenied', 'parentGlobalDenied', 'frameBridgeAbsent', 'opaqueOrigin', 'crossOriginProtocolDocument',
          'relayDesktopDenied', 'relayStatusDenied', 'relayListenDenied',
          'directAttempted', 'directDesktopDenied', 'directStatusDenied', 'directListenDenied',
          'directDeadlineReached', 'directUnrecognizedFailure', 'directAccepted',
          'internalInvokeAvailable', 'internalIpcAvailable', 'directTypeError', 'directStringError', 'directSecurityError',
          'directInvalidOrigin', 'directMissingOrigin',
          'directDesktopOriginRejected', 'directStatusOriginRejected', 'directListenOriginRejected'];
        if (Object.keys(event.data).length !== names.length + 1 || !names.every(key => typeof event.data[key] === 'boolean')) return;
        for (const key of names) result[key] = event.data[key];
        result.frameLoaded = true;
        result.complete = true;
        clearInterval(start);
        window.removeEventListener('message', receive);
      }
    };
    window.addEventListener('message', receive);
    const start = setInterval(() => {
      frame?.contentWindow?.postMessage({ kind: 'artifact-start', engineEpoch: configuration.engineEpoch }, '*');
    }, 50);
    setTimeout(() => { clearInterval(start); window.removeEventListener('message', receive); }, 8000);
  }
})(__21X_PROOF_CONFIG__);
