# Live voice in the Tauri preview

Voice control and spoken answers now work in the Tauri production preview the
same way they work in Electron. The window captures the microphone and plays
speech. The service runs recognition, the intent parser, task actions and
speech synthesis through the same `VoiceSessionManagerCore` that Electron uses.
Earlier documents in this folder ([management bindings](voice-management-bindings.md),
[native authority](voice-native-authority.md), [transcript actions](voice-transcript-actions.md))
describe the unavailable state this replaces.

## Microphone

The WebView captures the microphone, as Chromium does in Electron. Recognition
needs no native capture code, and the input device picker, level meter and
Commander call mode keep working.

- `src-tauri/src/native_media.rs` turns on WebKitGTK's media stream (getUserMedia)
  before the first application script. WebRTC stays off.
- The main window's permission handler (`native_media::permission`) allows
  `Microphone` only, and only after the window has navigated to the trusted
  application page. Camera and screen capture are refused. A combined camera and
  microphone request is refused as a whole. Other windows deny everything.
- The production CSP is `script-src 'self'`, which refuses an AudioWorklet loaded
  from a `blob:` URL. The capture worklet is therefore a bundled same-origin file
  (`src/renderer/src/lib/voice-pcm-worklet.js`, imported with `?url`).
- There is no separate OS permission prompt to report on Linux or Windows, so
  `voice:getPermission` stays unbound. The window treats an unbound permission
  operation as `unsupported`, which is what Electron reports on those systems.
  On macOS, WKWebView shows its own prompt when capture starts.

Checked on Linux (WebKitGTK 2.52, Xvfb, mock capture devices): with the strict
CSP, an audio-only permission request reaches the handler. The worklet then
loads from the page's origin, and a 16 kHz `AudioContext` receives about 16,000
samples a second.

Checked end to end in the preview on Linux (X11, WebKitGTK 2.52) with the
Electron profile's runtime (sherpa-onnx-node 1.13.8) and Parakeet v3 model copied
into the profile. Settings showed the runtime and model, and voice switched on.
The top-bar microphone opened a turn ("Listening"), and PulseAudio showed a live
WebKitWebProcess record stream. Ending the turn returned the recogniser's
outcome ("Nothing was heard." in a quiet room) and released the microphone.
Recognising spoken words was not exercised in this check.

## Operations and events

`src/shared/voice-turn-codecs.ts` defines the wire format. `production_voice_turns.rs`
mirrors it in the native host, and `src/service/voice-turn-backend.ts` binds it to
the session manager.

| Commands | Events |
| --- | --- |
| `voice:startTurn`, `voice:pushAudio`, `voice:endTurn`, `voice:cancelTurn` | `voice:state`, `voice:partial`, `voice:segment`, `voice:final` |
| `voice:confirm`, `voice:dismiss` | `voice:outcome`, `voice:error`, `voice:navigate`, `voice:dictate` |
| `voice:expectAnswer`, `voice:answerNotExpected` | `voice:speech:start`, `voice:speech:chunk`, `voice:speech:end` |
| `voice:tts:preview`, `voice:tts:speak`, `voice:tts:stop` | `voice:hotkey` (declared; no producer yet) |
| `voice:commander:setActive`, `voice:commander:bargeIn`, `voice:commander:send` | |

- Microphone audio and speech chunks cross as base64 16-bit PCM. A push is about
  100 ms (3,200 bytes) and is capped at 64 KiB; a speech chunk is capped at 128 KiB.
- `voice:startTurn` keeps only the context fields main reads (selected task,
  view, pending approval, visible tasks).
- Event encoders shorten long text and drop unknown keys instead of failing. A
  failed event encoding would disconnect the window.
- Voice events go only to the trusted desktop window. They never reach mobile clients.

## Service owners

`createProductionVoiceOwner` (`src/service/production-voice-owner.ts`):

- **Actions**: spoken commands run through `VoiceActionService` on the profile's
  database and `AgentManager`, as in Electron, and emit the canonical
  `task:created` and `task:updated` events.
- **Speech**: speech audio plays in the desktop window. The system voice is offered when
  `espeak-ng` (Linux), `say` (macOS) or `powershell.exe` (Windows) is on PATH.
  Workers receive PATH so the speech worker can run it. ElevenLabs stays off (#92).
- **Agent answers**: `watchAgentAnswersForSpeech`, now in the Electron-free
  `voice-answer-watch.ts`, reads an answer aloud when the question was spoken.
- **Runtime install**: the runtime installs with npm. The service runs the npm CLI
  found on PATH under the bundled Node. If there is none, it runs the `npm` on PATH.
- **Commander voice mode** is built from the live Commander service on first use.
- **Start-up**: `initialize()` runs once at start-up. It loads the runtime status and the
  speech engine and, when voice is on, the recognition model.

Management status, error text and install output now reach Settings as written
(shortened to 4 KiB, or 16 KiB for install output), instead of two fixed
messages. The runtime module path is still replaced by a marker.
Voice installs (`voice:installRuntime`, `voice:installModel`, `voice:tts:installModel`)
get a 21-minute request deadline in the service, client and native host, beyond
the owners' own 20-minute download deadline.

## Not done yet

Settings hides the global shortcut and custom model folder controls while the
host cannot perform them, instead of offering buttons that fail.

- **Global shortcut** (`voice:setShortcut`, `voice:hotkey`): needs a native
  registration owned by the host. The in-window push-to-talk and buttons work.
- **Custom model folder** (`voice:setCustomModelDir`, `voice:pickModelDir`):
  needs the native folder picker.
- **Hosted speech** (ElevenLabs, #92): deferred by the user.
- **Platforms**: only Linux has been exercised. `src-tauri/Info.plist` adds the
  macOS `NSMicrophoneUsageDescription` that WKWebView needs; macOS and Windows
  capture have not been run.
