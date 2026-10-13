import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, AudioLines, Brain, Captions, ChevronDown, Circle, Inbox, Loader2, Mic, MicOff, PanelRight, PhoneOff, PictureInPicture2, Settings, Square, Wrench } from 'lucide-react'
import type { CallState } from '@shared/commander-call'
import { Button } from '@/components/ui/Button'
import { bindPresenceLevel } from '@/lib/commander-call/presence-level'
import { useCommanderStore } from '@/stores/commander-store'
import { useUIStore } from '@/stores/ui-store'
import { SettingsTab } from '@/types'
import { commanderCallMedia, MICROPHONE_BUSY_MESSAGE } from './CommanderCallHost'
import { CommanderCaptions, useCommanderCaption } from './CommanderCaptions'
import { navigateCallToolbar } from './use-call-shortcuts'
import { useCommanderCallUiStore } from '@/stores/commander-call-ui-store'
import { toolCallLabel } from './tool-call-label'
import { useCallPresentation } from './use-call-presentation'

const ICONS = { off: Circle, unavailable: AlertTriangle, ready: Circle, listening: Mic, transcribing: Loader2,
  thinking: Brain, working: Wrench, speaking: AudioLines, interrupted: Square, error: AlertTriangle } satisfies Record<CallState, typeof Circle>

function LevelRing({ kind }: { kind: 'input' | 'output' }) {
  const ring = useRef<HTMLDivElement>(null)
  useEffect(() => ring.current ? bindPresenceLevel(ring.current, commanderCallMedia, kind) : undefined, [kind])
  return <div ref={ring} className="commander-presence-ring" data-testid={`commander-${kind}-ring`} aria-hidden="true" />
}

interface StageProps {
  panelOpen: boolean
  onPanelToggle: () => void
  compact: boolean
  onCompactToggle: () => void
}

