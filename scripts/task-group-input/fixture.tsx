import React from 'react'
import { createRoot } from 'react-dom/client'
import { TaskBoard } from '../../src/renderer/src/components/dashboard/TaskBoard'
import { TaskWorkspace } from '../../src/renderer/src/components/tasks/TaskWorkspace'
import { useTaskStore } from '../../src/renderer/src/stores/task-store'
import { useProjectStore } from '../../src/renderer/src/stores/project-store'
import { useAgentStore } from '../../src/renderer/src/stores/agent-store'
import { useUIStore } from '../../src/renderer/src/stores/ui-store'
import { TaskStatus, type Task, type Agent } from '../../src/renderer/src/types'
import type { TaskGroupRecord } from '../../src/shared/task-groups'
import './fixture.css'
const stamp = '2026-10-13T10:00:00Z'
function task(id: string): Task {
  return { id, title: id==='one'?'Checkout copy':'Checkout configuration',description:'Review this small checkout change.',type:'general',priority:'low',status:TaskStatus.NotStarted,assignee:'',due_date:null,labels:[],attachments:[],repos:[],output_fields:[],agent_id:'group-agent',session_id:null,external_id:null,source_id:null,source:'local',skill_ids:null,snoozed_until:null,resolution:null,feedback_rating:null,feedback_comment:null,is_recurring:false,recurrence_pattern:null,recurrence_parent_id:null,last_occurrence_at:null,next_occurrence_at:null,auto_start_agent:false,auto_complete_without_review:false,complete_at_source:null,created_at:stamp,updated_at:stamp,parent_task_id:null,next_subtask_ids:[],sort_order:0,project_id:'group-project',group_id:'native-group' }
}
const members = [task('one'), task('two')]
const anchor: Task = {...task('execution'),title:'Checkout polish',role:'task_group',group_id:null}
const group: TaskGroupRecord = {id:'native-group',title:'Checkout polish',project_id:'group-project',agent_id:'group-agent',execution_task_id:anchor.id,state:'active',status:TaskStatus.NotStarted,task_ids:members.map(task=>task.id),former_task_ids:[],progress:[{task_id:'one',state:'done',message:'Copy corrected; approval remains with you.',updated_at:stamp},{task_id:'two',state:'blocked',message:'Configuration needs review.',updated_at:stamp}],created_at:stamp,updated_at:stamp}
const agent: Agent = {id:'group-agent',name:'Shared agent',server_url:'',config:{coding_agent:'claude-code',model:'fixture-model'},is_default:true,created_at:stamp,updated_at:stamp}
Object.assign(window.fixture,{tasks:members,anchor,group})
window.fixture.part('shared-note','Shared checkout conversation is retained.')
useTaskStore.setState({tasks:members,isLoading:false})
useProjectStore.setState({currentProjectId:'group-project'})
useAgentStore.setState({agents:[agent],sessions:new Map(),isLoading:false})
useUIStore.setState({sidebarView:'dashboard',dashboardPreviewTaskId:null})
const noop = () => {}
function Fixture() {
  const preview = useUIStore(state=>state.dashboardPreviewTaskId)
  const selected = useTaskStore(state=>state.tasks.find(task=>task.id===preview))
  return <main className="ui-scale h-screen overflow-auto bg-background p-6 text-foreground"><TaskBoard />{selected&&<section className="mt-4 h-[650px] rounded-xl border border-border" aria-label="Member task view"><button className="m-2 underline" onClick={()=>useUIStore.setState({dashboardPreviewTaskId:null})}>Close task details</button><div className="h-[590px]"><TaskWorkspace task={selected} agents={[agent]} onEdit={noop} onDelete={noop} onUpdateAttachments={noop} onUpdateOutputFields={noop} onCompleteTask={noop} onAssignAgent={noop} /></div></section>}</main>
}
createRoot(document.getElementById('root')!).render(<Fixture />)
