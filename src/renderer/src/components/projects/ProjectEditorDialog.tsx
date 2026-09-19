import { useEffect, useMemo, useState } from 'react'
import {
  ArrowDown, ArrowUp, Archive, ArchiveRestore, FolderGit2, Link2, Loader2, Plus, Trash2, Eye, Pencil
} from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogBody, DialogTitle, DialogDescription } from '@/components/ui/Dialog'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Label } from '@/components/ui/Label'
import { Select } from '@/components/ui/Select'
import { Textarea } from '@/components/ui/Textarea'
import { Switch } from '@/components/ui/Switch'
import { Badge } from '@/components/ui/Badge'
import { Markdown } from '@/components/ui/Markdown'
import { RepoSelectorDialog } from '@/components/github/RepoSelectorDialog'
import { useUIStore } from '@/stores/ui-store'
import { useProjectStore } from '@/stores/project-store'
import { useAgentStore } from '@/stores/agent-store'
import { useSettingsStore, type GitProvider } from '@/stores/settings-store'
import { projectApi, projectLimitsApi } from '@/lib/ipc-client'
import {
  GIT_PROVIDER_LABELS,
  draftFromProject,
  emptyProjectDraft,
  isValidResourceUrl,
  moveItem,
  newDraftKey,
  parseRepoInput,
  repoIdentity,
  saveProjectDraft,
  validateProjectDraft,
  type GitProviderId,
  type ProjectDraft,
  type ProjectDraftOriginal,
  type RepoDraft,
  type ResourceDraft
} from '@/lib/project-editor'
import { DEFAULT_PROJECT_ID } from '@shared/projects'
import type { MastermindMemory } from '@shared/mastermind-memory'
import type { ProjectStatusJournalEntry } from '@shared/project-status'
import { formatRelativeDate } from '@shared/date-format'
import {
  ESCALATION_ACTIONS, ESCALATION_ACTION_LABELS, ESCALATION_LEVELS, ESCALATION_LEVEL_LABELS,
  escalationPolicyFromSettings, projectLimitsFromSettings,
  type EscalationAction, type EscalationLevel, type ProjectLimitsSettings
} from '@shared/project-policies'
import type { ProjectLimitState } from '@shared/project-limit-types'
import {
  PROJECT_EVENT_KINDS,
  PROJECT_EVENT_KIND_LABELS,
  readMastermindWakeupSettings,
  withMastermindWakeupSettings,
  type MastermindWakeupSettings
} from '@shared/mastermind-wakeups'
import type { GitHubRepo } from '@/types/electron'
import { ScheduledReviewSection } from './ScheduledReviewSection'
import { withScheduledReviewSettings } from '@shared/scheduled-coordination'

const PROVIDER_IDS = Object.keys(GIT_PROVIDER_LABELS) as GitProviderId[]
const NO_INITIAL_REPOS: string[] = []

function providerLabel(provider: string): string {
  return GIT_PROVIDER_LABELS[provider as GitProviderId] ?? provider
}

// ── Limits (#65) helpers ──
/** A limit field: empty means unlimited (null); anything else must be a whole number of at least 1. */
function parseLimitInput(value: string): number | null {
  const n = parseInt(value, 10)
  return Number.isFinite(n) && n >= 1 ? n : null
}

const QUEUE_REASON_LABELS: Record<string, string> = {
  global_pause: 'all projects are paused',
  project_paused: 'the project is paused',
  project_daily_cap: 'the daily session cap is used up',
  project_limit: 'the concurrent agent limit is reached'
}

function MoveButtons({ index, count, onMove }: { index: number; count: number; onMove: (delta: -1 | 1) => void }) {
  return (
    <div className="flex items-center">
      <Button variant="ghost" size="icon" className="h-7 w-7" disabled={index === 0} onClick={() => onMove(-1)} title="Move up" aria-label="Move up">
        <ArrowUp className="size-icon-xs" />
      </Button>
      <Button variant="ghost" size="icon" className="h-7 w-7" disabled={index === count - 1} onClick={() => onMove(1)} title="Move down" aria-label="Move down">
        <ArrowDown className="size-icon-xs" />
      </Button>
    </div>
  )
}