/** View only: the app-owned call driver remains the single microphone/speaker owner. */
export function CommanderStage({ panelOpen, onPanelToggle, compact, onCompactToggle }: StageProps) {
  const { call, snapshot, selected, presentation, readiness, observation, fresh, microphoneOpen: currentMic } = useCallPresentation()
  const callSessionTitle = useCommanderStore(s => s.sessions.find(session => session.id === call.sessionId)?.title)
  const streaming = useCommanderStore(s => selected ? s.streaming[selected] : undefined)
  const turnError = useCommanderStore(s => selected ? s.turnErrors[selected] : undefined)
  const captions = useCommanderCallUiStore(s => s.captions)
  const captionSize = useCommanderCallUiStore(s => s.captionSize)
  const caption = useCommanderCaption(presentation)
  const [menu, setMenu] = useState(false)
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([])
  const [deviceError, setDeviceError] = useState('')
  const [localProblem, setLocalProblem] = useState<string | null>(null)
  const speaking = presentation.state === 'speaking' && commanderCallMedia.assistantCaption.speaking
  const shownState: CallState = call.status === 'off' && !call.error && streaming && fresh ? streaming.toolCalls.length ? 'working' : 'thinking' : presentation.state
  const Icon = ICONS[shownState]
  const label = call.status === 'off' && streaming ? fresh ? streaming.toolCalls.length ? 'Working' : 'Replying in text' : 'Reply status unavailable' : presentation.state === 'working' ? 'Working' : presentation.label
  const liveTool = call.status === 'off' || call.sessionId === selected ? streaming?.toolCalls.at(-1) : undefined
  const visibleProblem = localProblem ?? call.error ?? (presentation.state === 'error' || presentation.state === 'unavailable' ? presentation.detail : null) ?? (!panelOpen ? turnError : undefined)
  const openSettings = (model = false) => {
    setLocalProblem(null); call.dismissError()
    const ui = useUIStore.getState(); ui.setSettingsTab(model ? SettingsTab.AGENTS : SettingsTab.VOICE); ui.openSettings()
  }
  const start = () => {
    if (!selected) { setLocalProblem('Open or create a session to start talking.'); useCommanderCallUiStore.getState().announce('Open or create a session to start talking.', false); return }
    if (readiness?.blocking) { setLocalProblem(readiness.problem); return }
    setLocalProblem(null); void call.start(selected)
  }
  useEffect(() => {
    if (!menu) return
    let active = true
    const media = navigator.mediaDevices
    if (!media?.enumerateDevices) { setDeviceError('Input devices are unavailable. Check microphone permission in Voice settings.'); return }
    const refresh = () => { void media.enumerateDevices().then(items => {
      if (active) { setDevices(items.filter(device => device.kind === 'audioinput')); setDeviceError('') }
    }).catch(() => { if (active) setDeviceError('Input devices could not be listed. Check microphone permission in Voice settings.') }) }
    refresh(); media.addEventListener?.('devicechange', refresh)
    return () => { active = false; media.removeEventListener?.('devicechange', refresh) }
  }, [menu])

  return <section className={`commander-stage ${compact ? 'commander-stage-compact' : ''}`} aria-label="Commander stage" data-testid="commander-stage" data-call-state={shownState}>
    {call.status !== 'off' && call.sessionId !== selected && <p className="commander-stage-notice text-sm">Call continues in <button className="font-medium underline" onClick={() => { if (call.sessionId) void useCommanderStore.getState().selectSession(call.sessionId) }}>{callSessionTitle || 'another conversation'}</button></p>}
    <div className="commander-stage-body">
      <div className={`commander-presence commander-state-${shownState}`}>
        <div className="commander-avatar" aria-hidden="true">{speaking && <LevelRing kind="output" />}<AudioLines className="size-10" /></div>
        <h2 className="text-lg font-semibold">Commander</h2>
        <p className="flex items-center justify-center gap-2 text-base" data-testid="commander-presence-state"><Icon className="size-icon shrink-0" aria-hidden="true" />{label}</p>
        {shownState === 'working' && liveTool && <p className="mt-2 break-words text-sm text-muted-foreground">{toolCallLabel(liveTool.name, liveTool.input)}</p>}
        {presentation.textOnly && call.status !== 'off' && <p className="text-sm text-muted-foreground">Replies appear in Chat</p>}
        {call.status === 'off' && <Button onClick={start} aria-label="Turn voice mode on" className="mt-4"><Mic className="size-icon" aria-hidden="true" />Start talking</Button>}
        {readiness && call.status === 'off' && <button className="mt-2 text-sm underline" onClick={() => openSettings()} data-testid="commander-voice-setup">{readiness.label}</button>}
      </div>
      <div className="commander-user-tile" aria-label={currentMic ? 'You, microphone listening' : 'You, microphone muted'}>
        <div className="commander-user-avatar">{currentMic && <LevelRing kind="input" />}<span aria-hidden="true">Y</span></div>
        <div><p className="text-sm font-medium">You</p><p className="flex items-center gap-1.5 text-xs text-muted-foreground">{currentMic ? <Mic className="size-icon-sm" aria-hidden="true" /> : <MicOff className="size-icon-sm" aria-hidden="true" />}{currentMic ? 'Microphone on' : 'Microphone muted'}</p></div>
      </div>
    </div>
    {visibleProblem && <div className="commander-stage-alert border-destructive/40 bg-destructive/10 text-destructive">
      <p className="text-sm leading-relaxed">{visibleProblem}</p>
      <div className="mt-2 flex flex-wrap gap-2">
        {presentation.controls.retry && <Button size="sm" variant="outline" onClick={() => void call.retry(observation?.phase === 'error' ? observation.turnId : undefined)}>Retry</Button>}
        <Button size="sm" variant="outline" onClick={() => { call.end(); if (!panelOpen) onPanelToggle(); window.setTimeout(() => document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message the Commander"]')?.focus(), 0) }}>Type instead</Button>
        {!selected && <Button size="sm" variant="outline" onClick={() => document.querySelector<HTMLButtonElement>('[aria-label="Open Commander sessions"]')?.click()}>Open sessions</Button>}
        {selected && snapshot.available && visibleProblem !== MICROPHONE_BUSY_MESSAGE && <Button size="sm" variant="outline" onClick={() => openSettings(/model|key|quota|credit/i.test(visibleProblem))} data-testid="commander-voice-fix">{/model|key|quota|credit/i.test(visibleProblem) ? 'Check model settings' : 'Open voice settings'}</Button>}
      </div>
    </div>}
    {presentation.event?.kind === 'report' && <p className="commander-stage-notice text-sm"><Inbox className="size-icon-sm" aria-hidden="true" />Report arrived · read it in Chat</p>}
    <CommanderCaptions caption={caption} />
    <div className="commander-toolbar" role="toolbar" aria-label="Commander call controls" onKeyDown={navigateCallToolbar}>
      <Button size="icon" variant={currentMic ? 'default' : 'secondary'} aria-label={call.muted ? 'Unmute microphone' : 'Mute microphone'} aria-pressed={!call.muted} disabled={call.status !== 'live'} onClick={() => void call.toggleMicrophone()}>{currentMic ? <Mic className="size-icon" /> : <MicOff className="size-icon" />}</Button>
      <Button size="sm" variant="ghost" aria-label="Microphone mode and input device" aria-expanded={menu} onClick={() => setMenu(value => !value)}><span>{call.micMode === 'push-to-talk' ? 'Push to talk' : 'Open mic'}</span><ChevronDown className="size-icon" /></Button>
      <Button size="icon" variant="secondary" aria-label="Stop the reply" disabled={!presentation.controls.stop} onClick={() => call.interrupt('stop')}><Square className="size-icon" /></Button>
      <Button size="icon" variant="ghost" aria-label={captions ? 'Hide captions' : 'Show captions'} aria-pressed={captions} onClick={() => useCommanderCallUiStore.getState().toggleCaptions()}><Captions className="size-icon" /></Button>
      <Button size="icon" variant="ghost" aria-label={panelOpen ? 'Hide Chat panel' : 'Show Chat panel'} aria-pressed={panelOpen} onClick={onPanelToggle}><PanelRight className="size-icon" /></Button>
      <Button size="icon" variant="ghost" aria-label="Voice settings" onClick={() => openSettings()}><Settings className="size-icon" /></Button>
      <Button size="icon" variant="ghost" aria-label={compact ? 'Expand Commander stage' : 'Picture in picture'} aria-pressed={compact} disabled={call.status === 'off'} onClick={onCompactToggle}><PictureInPicture2 className="size-icon" /></Button>
      <Button variant="destructive" aria-label="Turn voice mode off" disabled={call.status === 'off'} onClick={() => call.end()}><PhoneOff className="size-icon" aria-hidden="true" />End</Button>
    </div>
    {menu && <div className="commander-mic-menu" aria-label="Microphone options">
      <label className="flex flex-col gap-1 text-sm">Microphone mode<select aria-label="Microphone mode" disabled={call.status === 'starting'} value={call.micMode} onChange={event => void call.setMicMode(event.target.value === 'push-to-talk' ? 'push-to-talk' : 'open-mic')}><option value="open-mic">Open mic</option><option value="push-to-talk">Push to talk</option></select></label>
      <label className="flex flex-col gap-1 text-sm">Input device<select aria-label="Microphone input device" disabled={call.status === 'starting'} value={call.inputDeviceId} onChange={event => void call.setInputDevice(event.target.value)}><option value="">System default</option>{devices.filter(device => device.deviceId !== 'default').map((device, index) => <option key={device.deviceId} value={device.deviceId}>{device.label || `Microphone ${index + 1}`}</option>)}</select></label>
      <label className="flex flex-col gap-1 text-sm">Caption size<select aria-label="Caption size" value={captionSize} onChange={event => useCommanderCallUiStore.getState().setCaptionSize(event.target.value as typeof captionSize)}><option value="small">Small</option><option value="medium">Medium</option><option value="large">Large</option></select></label>
      <p className="text-xs text-muted-foreground">{deviceError || (call.micMode === 'push-to-talk' ? 'Hold Space outside text fields, or hold the Talk button. Release to send.' : 'Pauses send each sentence. Speaking over a reply interrupts it.')}</p>
      {call.micMode === 'push-to-talk' && <Button disabled={call.status !== 'live' || call.muted || call.pttFinishing} aria-label="Hold to talk" aria-pressed={call.pttHeld} onPointerDown={event => { event.currentTarget.setPointerCapture?.(event.pointerId); void call.beginTalk() }} onPointerUp={() => call.finishTalk()} onPointerCancel={() => call.finishTalk()} onKeyDown={event => { if ((event.key === ' ' || event.key === 'Enter') && !event.repeat) { event.preventDefault(); void call.beginTalk() } }} onKeyUp={event => { if (event.key === ' ' || event.key === 'Enter') { event.preventDefault(); call.finishTalk() } }} onBlur={() => call.finishTalk()}>Hold to talk</Button>}
      <Button size="sm" variant="ghost" onClick={() => setMenu(false)}>Close microphone options</Button>
    </div>}
  </section>
}
