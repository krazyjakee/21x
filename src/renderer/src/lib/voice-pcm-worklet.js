/**
 * Runs inside the audio thread for voice capture (voice-capture.ts). It only
 * converts float samples to 16-bit and reports a level, so it cannot stall the
 * user interface.
 *
 * A separate file, loaded as a same-origin asset, so a strict
 * `script-src 'self'` policy (the Tauri window) admits it.
 */
/* global AudioWorkletProcessor, registerProcessor */
class VoicePcmProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0]
    if (!channel) return true
    const samples = new Int16Array(channel.length)
    let sum = 0
    for (let i = 0; i < channel.length; i++) {
      const clamped = Math.max(-1, Math.min(1, channel[i]))
      samples[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff
      sum += clamped * clamped
    }
    this.port.postMessage(
      { samples, level: Math.sqrt(sum / channel.length) },
      [samples.buffer]
    )
    return true
  }
}
registerProcessor('voice-pcm', VoicePcmProcessor)
