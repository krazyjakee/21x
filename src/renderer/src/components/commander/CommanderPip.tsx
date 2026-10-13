import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { AlertTriangle, AudioLines, Brain, Captions, Circle, Expand, Grip, Loader2, Mic, MicOff, PhoneOff, Square, Wrench } from 'lucide-react'
import type { CallState } from '@shared/commander-call'
import { Button } from '@/components/ui/Button'
import { useCommanderCallUiStore, useCommanderPipVisible, type PipCorner } from '@/stores/commander-call-ui-store'
import { bindPresenceLevel } from '@/lib/commander-call/presence-level'
import { commanderCallMedia } from './CommanderCallHost'
import { useCallPresentation } from './use-call-presentation'
import { CommanderCaptions, useCommanderCaption } from './CommanderCaptions'
import { navigateCallToolbar } from './use-call-shortcuts'

const ICONS = { off: Circle, unavailable: AlertTriangle, ready: Circle, listening: Mic, transcribing: Loader2, thinking: Brain, working: Wrench, speaking: AudioLines, interrupted: Square, error: AlertTriangle } satisfies Record<CallState, typeof Circle>

export function snapPipCorner(x: number, y: number, width: number, height: number): PipCorner {
  return `${y < height / 2 ? 'top' : 'bottom'}-${x < width / 2 ? 'left' : 'right'}`
}

export function CommanderPip() {
  const visible = useCommanderPipVisible()
  const { call, presentation, observation, microphoneOpen: currentMic } = useCallPresentation()
  const caption = useCommanderCaption(presentation)
  const corner = useCommanderCallUiStore(s => s.corner)
  const captions = useCommanderCallUiStore(s => s.captions)
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null)
  const tile = useRef<HTMLElement>(null)
  const ring = useRef<HTMLDivElement>(null)
  const drag = useRef<{ pointer: number; dx: number; dy: number } | null>(null)
  const Icon = ICONS[presentation.state]
  const label = presentation.state === 'working' ? 'Working' : presentation.label
  useEffect(() => visible && ring.current ? bindPresenceLevel(ring.current, commanderCallMedia, 'output') : undefined, [visible, presentation.state])
  useEffect(() => {
    const resize = () => { drag.current = null; setPosition(null) }
    window.addEventListener('resize', resize)
    return () => window.removeEventListener('resize', resize)
  }, [])
  if (!visible) return null
  const finish = (event: ReactPointerEvent) => {
    if (drag.current?.pointer !== event.pointerId) return
    const rect = tile.current?.getBoundingClientRect()
    drag.current = null
    if (rect) useCommanderCallUiStore.getState().setCorner(snapPipCorner(rect.left + rect.width / 2, rect.top + rect.height / 2, innerWidth, innerHeight))
    setPosition(null)
    event.currentTarget.releasePointerCapture?.(event.pointerId)
  }
  return <section ref={tile} className={`commander-pip commander-pip-${corner} ui-scale`} style={position ? { left: position.x, top: position.y, right: 'auto', bottom: 'auto' } : undefined} role="region" aria-label="Commander floating call" data-testid="commander-pip">
    <div className="commander-pip-heading">
      <button className="commander-pip-drag" aria-label="Move Commander call" title="Drag to a corner, or use arrow keys" onPointerDown={event => {
        if (event.button !== 0) return
        const rect = tile.current?.getBoundingClientRect(); if (!rect) return
        drag.current = { pointer: event.pointerId, dx: event.clientX - rect.left, dy: event.clientY - rect.top }
        event.currentTarget.setPointerCapture?.(event.pointerId)
      }} onPointerMove={event => {
        if (drag.current?.pointer !== event.pointerId || !tile.current) return
        const rect = tile.current.getBoundingClientRect()
        setPosition({ x: Math.max(8, Math.min(innerWidth - rect.width - 8, event.clientX - drag.current.dx)), y: Math.max(8, Math.min(innerHeight - rect.height - 8, event.clientY - drag.current.dy)) })
      }} onPointerUp={finish} onPointerCancel={finish} onKeyDown={event => {
        if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) return
        event.preventDefault(); event.stopPropagation()
        const [vertical, horizontal] = corner.split('-')
        useCommanderCallUiStore.getState().setCorner(`${event.key === 'ArrowUp' ? 'top' : event.key === 'ArrowDown' ? 'bottom' : vertical}-${event.key === 'ArrowLeft' ? 'left' : event.key === 'ArrowRight' ? 'right' : horizontal}` as PipCorner)
      }}><Grip className="size-icon-sm" aria-hidden="true" /></button>
      <div className="commander-pip-avatar" aria-hidden="true">{presentation.state === 'speaking' && <div ref={ring} className="commander-presence-ring" data-testid="commander-output-ring" />}<AudioLines className="size-icon-sm" /></div>
      <div className="min-w-0 flex-1"><h2 className="text-sm font-semibold">Commander</h2><p className="flex items-center gap-1.5 text-xs" data-testid="commander-pip-state"><Icon className="size-icon-sm" aria-hidden="true" />{label}</p></div>
    </div>
    <CommanderCaptions caption={caption} compact />
    {presentation.detail && <p className="break-words text-sm">{presentation.detail}</p>}
    <div className="commander-pip-toolbar" role="toolbar" aria-label="Floating Commander call controls" onKeyDown={navigateCallToolbar}>
      <Button size="icon" variant={currentMic ? 'default' : 'secondary'} aria-label={call.muted ? 'Unmute microphone' : 'Mute microphone'} aria-pressed={!call.muted} disabled={call.status !== 'live'} onClick={() => void call.toggleMicrophone()}>{currentMic ? <Mic className="size-icon" /> : <MicOff className="size-icon" />}</Button>
      <Button size="icon" variant="secondary" aria-label="Stop the reply" disabled={!presentation.controls.stop} onClick={() => call.interrupt('stop')}><Square className="size-icon" /></Button>
      <Button size="icon" variant="ghost" aria-label="Expand Commander call" data-testid="commander-pip-expand" onClick={() => useCommanderCallUiStore.getState().expand()}><Expand className="size-icon" /></Button>
      <Button size="icon" variant="ghost" aria-label={captions ? 'Hide captions' : 'Show captions'} aria-pressed={captions} onClick={() => useCommanderCallUiStore.getState().toggleCaptions()}><Captions className="size-icon" /></Button>
      {presentation.controls.retry && <Button size="sm" variant="outline" onClick={() => void call.retry(observation?.phase === 'error' ? observation.turnId : undefined)}>Retry</Button>}
      <Button className="ml-auto" size="sm" variant="destructive" aria-label="Turn voice mode off" onClick={() => call.end()}><PhoneOff className="size-icon-sm" aria-hidden="true" />End</Button>
    </div>
  </section>
}
