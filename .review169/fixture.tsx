import React from 'react'
import { createRoot } from 'react-dom/client'
import './fixture.css'
import { CommanderWorkspace } from '@/components/commander/CommanderWorkspace'
import { CommanderCallHost } from '@/components/commander/CommanderCallHost'
import { useGlobalShortcuts } from '@/components/layout/hooks/use-global-shortcuts'
import { CommanderPictureInPicture } from '@/components/commander/CommanderPictureInPicture'
import { VoiceOverlay } from '@/components/voice/VoiceOverlay'
import { useVoiceStore } from '@/stores/voice-store'
import { useCommanderStore } from '@/stores/commander-store'
import { useCommanderCallStore } from '@/stores/commander-call-store'
import { useUIStore } from '@/stores/ui-store'
import { useAgentStore } from '@/stores/agent-store'
import { useVoiceAttributionStore } from '@/lib/activity/voice-activity-adapter'
const session = {id:'review',title:'Stage review',created_at:1,updated_at:1,archived:false,last_read_at:1,unread_count:0}
const sessions=[session,{...session,id:'private',title:'Private session'}]
const noop=()=>()=>{}
const settings={chat_agent_id:'agent',chat_provider:'anthropic',chat_model:'model',chat_reasoning_effort:'medium'}
window.electronAPI={commander:{listSessions:async()=>sessions,onEvent:noop,setActiveSession:async()=>{},listMessages:async()=>({messages:[],activeTurnId:null}),markRead:async(id)=>sessions.find(s=>s.id===id)},settings:{getAll:async()=>settings,set:async()=>{}},voice:{tts:{onSpeechStart:noop,onSpeechEnd:noop}},commanderVoice:{setActive:async()=>({}),bargeIn:async()=>({}),send:async()=>({})}} as any
useAgentStore.setState({agents:[{id:'agent',name:'Review model',is_default:true,config:{coding_agent:'claude-code',model:'model',reasoning_effort:'medium'}}] as any,isLoading:false})
useCommanderStore.setState({selectedSessionId:'review',sessions,messages:{review:[]}})
const initial=()=>{
useCommanderCallStore.setState({status:'live',sessionId:'review',turnId:'mic',startedAt:Date.now(),error:null,interruptedAt:null})
useVoiceStore.setState({available:true,enabled:true,permission:'granted',runtime:{installed:true},models:[{installed:true}],engine:{state:'ready'},tts:{enabled:true,status:{state:'ready'}},turnId:'mic',state:'listening',partial:'A full workspace test of the Commander captions.',final:'',speaking:false,speechText:'',level:.55,cancel:async()=>useVoiceStore.setState({turnId:null,state:'idle'}),stopPlaybackNow:()=>{}} as any)
}
initial()
function Keyboard(){useGlobalShortcuts({} as any,()=>{}); return null}
const root=createRoot(document.getElementById('root')!)
const mount=(host=false)=>root.render(<div className="h-screen overflow-hidden bg-background text-foreground">{host&&<><CommanderCallHost/><VoiceOverlay/></>}<Keyboard/><CommanderWorkspace/><CommanderPictureInPicture/></div>)
mount()
let starts=0;useCommanderCallStore.setState({beginPushToTalk:async()=>{starts++;useCommanderCallStore.setState({pushToTalkHeld:true})},endPushToTalk:()=>useCommanderCallStore.setState({pushToTalkHeld:false})});
Object.assign(window,{review:{get starts(){return starts},mount,initial,ui:useUIStore,voice:useVoiceStore,call:useCommanderCallStore,commander:useCommanderStore,attribution:useVoiceAttributionStore}})