/**
 * Create or edit a project: details, brief, agents, git provider/org, repos
 * and resources. Opened with `useUIStore().openProjectEditor(id | 'new')`.
 * Nothing is written until Save; a new project may be saved with no repos.
 */
export function ProjectEditorDialog() {
  const target = useUIStore((s) => s.projectEditorTarget)
  const close = useUIStore((s) => s.closeProjectEditor)
  const projects = useProjectStore((s) => s.projects)
  const setCurrentProject = useProjectStore((s) => s.setCurrentProject)
  const archiveProject = useProjectStore((s) => s.archiveProject)
  const agents = useAgentStore((s) => s.agents)
  const globalOrg = useSettingsStore((s) => s.githubOrg)
  const globalProvider = useSettingsStore((s) => s.gitProvider)

  const isNew = target === 'new'
  const project = !isNew && target ? projects.find((p) => p.id === target) : undefined

  const [draft, setDraft] = useState<ProjectDraft>(emptyProjectDraft)
  const [original, setOriginal] = useState<ProjectDraftOriginal>({ repos: [], resources: [] })
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showPreview, setShowPreview] = useState(false)
  const [repoInput, setRepoInput] = useState('')
  const [repoInputProvider, setRepoInputProvider] = useState<GitProviderId>('github')
  const [repoPickerOpen, setRepoPickerOpen] = useState(false)
  const [externalRevision, setExternalRevision] = useState(0)
  /** The project's Mastermind memory file (#55). Read-only here: the Mastermind writes it. */
  const [memory, setMemory] = useState<MastermindMemory | null>(null)
  /** Which project events wake the Mastermind (#57): a keyed block of the draft's settings JSON, saved with it. */
  const wakeups = useMemo(() => readMastermindWakeupSettings(draft.settings), [draft.settings])
  const patchWakeups = (fields: Partial<MastermindWakeupSettings>) =>
    setDraft((d) => ({ ...d, settings: withMastermindWakeupSettings(d.settings, { ...readMastermindWakeupSettings(d.settings), ...fields }) }))
  /** Live limit state (#65): what the caps count right now. Null for a new project. */
  const [limitState, setLimitState] = useState<ProjectLimitState | null>(null)

  useEffect(() => {
    if (!target || target === 'new') {
      setLimitState(null)
      return undefined
    }
    let cancelled = false
    Promise.resolve()
      .then(() => projectLimitsApi.getState(target))
      .then((state) => { if (!cancelled) setLimitState(state ?? null) })
      .catch(() => { if (!cancelled) setLimitState(null) })
    return () => { cancelled = true }
  }, [target, externalRevision])

  useEffect(() => {
    if (!target || target === 'new') {
      setMemory(null)
      return undefined
    }
    let cancelled = false
    Promise.resolve()
      .then(() => projectApi.getMastermindMemory(target))
      .then((loaded) => { if (!cancelled) setMemory(loaded ?? null) })
      .catch(() => { if (!cancelled) setMemory(null) })
    return () => { cancelled = true }
  }, [target])

  useEffect(() => projectApi.onChanged((event) => {
    if (event.projectId !== target) return
    void useProjectStore.getState().fetchProjects().then(() => {
      setExternalRevision((revision) => revision + 1)
    })
  }), [target])

  // Load the draft each time the editor opens.
  useEffect(() => {
    if (!target) return undefined
    setError(null)
    setShowPreview(false)
    setRepoInput('')
    void useSettingsStore.getState().fetchSettings()
    if (useAgentStore.getState().agents.length === 0) void useAgentStore.getState().fetchAgents()
    if (target === 'new') {
      setDraft(emptyProjectDraft())
      setOriginal({ repos: [], resources: [] })
      return undefined
    }
    const record = useProjectStore.getState().projects.find((p) => p.id === target)
    if (!record) return undefined
    let cancelled = false
    setLoading(true)
    Promise.all([projectApi.listRepos(target), projectApi.listResources(target)])
      .then(([repos, resources]) => {
        if (cancelled) return
        setDraft(draftFromProject(record, repos, resources))
        setOriginal({ repos, resources })
      })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [target, externalRevision])

  const effectiveProvider = (draft.git_provider || globalProvider || 'github') as GitProviderId
  const effectiveOrg = draft.git_org ?? globalOrg ?? ''

  useEffect(() => { setRepoInputProvider(effectiveProvider) }, [effectiveProvider])

  const problems = useMemo(() => validateProjectDraft(draft), [draft])
  const patch = (fields: Partial<ProjectDraft>) => setDraft((d) => ({ ...d, ...fields }))

  const agentOptions = useMemo(() => [
    { value: '', label: 'App default' },
    ...agents.map((a) => ({ value: a.id, label: a.name }))
  ], [agents])

  // ── Limits (#65) and escalation (#66): keyed blocks of the settings JSON ──
  const limits = useMemo(() => projectLimitsFromSettings(draft.settings), [draft.settings])
  const patchLimits = (fields: Partial<ProjectLimitsSettings>) =>
    setDraft((d) => ({ ...d, settings: { ...d.settings, limits: { ...projectLimitsFromSettings(d.settings), ...fields } } }))
  const escalation = useMemo(() => escalationPolicyFromSettings(draft.settings), [draft.settings])
  const patchEscalation = (action: EscalationAction, level: EscalationLevel) =>
    setDraft((d) => ({ ...d, settings: { ...d.settings, escalation: { ...escalationPolicyFromSettings(d.settings), [action]: level } } }))
  const escalationOptions = useMemo(
    () => ESCALATION_LEVELS.map((level) => ({ value: level, label: ESCALATION_LEVEL_LABELS[level] })),
    []
  )

  // ── Repos ──
  const addRepos = (repos: Omit<RepoDraft, 'key'>[]) => {
    setDraft((d) => {
      const seen = new Set(d.repos.map(repoIdentity))
      const fresh = repos
        .filter((r) => !seen.has(repoIdentity(r)))
        .map((r) => ({ ...r, key: newDraftKey() }))
      return { ...d, repos: [...d.repos, ...fresh] }
    })
  }
  const addRepoByHand = () => {
    const parsed = parseRepoInput(repoInput, effectiveOrg)
    if (!parsed) {
      setError('Enter a repo as name, org/name or a clone URL.')
      return
    }
    setError(null)
    addRepos([{ provider: parsed.provider ?? repoInputProvider, org: parsed.org, name: parsed.name, default_branch: '' }])
    setRepoInput('')
  }
  const handlePickedRepos = (repos: GitHubRepo[], org: string, provider: GitProvider) => {
    addRepos(repos.map((r) => ({ provider, org, name: r.name, default_branch: '' })))
    setRepoPickerOpen(false)
  }
  const updateRepo = (key: string, fields: Partial<RepoDraft>) =>
    setDraft((d) => ({ ...d, repos: d.repos.map((r) => (r.key === key ? { ...r, ...fields } : r)) }))
  const removeRepo = (key: string) => setDraft((d) => ({ ...d, repos: d.repos.filter((r) => r.key !== key) }))

  // ── Resources ──
  const addResource = () =>
    setDraft((d) => ({ ...d, resources: [...d.resources, { key: newDraftKey(), label: '', url: '', notes: '' }] }))
  const updateResource = (key: string, fields: Partial<ResourceDraft>) =>
    setDraft((d) => ({ ...d, resources: d.resources.map((r) => (r.key === key ? { ...r, ...fields } : r)) }))
  const removeResource = (key: string) => setDraft((d) => ({ ...d, resources: d.resources.filter((r) => r.key !== key) }))

  const handleSave = async () => {
    setSaving(true)
    setError(null)
    try {
      const saved = await saveProjectDraft(isNew ? null : project?.id ?? null, draft, original)
      // A project just created is the one the user wants to work in.
      if (isNew) setCurrentProject(saved.id)
      close()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const handleArchiveToggle = async () => {
    if (!project) return
    await archiveProject(project.id, !project.archived)
    close()
  }

  const open = !!target && (isNew || !!project)

  return (
    <>
      <Dialog open={open} onOpenChange={(v) => { if (!v) close() }}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>{isNew ? 'New project' : `Edit ${project?.name ?? 'project'}`}</DialogTitle>
            <DialogDescription>
              A project groups tasks and task sources, and gives its agents a brief, repos and resources as context.
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-8">
            {loading ? (
              <div className="flex items-center justify-center py-12 text-sm text-muted-foreground">
                <Loader2 className="size-icon-sm mr-2 animate-spin" /> Loading project…
              </div>
            ) : (
              <>
                {/* ── Details ── */}
                <section className="space-y-4">
                  <div className="space-y-1.5">
                    <Label htmlFor="project-name">Name</Label>
                    <Input
                      id="project-name"
                      autoFocus={isNew}
                      value={draft.name}
                      onChange={(e) => patch({ name: e.target.value })}
                      placeholder="e.g. Website relaunch"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between">
                      <Label htmlFor="project-brief">Brief</Label>
                      <button
                        type="button"
                        onClick={() => setShowPreview((v) => !v)}
                        className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground cursor-pointer"
                      >
                        {showPreview ? <><Pencil className="size-icon-xs" /> Edit</> : <><Eye className="size-icon-xs" /> Preview</>}
                      </button>
                    </div>
                    {showPreview ? (
                      <div className="min-h-[120px] rounded-lg border border-border bg-card px-3 py-2">
                        {draft.description.trim()
                          ? <Markdown>{draft.description}</Markdown>
                          : <p className="text-sm text-muted-foreground">Nothing to preview yet.</p>}
                      </div>
                    ) : (
                      <Textarea
                        id="project-brief"
                        value={draft.description}
                        onChange={(e) => patch({ description: e.target.value })}
                        placeholder="What this project is for, who it serves, conventions to follow. Markdown is supported. The project's Mastermind reads this."
                        className="min-h-[120px] font-mono text-[13px]"
                      />
                    )}
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-1.5">
                      <Label htmlFor="project-default-agent">Default agent</Label>
                      <Select
                        id="project-default-agent"
                        value={draft.default_agent_id ?? ''}
                        onChange={(e) => patch({ default_agent_id: e.target.value || null })}
                        options={agentOptions}
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="project-mastermind-agent">Mastermind agent</Label>
                      <Select
                        id="project-mastermind-agent"
                        value={draft.mastermind_agent_id ?? ''}
                        onChange={(e) => patch({ mastermind_agent_id: e.target.value || null })}
                        options={agentOptions}
                      />
                    </div>
                  </div>
                </section>

                {/* ── Git ── */}
                <section className="space-y-3">
                  <h3 className="text-[13px] font-semibold uppercase tracking-wider text-muted-foreground">Git</h3>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-1.5">
                      <Label htmlFor="project-git-provider">Provider</Label>
                      <Select
                        id="project-git-provider"
                        value={draft.git_provider ?? ''}
                        onChange={(e) => patch({ git_provider: e.target.value || null })}
                        options={[
                          { value: '', label: `App setting (${providerLabel(globalProvider ?? 'github')})` },
                          ...PROVIDER_IDS.map((id) => ({ value: id, label: GIT_PROVIDER_LABELS[id] }))
                        ]}
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="project-git-org">Organization</Label>
                      <Input
                        id="project-git-org"
                        value={draft.git_org ?? ''}
                        onChange={(e) => patch({ git_org: e.target.value.trim() ? e.target.value : null })}
                        placeholder={globalOrg ? `App setting (${globalOrg})` : 'Owner or group'}
                      />
                    </div>
                  </div>
                </section>

                {/* ── Repos ── */}
                <section className="space-y-3">
                  <div className="flex items-center justify-between">
                    <h3 className="text-[13px] font-semibold uppercase tracking-wider text-muted-foreground">Repositories</h3>
                    <Button size="sm" variant="outline" onClick={() => setRepoPickerOpen(true)}>
                      <FolderGit2 className="size-icon-sm" /> Add from {effectiveOrg || 'an organization'}
                    </Button>
                  </div>

                  {draft.repos.length === 0 ? (
                    <div className="rounded-lg border border-dashed border-border px-4 py-5 text-center">
                      <p className="text-sm text-foreground/80">Add repos, or skip — a project doesn’t need any.</p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        Repos let coding agents open worktrees. Projects about documents, research or operations work fine without them.
                      </p>
                    </div>
                  ) : (
                    <div className="space-y-1.5">
                      {draft.repos.map((repo, index) => (
                        <div key={repo.key} className="flex items-center gap-2 rounded-lg border border-border bg-card px-2.5 py-1.5">
                          <MoveButtons
                            index={index}
                            count={draft.repos.length}
                            onMove={(delta) => setDraft((d) => ({ ...d, repos: moveItem(d.repos, index, delta) }))}
                          />
                          <Badge>{providerLabel(repo.provider)}</Badge>
                          <span className="min-w-0 flex-1 truncate text-sm font-medium" title={`${repo.org}/${repo.name}`}>
                            {repo.org ? <span className="text-muted-foreground">{repo.org}/</span> : null}{repo.name}
                          </span>
                          <Input
                            value={repo.default_branch}
                            onChange={(e) => updateRepo(repo.key, { default_branch: e.target.value })}
                            placeholder="Default branch"
                            aria-label={`Default branch for ${repo.name}`}
                            className="h-8 w-36 text-xs"
                          />
                          <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive hover:text-destructive" onClick={() => removeRepo(repo.key)} title="Remove repo" aria-label={`Remove ${repo.name}`}>
                            <Trash2 className="size-icon-xs" />
                          </Button>
                        </div>
                      ))}
                    </div>
                  )}

                  <div className="flex items-center gap-2">
                    <Select
                      value={repoInputProvider}
                      onChange={(e) => setRepoInputProvider(e.target.value as GitProviderId)}
                      options={PROVIDER_IDS.map((id) => ({ value: id, label: GIT_PROVIDER_LABELS[id] }))}
                      aria-label="Provider for a repo added by hand"
                      className="w-32"
                    />
                    <Input
                      value={repoInput}
                      onChange={(e) => setRepoInput(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addRepoByHand() } }}
                      placeholder={`name, org/name or a clone URL${effectiveOrg ? ` (org defaults to ${effectiveOrg})` : ''}`}
                      aria-label="Add a repo by hand"
                    />
                    <Button size="sm" variant="secondary" onClick={addRepoByHand} disabled={!repoInput.trim()}>
                      <Plus className="size-icon-sm" /> Add
                    </Button>
                  </div>
                </section>

                {/* ── Resources ── */}
                <section className="space-y-3">
                  <div className="flex items-center justify-between">
                    <div>
                      <h3 className="text-[13px] font-semibold uppercase tracking-wider text-muted-foreground">Resources</h3>
                      <p className="text-xs text-muted-foreground">Links and notes agents get as context — a drive folder, docs, a dashboard. Nothing is connected or fetched.</p>
                    </div>
                    <Button size="sm" variant="outline" onClick={addResource}>
                      <Link2 className="size-icon-sm" /> Add resource
                    </Button>
                  </div>
                  {draft.resources.length === 0 ? (
                    <p className="text-xs text-muted-foreground">No resources.</p>
                  ) : (
                    <div className="space-y-2">
                      {draft.resources.map((resource, index) => {
                        const urlInvalid = !isValidResourceUrl(resource.url)
                        return (
                          <div key={resource.key} className="space-y-2 rounded-lg border border-border bg-card p-2.5">
                            <div className="flex items-center gap-2">
                              <MoveButtons
                                index={index}
                                count={draft.resources.length}
                                onMove={(delta) => setDraft((d) => ({ ...d, resources: moveItem(d.resources, index, delta) }))}
                              />
                              <Input
                                value={resource.label}
                                onChange={(e) => updateResource(resource.key, { label: e.target.value })}
                                placeholder="Label"
                                aria-label="Resource label"
                                className="h-8 w-48 text-sm"
                              />
                              <Input
                                value={resource.url}
                                onChange={(e) => updateResource(resource.key, { url: e.target.value })}
                                placeholder="https://… (optional)"
                                aria-label="Resource URL"
                                aria-invalid={urlInvalid}
                                className={`h-8 flex-1 text-sm ${urlInvalid ? 'border-destructive focus:border-destructive' : ''}`}
                              />
                              <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive hover:text-destructive" onClick={() => removeResource(resource.key)} title="Remove resource" aria-label="Remove resource">
                                <Trash2 className="size-icon-xs" />
                              </Button>
                            </div>
                            {urlInvalid && <p className="pl-16 text-xs text-destructive">That doesn’t look like a URL.</p>}
                            <Textarea
                              value={resource.notes}
                              onChange={(e) => updateResource(resource.key, { notes: e.target.value })}
                              placeholder="Notes for agents (optional)"
                              aria-label="Resource notes"
                              className="min-h-[48px] text-sm"
                            />
                          </div>
                        )
                      })}
                    </div>
                  )}
                </section>

                {/* ── Limits (#65) ── */}
                <section className="space-y-3" aria-label="Limits">
                  <div>
                    <h3 className="text-[13px] font-semibold uppercase tracking-wider text-muted-foreground">Limits</h3>
                    <p className="text-xs text-muted-foreground">
                      Caps on this project’s agents. A start over a limit waits in the queue and runs when it fits. Pausing stops new starts; running sessions carry on.
                    </p>
                  </div>
                  <div className="grid grid-cols-3 gap-4">
                    <div className="space-y-1.5">
                      <Label htmlFor="project-max-agents">Max concurrent agents</Label>
                      <Input
                        id="project-max-agents"
                        type="number"
                        min={1}
                        value={limits.max_concurrent_agents ?? ''}
                        onChange={(e) => patchLimits({ max_concurrent_agents: parseLimitInput(e.target.value) })}
                        placeholder="Unlimited"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="project-daily-sessions">Agent sessions per day</Label>
                      <Input
                        id="project-daily-sessions"
                        type="number"
                        min={1}
                        value={limits.daily_session_cap ?? ''}
                        onChange={(e) => patchLimits({ daily_session_cap: parseLimitInput(e.target.value) })}
                        placeholder="Unlimited"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="project-daily-tokens">Tokens per day</Label>
                      <Input
                        id="project-daily-tokens"
                        type="number"
                        min={1}
                        value={limits.daily_token_cap ?? ''}
                        onChange={(e) => patchLimits({ daily_token_cap: parseLimitInput(e.target.value) })}
                        placeholder="Unlimited"
                      />
                      <p className="text-[11px] text-muted-foreground">Counted once an agent backend reports usage; none does yet.</p>
                    </div>
                  </div>
                  <label className="flex items-center gap-2 text-sm">
                    <Switch checked={limits.paused} onCheckedChange={(checked) => patchLimits({ paused: checked })} aria-label="Pause project" />
                    <span>Paused</span>
                    <span className="text-xs text-muted-foreground">— new starts wait until unpaused</span>
                  </label>
                  {limitState && (
                    <p className="text-xs text-muted-foreground">
                      Right now: {limitState.runningAgents}{limitState.maxConcurrentAgents !== null ? ` of ${limitState.maxConcurrentAgents}` : ''} running
                      {' · '}{limitState.sessionsStartedToday}{limitState.dailySessionCap !== null ? ` of ${limitState.dailySessionCap}` : ''} started today
                      {' · '}{limitState.queued.length} queued
                      {limitState.blockedBy ? ` · the next start waits: ${QUEUE_REASON_LABELS[limitState.blockedBy] ?? limitState.blockedBy}` : ''}
                    </p>
                  )}
                  {limitState?.allProjectsPaused && (
                    <p className="text-xs text-amber-600 dark:text-amber-400">All projects are paused right now (global pause), so nothing starts here either.</p>
                  )}
                </section>

                {/* ── Escalation (#66) ── */}
                <section className="space-y-3" aria-label="Escalation">
                  <div>
                    <h3 className="text-[13px] font-semibold uppercase tracking-wider text-muted-foreground">Escalation</h3>
                    <p className="text-xs text-muted-foreground">
                      What the Mastermind does on its own, does and reports, or asks you about first. “Ask the user first” holds the call until you approve it in the status bar.
                    </p>
                  </div>
                  <div className="space-y-2">
                    {ESCALATION_ACTIONS.map((action) => (
                      <div key={action} className="grid grid-cols-2 items-center gap-4">
                        <Label htmlFor={`project-escalation-${action}`}>{ESCALATION_ACTION_LABELS[action]}</Label>
                        <Select
                          id={`project-escalation-${action}`}
                          value={escalation[action]}
                          onChange={(e) => patchEscalation(action, e.target.value as EscalationLevel)}
                          options={escalationOptions}
                        />
                      </div>
                    ))}
                  </div>
                  <p className="text-[11px] text-muted-foreground">
                    Pull requests are guidance to the Mastermind only: none of its tools opens or merges one.
                  </p>
                </section>

                {/* ── Mastermind wake-ups (#57) ── */}
                <section className="space-y-3" aria-label="Mastermind wake-ups">
                  <div>
                    <h3 className="text-[13px] font-semibold uppercase tracking-wider text-muted-foreground">Mastermind wake-ups</h3>
                    <p className="text-xs text-muted-foreground">
                      What wakes this project’s Mastermind between conversations. Events are batched into one message, changes it made itself are skipped, and wake-ups are capped per hour.
                    </p>
                  </div>
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={wakeups.enabled}
                      onChange={(e) => patchWakeups({ enabled: e.target.checked })}
                      aria-label="Wake the Mastermind on project events"
                    />
                    Wake the Mastermind on project events
                  </label>
                  <div className={`grid grid-cols-2 gap-1.5 pl-5 ${wakeups.enabled ? '' : 'opacity-50'}`}>
                    {PROJECT_EVENT_KINDS.map((kind) => (
                      <label key={kind} className="flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          disabled={!wakeups.enabled}
                          checked={wakeups.kinds.includes(kind)}
                          onChange={(e) => patchWakeups({
                            kinds: e.target.checked
                              ? PROJECT_EVENT_KINDS.filter((k) => k === kind || wakeups.kinds.includes(k))
                              : wakeups.kinds.filter((k) => k !== kind)
                          })}
                          aria-label={PROJECT_EVENT_KIND_LABELS[kind]}
                        />
                        {PROJECT_EVENT_KIND_LABELS[kind]}
                      </label>
                    ))}
                  </div>
                </section>

                {/* ── Scheduled review (#67) ── */}
                <ScheduledReviewSection
                  settings={draft.settings}
                  onChange={(review) => setDraft((d) => ({ ...d, settings: withScheduledReviewSettings(d.settings, review) }))}
                />

                {/* ── Mastermind memory (#55) ── */}
                {project && (
                  <section className="space-y-3" aria-label="Mastermind memory">
                    <div>
                      <h3 className="text-[13px] font-semibold uppercase tracking-wider text-muted-foreground">Mastermind memory</h3>
                      <p className="text-xs text-muted-foreground">
                        What this project’s Mastermind keeps between conversations: decisions, conventions, open threads. It maintains the file itself; ask it to change something.
                      </p>
                    </div>
                    {memory?.content ? (
                      <div className="max-h-72 overflow-y-auto rounded-lg border border-border bg-card px-3 py-2">
                        <Markdown>{memory.content}</Markdown>
                        {memory.truncated && (
                          <p className="mt-2 text-xs text-muted-foreground">Showing the first part of a longer file.</p>
                        )}
                      </div>
                    ) : (
                      <p className="text-xs text-muted-foreground">Nothing remembered yet.</p>
                    )}
                    {memory && <p className="text-[11px] text-muted-foreground/70 font-mono truncate" title={memory.path}>{memory.path}</p>}
                  </section>
                )}

                {/* ── Status history (#72) ── */}
                {project && <ProjectStatusHistory projectId={project.id} />}
              </>
            )}

            {error && <p className="text-sm text-destructive">{error}</p>}

            <div className="flex items-center gap-2 border-t border-border pt-4">
              {project && project.id !== DEFAULT_PROJECT_ID && (
                <Button variant="ghost" size="sm" onClick={handleArchiveToggle}>
                  {project.archived ? <><ArchiveRestore className="size-icon-sm" /> Restore</> : <><Archive className="size-icon-sm" /> Archive</>}
                </Button>
              )}
              <div className="flex-1" />
              <Button variant="ghost" onClick={close}>Cancel</Button>
              <Button onClick={handleSave} disabled={saving || loading || problems.length > 0} title={problems[0]}>
                {saving && <Loader2 className="size-icon-sm animate-spin" />}
                {isNew ? (draft.repos.length === 0 ? 'Create without repos' : 'Create project') : 'Save'}
              </Button>
            </div>
          </DialogBody>
        </DialogContent>
      </Dialog>

      <RepoSelectorDialog
        open={repoPickerOpen}
        onOpenChange={setRepoPickerOpen}
        org={effectiveOrg}
        orgProvider={effectiveProvider}
        initialRepos={NO_INITIAL_REPOS}
        onConfirm={handlePickedRepos}
      />
    </>
  )
}

// ── Status history (#72) ──────────────────────────────────────

const HISTORY_LISTS: Array<[keyof Pick<ProjectStatusJournalEntry, 'completed' | 'blockers' | 'decisions' | 'next_steps'>, string]> = [
  ['completed', 'Completed'],
  ['blockers', 'Blockers'],
  ['decisions', 'Decisions'],
  ['next_steps', 'Next steps']
]

/**
 * The Mastermind's status journal for a project, newest first, one page at a
 * time. Read-only: entries are written by `update_project_status` and rolled
 * up by the retention job; nothing here edits them. Reloads its first page
 * when the Mastermind writes a new status.
 */
function ProjectStatusHistory({ projectId }: { projectId: string }) {
  const [entries, setEntries] = useState<ProjectStatusJournalEntry[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)
  const [revision, setRevision] = useState(0)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setFailed(false)
    Promise.resolve()
      .then(() => projectApi.getStatusHistory(projectId, { limit: 5 }))
      .then((page) => {
        if (cancelled) return
        setEntries(page.entries)
        setCursor(page.has_more ? page.next_cursor : null)
      })
      .catch(() => { if (!cancelled) setFailed(true) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [projectId, revision])

  useEffect(() => projectApi.onStatusChanged((event) => {
    if (event.projectId === projectId) setRevision((r) => r + 1)
  }), [projectId])

  const loadMore = () => {
    if (!cursor || loading) return
    setLoading(true)
    projectApi.getStatusHistory(projectId, { limit: 10, cursor })
      .then((page) => {
        setEntries((current) => {
          const seen = new Set(current.map((entry) => entry.id))
          return [...current, ...page.entries.filter((entry) => !seen.has(entry.id))]
        })
        setCursor(page.has_more ? page.next_cursor : null)
      })
      .catch(() => setFailed(true))
      .finally(() => setLoading(false))
  }

  return (
    <section className="space-y-3" aria-label="Status history">
      <div>
        <h3 className="text-[13px] font-semibold uppercase tracking-wider text-muted-foreground">Status history</h3>
        <p className="text-xs text-muted-foreground">
          What the Mastermind reported after each round of work, newest first. Entries older than three months are rolled up by month.
        </p>
      </div>
      {failed && <p className="text-xs text-destructive">The history could not be loaded.</p>}
      {!failed && entries.length === 0 && !loading && <p className="text-xs text-muted-foreground">No status updates yet.</p>}
      {entries.length > 0 && (
        <ol className="max-h-80 space-y-2 overflow-y-auto" data-testid="project-status-history">
          {entries.map((entry) => (
            <li key={entry.id} className="rounded-lg border border-border bg-card px-3 py-2">
              <div className="mb-1 flex items-center gap-2 text-[11px] text-muted-foreground">
                <span title={entry.created_at}>{formatRelativeDate(entry.created_at)}</span>
                {entry.source === 'compaction' && <Badge variant="default">Monthly roll-up</Badge>}
              </div>
              <p className="whitespace-pre-wrap text-xs text-foreground">{entry.summary}</p>
              {HISTORY_LISTS.map(([key, label]) => entry[key].length > 0 && (
                <div key={key} className="mt-1.5">
                  <p className="text-[11px] font-medium text-muted-foreground">{label}</p>
                  <ul className="list-disc pl-4 text-xs text-muted-foreground">
                    {entry[key].map((item, i) => <li key={i}>{item}</li>)}
                  </ul>
                </div>
              ))}
            </li>
          ))}
        </ol>
      )}
      {cursor && (
        <Button variant="ghost" size="sm" onClick={loadMore} disabled={loading}>
          {loading && <Loader2 className="size-icon-sm animate-spin" />}
          Show older
        </Button>
      )}
    </section>
  )
}
