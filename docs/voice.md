# Voice control (phase 1 — speech to text)

On macOS, the voice worker requires Node.js on PATH. Install Node.js from
Settings → General if it is missing.

Voice control lets a user dictate into 20x and run a small set of task commands
by speech. Speech recognition runs on the user's computer. No audio is stored,
and no audio leaves the device.

This document describes what is implemented. The blueprint is the research
subtask design (`design.md`, "FluidVoice and local voice integration
feasibility for 20x desktop"). Section numbers below refer to that document.

## What phase 1 contains

- An **optional** install of the local speech runtime, offered in the setup
  dialog and in Voice settings. Nothing voice-related is downloaded until the
  user asks for it, and every voice control stays hidden until it is present.
- Microphone capture in the renderer, with push-to-talk.
- A separate speech worker process with the local runtime.
- Live partial text and one final transcript for each turn.
- A closed set of task commands, each with a validation and a confirmation step.
- A voice surface in the app: audio state, transcript bubble, confirmation card.
- Voice settings: enable, permission state, model download (Parakeet v3),
  legacy-model clean-up, global shortcut.

## What phase 1 does not contain

There is no wake word, no cloud provider, and no microphone on mobile. Each one
is a later item in the design, and the contracts in `src/shared/voice.ts` leave
room for them.

Spoken answers were the other phase 1 exclusion. They are now implemented and
documented in [`voice-tts.md`](voice-tts.md). Both halves share one settings
page, **Settings → Voice**, split into what 20x hears and what 20x says. Each
half hides only its own tuning behind its own "Advanced options" disclosure. Speaking needs neither the
microphone nor the optional speech runtime, so it works on its own.

Commander adds a hands-free conversation surface on top of this local
recognition path: one click keeps the microphone open, sends each utterance
after a pause, and reads the streamed reply through the selected speech engine.
It still uses local speech recognition and has no wake word.

## Processes

```text
renderer
  getUserMedia + AudioWorklet -> 16 kHz mono 16-bit PCM
  mic button, transcript bubble, confirmation card
        │  voice:* IPC, about 100 ms of audio per message
        ▼
main process
  VoiceSessionManager   state machine, turn identity, shortcut, models
  VoiceIntentParser     closed intent union, deterministic rules
  VoiceActionService    target resolution, confirmation policy, execution
        │  control over Node IPC, audio over stdin
        ▼
voice worker (separate process)
  local runtime, streaming or offline recognition, partial and final text
```

| File | Role |
|---|---|
| `src/shared/voice.ts` | Contracts, state machine, channels, settings keys |
| `src/shared/voice-intent-parser.ts` | Deterministic parser and the schema guard |
| `src/main/voice/voice-session-manager.ts` | Session owner |
| `src/main/voice/voice-action-service.ts` | Target resolution and task actions |
| `src/main/voice/voice-model-manager.ts` | Download, checksum, delete |
| `src/main/voice/voice-model-manifest.ts` | Model catalogue |
| `src/main/voice/voice-runtime-installer.ts` | Optional install of the runtime |
| `src/main/voice/voice-worker-client.ts` | Worker lifecycle and audio pipe |
| `src/main/voice/voice-worker.js` | The worker itself (plain CommonJS) |
| `src/renderer/src/lib/voice-capture.ts` | Microphone capture |
| `src/renderer/src/lib/voice-dictation-target.ts` | The one field that receives words |
| `src/renderer/src/components/voice/TopBarVoiceButton.tsx` | Talk to Captain from any view |
| `src/renderer/src/hooks/use-recording-chrome.ts` | Turns the window frame red while recording |
| `src/shared/ui-commands.ts` | The UI command contract and the published screen |
| `src/renderer/src/lib/ui-remote-control.ts` | Applies one command; collects the screen |
| `src/renderer/src/hooks/use-ui-remote-control.ts` | Publishes the screen, receives commands |
| `src/renderer/src/stores/voice-store.ts` | Renderer state |
| `src/renderer/src/components/voice/*` | Microphone buttons, overlay, runtime row |

## Commands

| Speech | Action | Confirmation |
|---|---|---|
| "create a task to fix login" | `DatabaseManager.createTask` | Yes, unless quick create is on |
| "assign this to Codex" | `agent_id` update | Only when the name is not unique |
| "start this task" | `AgentManager.startTask` | Yes when no agent is assigned |
| "ask the agent why the test failed" | `AgentManager.sendByTaskId` | No |
| "approve" / "reject" | `AgentManager.respondToPermission` | Always |
| "open the dashboard" | Renderer navigation | No |
| "read the last answer" | Last assistant message, as text | No |
| "cancel" | Ends the turn | No |

The table above is the **built-in** parser. It is small on purpose: it is the
only path that acts without a language model, so every rule in it must be
unambiguous. The wider path is the next section.

**No control in the app runs these rules any more.** Every microphone dictates,
and the global shortcut talks to Captain like the one in the top bar. The
parser and `VoiceActionService` are still in the tree, and `command` mode still
works if something asks for it, but nothing does. They are the last of the
original design's hands-free command idea, kept only until it is decided whether
to delete them.

Why they went: the agent has the whole task-management tool set, so eight
phrases were both less capable and a way to be told "that is not one of the
spoken commands" for an ordinary sentence.

One click starts listening and a second click stops it. Escape cancels the turn
and keeps the words out.

### The conversational loop

This is the default in a task composer:

```text
click → listening → you speak → you pause
                        ↓
        end of turn detected (endpoint rule)
                        ↓
        sentence written into the box and sent
                        ↓
        still listening → you speak again → …
                        ↓
                click again to stop
```

The microphone stays open for the whole conversation. Each pause ends one
sentence, the sentence is sent at once, and the recogniser is reset for the
next one — all on the same audio stream, so nothing is missed between
sentences.

The pause length is the endpoint rule of the recogniser (`rule2`), set in
**Settings → Voice → A pause this long ends a sentence**: 0.8 s, 1.2 s
(default), or 2 s. Changing it reloads the model.

Guards:

- A conversation never runs the intent parser, exactly like dictation, so a
  spoken sentence can never execute a task action. This holds for the **tail**
  too — whatever was still being spoken when the turn was stopped arrives as a
  final rather than a segment, and it is written into the box like any other
  dictation. It used to be handed to the command rules, which both rejected
  mis-heard words as a bad command and would have let a sentence meant for an
  agent run an action.
- A segment shorter than two characters is noise and is dropped, because the
  renderer would send it straight away.
- A conversation stops after ten minutes of one open turn.
- Stopping a conversation reports nothing. Every sentence has already left as a
  segment and the recogniser was reset after each one, so the closing transcript
  is empty by design. "Nothing was heard." is kept for a turn that really
  delivered nothing.
- **Settings → Voice → Keep talking** switches the loop off; the words are then
  written into the box for you to send yourself.

### The listening bubble

While a turn is open, a bubble sits at the bottom of the window with three
things in it:

- a **halo that follows your voice** in both brightness and size, so you can
  see the microphone is hearing you before any word appears. Both are needed:
  light alone was hard to read, and the movement was invisible once the scale
  was damped down;
- the state, in one word: **Listening**, or **Writing the words**. It used to
  say "Listening — pause to send", which read as an instruction to do something
  when it only described what the loop does by itself;
- a **cross that stops listening**, ending the turn and keeping what was heard.
  Escape is the other exit and throws the words away instead; the cross says so
  in its tooltip.

The bubble shows only the words being said now. In conversation mode it used to
show the sentence it had just sent, which put the same sentence on the screen
twice: once in the transcript above, once in the bubble below. It now says
"Speak now" and waits.

### A click waits for the model

Loading a model takes seconds — the largest is 662 MB — and the worker answers
late. A click used to read the engine state straight after asking for the load,
find "loading", and refuse, so **the first click after the idle unload, a
restart, or a model change did nothing at all**. It now waits for the model, up
to 90 seconds, and the microphone button spins while it does. A load that fails
or never arrives ends the wait with the reason.

### The chrome shifts while you are heard

While the microphone is live the three chrome strips shift — the top bar, the
icon rail with the sidebar, and the status bar. **The work itself is left
alone.** An attempt to tint the whole window turned the task view pink, and a
signal must not sit on top of what the user is reading.

The colours are the system's own. `--destructive` is the only red in Aperture
and `--primary` is the brand azure; both are **mixed into the current surface**
rather than pinned to a hex, so the tint follows the theme and light and dark
need no separate values. A slow drift between the two keeps the strips from
reading as a flat fill left switched on, and it stops under
`prefers-reduced-motion`.

Two details that are easy to get wrong:

- **The scope is the guarantee.** Every recording rule is scoped to
  `.app-chrome`; a test parses the stylesheet and fails if any of them is not,
  because a rule at `:root` or on `#root` reaches the workspace and the gutters.
- The overrides are on `--color-*`, the Tailwind-facing tokens, not the raw
  `--background`. The bridge resolves `--color-background: var(--background)`
  once on `:root`, so a deeper override of the raw token is **silently
  ignored** — it looks like nothing happening rather than like an error.

It follows the **turn**, not the setting. Voice being switched on is not
recording, and neither is the moment after you stop while the words are written
up — a red frame then would be a lie about an open microphone.

### Where dictated words go

The transcript panel is mounted many times at once — the task workspace, each
canvas panel, and the Captain drawer. So there is exactly **one** active
composer, and the microphone button that started the turn names it.

A composer is addressed by a stable **key**, never by an element reference.
Each mount registers under that key (`data-voice-composer="<taskId>"`), and the
text field and the send function are resolved at the moment a sentence arrives.

That matters because a composer is replaced while a conversation runs: starting
an agent session rebuilds the whole panel. With an element reference the loop
kept hearing but wrote into a field that had left the page, which looks exactly
like it stopped listening. With a key, the sentence lands in the panel that
replaced it.

A turn started from the global shortcut, or from the test button in settings,
names no composer, so the words are inserted nowhere.

### Where the microphone button appears

- the agent message box in a task (task workspace, canvas panel, Captain);
- the **Dashboard** command box, where each sentence goes to Captain;
- the **top bar**, beside the Captain button, reachable from every view.

The first two name themselves with `data-voice-composer` and register under that
key, so a sentence reaches one box only, and a conversation survives the panel
being rebuilt.

In the top bar the microphone is the **loud** control, and the Captain button
beside it is quiet. Speaking is the invitation there; typing is the fallback.

The emphasis is **colour, never size**: the accent colour and a faint tint of
it. Every microphone in the app is the same size, because one that grows reads
as a different control rather than the same one asking to be used. A microphone
next to a text box keeps the plain treatment, since there the box is the
subject.

The top-bar button sits inside no composer, so it **names** one: the Captain
composer, `orchestrator`. A control that names none writes the words nowhere —
which is what the global shortcut does on purpose, and would be a bug here. It
opens the drawer before it starts listening, so the user watches the words
arrive in a box they can edit and send rather than into something hidden.

Both microphones show the same turn. A button lights up when the open turn is
writing into **its** composer, whoever started it — so starting from the top bar
also lights the one beside the Captain box, and either can stop the turn. A
microphone belonging to a different box stays greyed out, because it is not the
one receiving the words.

### Captain is already running when you speak

Starting an agent takes seconds, and it used to happen on the **first message** —
so the first thing a user said by voice waited for a process to boot. The
Captain panel is mounted for the whole life of the window, so the agent is
now started there in the background at launch, with `skipInitialPrompt` so it
stays quiet until spoken to.

Two consequences had to be handled:

- **A message can arrive while the session is still coming up.** The start is
  held in one shared promise, and a message awaits it. Without that the message
  is dropped — there is no session yet, and one is already being made.
- **A warm session is not a conversation.** The agent selector locks only once
  something has been said; locking it on a warm session would make the agent
  unchangeable from the moment the app opens.

It costs one idle agent process, so it can be switched off in
**Settings → General → Start Captain at launch**. Warming failure is silent:
the first message starts the session exactly as it did before.

The Dashboard box is a **controlled** React field. Its send reads the DOM value,
not the React state, because dictation writes and sends in the same tick and
React has not re-rendered by then. A send that read the state would post the
previous value. A test pins this.

### Controlling 20x through the agent

Speaking into the Dashboard box sends each sentence to Captain, which is an
unscoped agent with the task-management MCP server. That is the general path:
anything the agent can do with a tool, a user can now ask for by speech, without
a new rule in the parser.

Eight tools were added for it. They are in `captainTools` only — a scoped
subtask agent must never answer a checkpoint or stop work on a task that is not
its own.

**Reading**

| Tool | Answers |
|---|---|
| `get_messages` | "what did it say?" — newest first, tool output left out, paged with `next_before_seq` |
| `get_session_status` | "is it still working?" — the live session state |
| `list_pending_approvals` | "what needs me?" |
| `get_recent_activity` | "what happened while I was away?" |
| `get_ui_state` | "what am I looking at?" — the open view, the selected task, the open dialog, the canvas panels |

**Acting**

| Tool | Guard |
|---|---|
| `send_message` | The task must exist and the text must not be empty |
| `respond_to_checkpoint` | Refuses unless that task really reports `waiting_approval` |
| `stop_task` | Reports `nothing_running` instead of pretending to stop |

**Driving the window**

| Tool | Does |
|---|---|
| `navigate` | Shows a view: dashboard, tasks, canvas, skills, settings (with a tab) |
| `open_task` | Opens a task where the user already is — see below |
| `move_task_panel` | Moves the canvas panel of a task to a canvas coordinate |
| `close_task_panel` | Removes the canvas panel; the task is untouched |
| `set_canvas_view` | `fit_all`, `reset`, or a zoom between 0.1 and 3 |
| `open_artifact` | Shows an artifact of a task in the artifact panel |

Two of these deserve their reason written down:

- `get_session_status` exists because a task row **cannot** answer "is this
  waiting for me?". `waiting_approval` is a session state and is never written
  to the task record, so a blocked task looks exactly like a working one in
  `get_task`.
- `get_ui_state` exists because "this task" and "here" have no meaning in the
  database. The renderer publishes what is on screen, at most four times a
  second, and the value is dropped when the window closes so that a closed
  window never reports the screen it last showed.

`respond_to_checkpoint` and `stop_task` are guarded by state, not by a question
on screen: they fail when the premise is false. A user-facing confirmation needs
`ask_user`, which is not built yet, so an agent should confirm a reject or a
stop in conversation before it calls them.

`delete_task` was proposed and deliberately left out.

### One task, three ways to open it

`open_task` follows the screen instead of asking the user to name a surface:

| The user is on | "open the login task" gives them |
|---|---|
| the canvas | the panel, centred — added first when it is not there |
| the dashboard | the preview dialog, so they keep the board |
| anywhere else | the full task view |

`where` overrides it (`workspace`, `canvas`, `modal`), and the reply says which
one happened, so the agent can describe it.

### How a command reaches the window

```text
agent → MCP tool → task API route (validates) → ui:command → renderer
                                                    ↓
                                        applyUiCommand(), one command
                                                    ↓
                                        the screen is published again
```

Four rules hold this together:

1. **A command that reaches no window is a failure.** Every route refuses when
   no window has published a screen. An agent told "done" would otherwise go on
   to describe a screen the user never saw.
2. **A command names a task, never a panel.** A panel is rebuilt when a session
   starts, so a panel ID an agent read a moment ago may already be gone.
3. **The channel carries intent, not a store mutation.** The renderer stays the
   only place that knows how a view is assembled.
4. **The result is published past the throttle.** The next tool call sees the
   screen this command produced, not the one before it.

Sizing the canvas is the renderer's job: `fit_all` and centring need the
container rect, which only the canvas component has. So a viewport change is
left in the store as an intent and the canvas carries it out with its own rect.

`get_ui_state` publishes the canvas — the viewport and up to 50 panels with
their coordinates — so an agent can move a panel without guessing at the
coordinate space.

### Testing the microphone

**Settings → Voice → Test the microphone** records one turn, shows a level meter
and the words it heard, and writes them nowhere else.

Text after "ask the agent" stays verbatim. A command inside that message is
never executed.

## Safety rules

These rules are enforced in code and covered by tests:

1. Only members of the closed `VoiceIntent` union run. `isVoiceIntent()` rejects
   everything else before any database or agent call.
2. Approve and reject need a visible pending approval, a session that still
   reports `waiting_approval` for that same task, and a second confirmation on
   screen. A mis-heard "reject" cannot approve.
3. A partial title match never starts, assigns, approves, or rejects without a
   confirmation. Two or more matches produce a choice of at most three records.
4. Audio from an old turn, and partial text from an old turn, are dropped.
5. The main process stays the only mutation writer. Each action emits one
   canonical `task:created` or `task:updated` event, which reaches the desktop
   renderer and the mobile clients.
6. Confirmation is visual. A spoken "yes" confirms nothing.

### A worker that goes away must not take the app with it

The worker is a separate process, so the renderer keeps sending audio for a
moment after it has gone — the news travels by IPC. Writing to that dead pipe
raises `EPIPE`, and **an unhandled stream error in the main process is a crash
and an application restart**. It happened to a user.

So every pipe of the worker gets an error listener at spawn, the child itself
gets one for a failed spawn, each audio write is guarded, and control messages
go through one `send` that checks the channel is still connected. Losing a frame
of audio is not worth a crash.

A test kills the worker and keeps pushing audio. It also asserts the listeners
exist, because the write failure is asynchronous: without that assertion the
test passes while the real application dies.

## Permissions and privacy (§5.9)

- The microphone is requested only after the user switches voice on.
- macOS: `NSMicrophoneUsageDescription` is set through electron-builder
  `extendInfo`, and `com.apple.security.device.audio-input` is in both
  entitlement files. Main reads and requests access with `systemPreferences`.
- One `setPermissionRequestHandler` on the default session grants audio capture
  to the 20x window only, and only while voice is on. Video capture is refused.
- No audio is stored, and no audio is sent to analytics. The worker reports a
  frame count and an elapsed time for one turn, nothing else.

## Models (§5.10)

One model is offered: **NVIDIA Parakeet TDT 0.6B v3**, in the int8 ONNX
export that `sherpa-onnx` publishes
(`csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8`, pinned to revision
`2bda32ec`). **Settings → Voice** downloads it, deletes it, and shows which
model is in use.

| Model | Size on disk | Licence | Languages | What it does |
|---|---:|---|---|---|
| Parakeet v3 (`nemo-parakeet-tdt-0.6b-v3`) | 671 MB (encoder 652 MB, decoder 12 MB, joiner 6 MB, tokens 94 KB) | CC-BY-4.0 | 25 European languages, detected automatically | capitals and punctuation; one transcript per sentence |

Facts below marked *(model card)* come from
<https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3>; *(sherpa-onnx)* from the
runtime's documentation; *(measured)* from this repository. Anything not so
marked has **not been measured on this integration yet** and is listed as
unknown rather than guessed.

### Hardware, operating systems, memory and latency

| | |
|---|---|
| Execution | CPU only, through `sherpa-onnx-node` with `provider: 'cpu'`. The int8 export is a CPU quantisation. *(sherpa-onnx)* NVIDIA's own figures are for GPU inference through NeMo, which this integration does not use *(model card)*; there is no GPU path in the worker. |
| Operating systems | The runtime ships prebuilt binaries for macOS arm64, macOS x64, Windows x64, Linux x64 and Linux arm64. `unsupportedHardwareReason()` refuses the install and the download anywhere else with a message that names those targets. Only macOS arm64 has been exercised with real speech so far *(measured, streaming models)*; Parakeet on any target is **not measured yet**. |
| Threads | The worker gives the offline recogniser `min(4, max(2, cores − 1))` threads; streaming models keep two. |
| Parameters | 600 M *(model card)*. |
| Memory | The download is refused on a machine with less than 4 GB of RAM (`minMemoryBytes`). Resident memory of the loaded int8 model is **unknown**; measure it with the `ping`/`pong` `rss` figure the worker already reports before this number is published. |
| Input | 16 kHz mono *(model card)*, which is what the renderer already sends. |
| Utterance length | The model card gives 24 minutes with full attention on an A100 *(model card)*; on CPU through sherpa-onnx the practical limit is **unknown**. The worker caps a dictation turn at 60 s and a conversation at 10 min regardless. |
| Latency | **Unknown for this integration.** For an offline model the cost is one decode of the whole sentence after the pause, so the delay before the words appear is `pause length + decode time`, where decode time is `real-time factor × sentence length`. Record the real-time factor per target in the table under "Proven against the real runtime" before release. |
| Partial text | Periodic rather than per frame: the worker decodes the sentence so far every 1.5 s of speech while it is under 20 s long, and backs off when a decode takes longer than 400 ms, so a slow machine sees fewer partials instead of a stalled worker. |

### How an offline model runs behind the streaming protocol

Parakeet is a **non-streaming** model: it decodes a whole utterance at once
rather than frame by frame. The worker keeps main's protocol unchanged — the
same `partial`, `segment` and `final` messages — and handles the difference
itself:

1. Frames are buffered per sentence. Silence before the first word is dropped.
2. A frame is *speech* when its RMS is at or above `SPEECH_RMS` (0.014 on the
   renderer's −1..1 scale, about −37 dBFS; `VOICE_SPEECH_RMS` overrides it).
3. Once at least 300 ms of speech has been heard and the signal has then been
   quiet for the configured pause (**Settings → Voice → A pause this long ends
   a sentence**, never less than 0.8 s), the buffer is decoded. In a
   conversation that is one `segment` and the microphone stays open; in a
   single-shot turn it is the `final`.
4. Ending the turn by hand decodes whatever is buffered as the `final`.
5. Less than 300 ms of sound followed by silence is a click, not a sentence,
   and produces nothing.

The threshold in step 2 is a fixed starting value and **needs calibrating on
real microphones** (a laptop in a quiet room, a headset, a noisy office). A
level too high loses the first word of a quiet speaker; too low never ends a
sentence in a noisy room.

The streaming models are still loaded through `OnlineRecognizer` with the
recogniser's own endpoint rule, exactly as before; `kind` in the catalogue
entry chooses the path.

### Legacy models

Earlier releases offered three streaming English models (Zipformer small,
NeMo FastConformer 480 ms, Nemotron 0.6B 560 ms). They remain in the catalogue
as `legacy` entries so that an install of one is still recognised:

- An installed legacy model keeps working and stays selected until the user
  changes it. It is shown with an "Older model" badge and a notice that
  Parakeet v3 replaces it.
- It is never offered for download again. `VoiceModelManager.install()`
  refuses a legacy id with a message pointing at Parakeet v3, and the
  settings page hides a legacy row that is not on disk.
- Migration is one download and one delete, in either order: downloading
  Parakeet v3 makes it the model in use; deleting the legacy model in use
  falls back to another installed *current* model first, then to the default.
  Nothing is deleted automatically.
- A directory under `voice-models/` that no catalogue entry names (a model
  from a release older than the catalogue) is listed as "Older model (…)" with
  its size, cannot be loaded, and can be deleted.

### Download, verification, removal

`VoiceModelManager` downloads on request, shows the size, the language count
and the licence first, verifies a SHA-256 for each file, resumes an interrupted
download, and can delete one model or all of them. While a download runs the
row reports a `phase`: **downloading** while bytes move, **verifying** while
the checksum is computed, so 100 % never looks stuck. Failures are turned into
one line the user can act on (server status, network, disk full, checksum
mismatch, too little memory, unsupported hardware), with the raw error kept at
the end for a diagnostic report.

Each URL is pinned to one model revision, never to a branch, so a checksum
cannot go stale under the app. A model whose checksum is empty is refused.

A model directory installed by hand is still accepted, in
**Settings → Voice → Use another model directory**. The four files are found
by name (`encoder`, `decoder`, `joiner`, `tokens.txt`). Whether the directory
is decoded as streaming or offline is decided by its **name**: one containing
`parakeet` or `offline` is offline, anything else is streaming. Keep the
sherpa-onnx release name (`sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8`) and it
just works. Choosing a catalogue model clears the custom directory, so the
choice is always what runs.

### Licences

- **Parakeet TDT 0.6B v3** — [CC-BY-4.0](https://creativecommons.org/licenses/by/4.0/)
  *(model card)*. Attribution is required: the settings row links the model
  card, and a release note that lists bundled or downloaded models must name
  "NVIDIA Parakeet TDT 0.6B v3" and link to it. The ONNX export is published
  by the sherpa-onnx project under the same licence.
- **sherpa-onnx / sherpa-onnx-node** — Apache-2.0.
- Legacy entries: Zipformer Apache-2.0; FastConformer CC-BY-4.0; Nemotron
  NVIDIA Open Model License (reviewed and accepted when it was offered).

No model is inside the installer or the application bundle
(`package.json → build.files` lists only `out/**`), so release packaging
carries no model files and no model licence text; both live in this document
and in the catalogue.

## The local runtime — an optional install

`sherpa-onnx-node` is **not** a dependency of this package and is **not** in the
application bundle:

- The Phase 0 spike must first prove packaging, signing, memory and latency on
  macOS arm64, macOS x64, Windows x64 and Linux x64 (design §6, Phase 0).
- A missing runtime must not break `pnpm install` or a release build.
- A user who never turns voice on must not pay for it in download size.

### One action installs everything

Two places offer the same control (`VoiceRuntimeRow`):

1. the setup dialog, as an optional row below the agent choice,
2. **Settings → Voice**, at the top of the page.

The control names the total download size before anything happens. One press
then does all of this, and nothing is left to do by hand:

1. `npm install sherpa-onnx-node` into `<userData>/voice-runtime` — never into
   the application bundle, which is read-only once packaged. A private
   `package.json` there keeps npm from walking up into the app. npm output is
   streamed to the user, so a failure is readable, and when npm itself is
   missing the installer says so and downloads nothing.
2. the default speech model, Parakeet v3, if no model is present,
   checksum-verified. An installed legacy model counts as present: setup does
   not fetch a second model over it.
3. the model is selected and loaded in the worker.

The runtime is the first 60 % of the reported progress, the model the rest. If
the runtime is already there, only the model is fetched, and the button reads
**Finish setup**.

`VoiceWorkerClient` starts the worker with `VOICE_ENGINE_MODULE` set to the
absolute path of the installed package.

After that the user has one thing left: switch **Enable voice control** on. That
step is separate because it asks for the microphone.

### What the user sees without it

Nothing. `selectVoiceReady()` requires an installed runtime, a loaded model, and
`enabled`, and both the microphone button and the voice overlay return null
otherwise. The enable
switch in Voice settings is disabled, and the speech-model section is hidden,
because neither can do anything yet.

"Remove" deletes the runtime directory and switches voice off.

For development and for the automated tests, `VOICE_ENGINE=mock` selects a
deterministic engine that returns `VOICE_MOCK_TEXT`. It never invents words.

## A turn must always close

A turn that is never cleared in the renderer is the worst failure this feature
has, because one stranded turn:

- leaves the microphone open,
- keeps the Stop control on screen with nothing behind it, and
- **disables every microphone button in the app**, since each one sees another
  turn in progress.

Four paths close a turn, and all four are tested:

1. the user stops it — cleared at once, without waiting for main;
2. the worker ends it at a pause — `voice:final` clears it;
3. a dictation outcome arrives — cleared;
4. main reports `idle` — cleared whatever the renderer believed. Main owns the
   state machine, so this last rule catches any path not foreseen.

Main also cancels an open turn before it installs, selects, or deletes a model,
or changes the pause length, because the worker swaps the model underneath.

## Two limits that stop voice after a few turns

Both are handled, and both are easy to reintroduce:

1. **One AudioContext for the window.** Chromium allows about six per document
   and frees a closed one asynchronously, so a context per turn stops working
   after a few turns. `VoiceCapture` builds the context and the worklet once and
   reuses them; only the microphone stream is per turn. `release()` frees the
   graph when voice is switched off.
2. **The worker releases the model after five idle minutes** to give the memory
   back. `startTurn()` reloads it rather than failing, or voice would go quiet
   with no message.

## Proven against the real runtime

**Parakeet v3 has not been run through the real worker yet.** The offline
configuration (`OfflineRecognizer`, `modelType: 'nemo_transducer'`, greedy
search) is the one the sherpa-onnx Node examples use for Parakeet TDT v2, and
`voice-worker-client.test.ts` holds a check that loads it whenever
`voice-models/nemo-parakeet-tdt-0.6b-v3` and the runtime are both installed on
the developer's machine. Until that has passed on real hardware, treat the
Parakeet rows in the tables above as design, not evidence. Parakeet v3 needs a
`sherpa-onnx-node` release from August 2025 or later; the exact minimum version
is **unknown** — the worker turns a constructor failure into "the installed
speech runtime is too old to run Parakeet v3; remove it and install it again".

The streaming recogniser configuration was verified against `sherpa-onnx-node`
1.13.4 with the (now legacy) Zipformer model. Real speech through the real worker, over the real
protocol, produced streaming partials and this final transcript:

```text
AFTER EARLY NIGHTFALL THE YELLOW LAMPS WOULD LIGHT UP HERE AND THERE THE
SQUALID QUARTER OF THE BROTHELS
```

Model load took about 1.1 s; the tail decode after the turn ended took 431 ms.

The model paths, the token file and the thread count must sit inside
`modelConfig`. A flat configuration is rejected by the library with
"Errors in config!". `voice-worker-client.test.ts` holds a check that loads the
real recogniser whenever a machine has the runtime and a model installed, so
this shape cannot drift again. It skips elsewhere, so CI stays green.

## Release gates still open

From design §8, these gates are not met yet and must be closed before the
feature is offered to users:

- [x] Record a SHA-256 for every catalogue model file (Parakeet v3 included).
- [ ] Pin an exact `sherpa-onnx-node` version in `voice-runtime-installer.ts`,
      one that is known to load Parakeet v3.
- [x] Start `sherpa-onnx-node` on macOS arm64 with real speech (streaming model).
- [ ] Load Parakeet v3 through the real worker and transcribe a complete turn
      (the skipped check in `voice-worker-client.test.ts`).
- [ ] Calibrate `SPEECH_RMS` on real microphones; confirm a conversation
      segments correctly with Parakeet.
- [ ] Measure Parakeet load time, resident memory and real-time factor on each
      target, and fill in the "unknown" cells above.
- [ ] Package and start `sherpa-onnx-node` on the other desktop targets.
- [ ] Measure partial and final latency against the §3.5 targets on each target.
- [ ] Licence review of the runtime, the model and the tokens file
      (Parakeet v3: CC-BY-4.0, attribution in release notes).
- [ ] Packaged-system tests from §7 (microphone grant, denial, device change,
      8 GB machine, offline start, app update with installed models).

Voice is off by default, so none of these blocks the rest of the app.

## Testing

```bash
pnpm test:run --project main src/main/voice
pnpm test:run --project main src/shared/voice-intent-parser.test.ts
pnpm test:run --project renderer src/renderer/src/stores/voice-store.test.ts
pnpm test:run --project main src/main/task-api-voice-tools.test.ts
pnpm test:run --project main src/main/task-api-ui-tools.test.ts
pnpm test:run --project renderer src/renderer/src/lib/ui-remote-control.test.ts
```

`voice-worker-client.test.ts` forks the real worker with the mock engine, so the
process lifecycle, the control channel and the audio pipe are all covered
without a native runtime.
