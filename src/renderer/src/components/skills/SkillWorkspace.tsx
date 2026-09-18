import { useState, useEffect } from 'react'
import { Trash2, BookOpen, Globe } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Textarea } from '@/components/ui/Textarea'
import { Label } from '@/components/ui/Label'
import { Badge } from '@/components/ui/Badge'
import { Select } from '@/components/ui/Select'
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogAction,
  AlertDialogCancel
} from '@/components/ui/AlertDialog'
import { useSkillStore } from '@/stores/skill-store'
import { useProjectStore } from '@/stores/project-store'
import { formatRelativeDate } from '@/lib/utils'
import type { Skill, UpdateSkillDTO } from '@/types'
import { SkillModelPicker } from './SkillModelPicker'
import { SkillScopeBadge } from './SkillList'

const NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/

/** The `Select` value for a scope: '' is global, else the project id. */
const GLOBAL_SCOPE_VALUE = ''

export function SkillWorkspace() {
  const { skills, selectedSkillId, updateSkill, deleteSkill, selectSkill, setSkillProject, error, clearError } = useSkillStore()
  const skill = skills.find((s) => s.id === selectedSkillId)

  if (!skill) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground">
        <div className="text-center space-y-2">
          <BookOpen className="h-10 w-10 mx-auto opacity-40" />
          <p className="text-sm">Select a skill to view or edit</p>
        </div>
      </div>
    )
  }

  return (
    <SkillEditor
      key={skill.id}
      skill={skill}
      onUpdate={updateSkill}
      onDelete={deleteSkill}
      onSetProject={setSkillProject}
      onDeselect={() => selectSkill(null)}
      storeError={error}
      onClearError={clearError}
    />
  )
}

function SkillEditor({ skill, onUpdate, onDelete, onSetProject, onDeselect, storeError, onClearError }: {
  skill: Skill
  onUpdate: (id: string, data: UpdateSkillDTO) => Promise<Skill | null>
  onDelete: (id: string) => Promise<boolean>
  onSetProject: (id: string, projectId: string | null) => Promise<Skill | null>
  onDeselect: () => void
  storeError: string | null
  onClearError: () => void
}) {
  const projects = useProjectStore((s) => s.projects)

  const [name, setName] = useState(skill.name)
  const [description, setDescription] = useState(skill.description)
  const [confidence, setConfidence] = useState(skill.confidence)
  const [tagsInput, setTagsInput] = useState(skill.tags.join(', '))
  const [content, setContent] = useState(skill.content)
  const [preferredModel, setPreferredModel] = useState(skill.preferred_model ?? '')
  const [showDelete, setShowDelete] = useState(false)
  const [nameError, setNameError] = useState<string | null>(null)
  // Scope (#74): changed only through the explicit promote/move flow below,
  // never as part of Save, because it changes which projects see the skill.
  const [scopeValue, setScopeValue] = useState(skill.project_id ?? GLOBAL_SCOPE_VALUE)
  const [showScopeChange, setShowScopeChange] = useState(false)

  useEffect(() => {
    setName(skill.name)
    setDescription(skill.description)
    setConfidence(skill.confidence)
    setTagsInput(skill.tags.join(', '))
    setContent(skill.content)
    setPreferredModel(skill.preferred_model ?? '')
    setNameError(null)
    setScopeValue(skill.project_id ?? GLOBAL_SCOPE_VALUE)
    onClearError()
  }, [skill.id])

  useEffect(() => {
    setScopeValue(skill.project_id ?? GLOBAL_SCOPE_VALUE)
  }, [skill.project_id])

  const scopeOptions = [
    { value: GLOBAL_SCOPE_VALUE, label: 'Global (every project)' },
    ...projects
      .filter((p) => !p.archived || p.id === skill.project_id)
      .map((p) => ({ value: p.id, label: p.archived ? `${p.name} (archived)` : p.name }))
  ]
  const scopeDirty = scopeValue !== (skill.project_id ?? GLOBAL_SCOPE_VALUE)
  const targetProjectName = projects.find((p) => p.id === scopeValue)?.name ?? scopeValue
  const isPromotion = scopeValue === GLOBAL_SCOPE_VALUE

  const handleScopeChange = async () => {
    await onSetProject(skill.id, scopeValue || null)
    setShowScopeChange(false)
  }

  const isDirty = name !== skill.name ||
                  description !== skill.description ||
                  confidence !== skill.confidence ||
                  tagsInput !== skill.tags.join(', ') ||
                  content !== skill.content ||
                  preferredModel.trim() !== (skill.preferred_model ?? '')

  const handleSave = async () => {
    if (!NAME_PATTERN.test(name)) {
      setNameError('Must be lowercase with hyphens (e.g. my-skill)')
      return
    }
    if (!description.trim() || description.length > 1024) {
      return
    }
    setNameError(null)

    const data: UpdateSkillDTO = {}
    if (name !== skill.name) data.name = name
    if (description !== skill.description) data.description = description
    if (confidence !== skill.confidence) data.confidence = confidence

    // Parse tags from comma-separated input
    const newTags = tagsInput.split(',').map(t => t.trim()).filter(t => t.length > 0)
    if (tagsInput !== skill.tags.join(', ')) data.tags = newTags

    if (content !== skill.content) data.content = content
    // An empty picker clears the preference.
    if (preferredModel.trim() !== (skill.preferred_model ?? '')) data.preferred_model = preferredModel.trim() || null

    if (Object.keys(data).length > 0) {
      // The version this editor loaded: a save over a newer version (another
      // editor, the Commander, a learning session) is refused, not merged.
      data.expected_version = skill.version
      onClearError()
      await onUpdate(skill.id, data)
    }
  }

  const handleDelete = async () => {
    await onDelete(skill.id)
    onDeselect()
    setShowDelete(false)
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between border-b px-6 py-4 shrink-0">
        <div className="flex items-center gap-2.5">
          <Badge variant="teal">v{skill.version}</Badge>
          <SkillScopeBadge skill={skill} />
          <span className="text-xs text-muted-foreground">{formatRelativeDate(skill.updated_at)}</span>
        </div>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon" onClick={() => setShowDelete(true)}>
            <Trash2 className="h-3.5 w-3.5 text-destructive" />
          </Button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="max-w-2xl mx-auto px-8 py-8 space-y-5">
          {storeError && (
            <div role="alert" className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {storeError.replace(/^Error: /, '')}
            </div>
          )}

          {/* Scope: who sees this skill (#74) */}
          <div className="space-y-1.5 p-4 rounded-lg bg-accent/50">
            <Label htmlFor="skill-scope">Scope</Label>
            <div className="flex items-center gap-2">
              <Select id="skill-scope" options={scopeOptions} value={scopeValue} onChange={(e) => setScopeValue(e.target.value)} />
              <Button variant="outline" size="sm" disabled={!scopeDirty} onClick={() => setShowScopeChange(true)}>
                <Globe className="h-3.5 w-3.5" />
                {isPromotion ? 'Promote' : 'Move'}
              </Button>
            </div>
            <p className="text-[10px] text-muted-foreground">
              {skill.project_id
                ? 'A project skill: only this project\'s Mastermind and task agents see it. Promoting it makes it visible to every project.'
                : 'A global skill: every project can discover and use it. Moving it into a project hides it from the others.'}
            </p>
          </div>

          {/* Read-only Metadata */}
          <div className="grid grid-cols-2 gap-4 p-4 rounded-lg bg-accent/50">
            <div>
              <Label className="text-xs text-muted-foreground">Uses</Label>
              <p className="text-sm font-medium">{skill.uses}</p>
            </div>
            <div>
              <Label className="text-xs text-muted-foreground">Last Used</Label>
              <p className="text-sm font-medium">{skill.last_used ? formatRelativeDate(skill.last_used) : 'Never'}</p>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="skill-name">Name</Label>
            <Input
              id="skill-name"
              value={name}
              onChange={(e) => {
                setName(e.target.value.toLowerCase().replace(/\s+/g, '-'))
                setNameError(null)
              }}
              placeholder="my-skill-name"
            />
            {nameError && <p className="text-xs text-destructive">{nameError}</p>}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="skill-description">Description</Label>
            <Textarea
              id="skill-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Brief description of when this skill should be used..."
              rows={2}
              maxLength={1024}
            />
            <p className="text-[10px] text-muted-foreground text-right">{description.length}/1024</p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="skill-confidence">Confidence (0.0 - 1.0)</Label>
            <Input
              id="skill-confidence"
              type="number"
              min="0"
              max="1"
              step="0.05"
              value={confidence}
              onChange={(e) => {
                const val = parseFloat(e.target.value)
                if (!isNaN(val) && val >= 0 && val <= 1) {
                  setConfidence(val)
                }
              }}
            />
            <p className="text-[10px] text-muted-foreground">{Math.round(confidence * 100)}%</p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="skill-tags">Tags (comma-separated)</Label>
            <Input
              id="skill-tags"
              value={tagsInput}
              onChange={(e) => setTagsInput(e.target.value)}
              placeholder="api, database, authentication"
            />
            <p className="text-[10px] text-muted-foreground">Separate tags with commas</p>
          </div>

          <SkillModelPicker value={preferredModel} onChange={setPreferredModel} />

          <div className="space-y-1.5">
            <Label htmlFor="skill-content">Content (Markdown)</Label>
            <Textarea
              id="skill-content"
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder="Skill instructions in markdown..."
              rows={16}
              className="font-mono text-xs"
            />
          </div>

          <div className="flex justify-end">
            <Button onClick={handleSave} disabled={!isDirty || !name.trim() || !description.trim() || !content.trim()}>
              Save
            </Button>
          </div>
        </div>
      </div>

      <AlertDialog open={showScopeChange} onOpenChange={setShowScopeChange}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{isPromotion ? 'Promote skill to global' : `Move skill to ${targetProjectName}`}</AlertDialogTitle>
            <AlertDialogDescription>
              {isPromotion
                ? `"${skill.name}" will become visible to every project's Mastermind and task agents, and any of them may assign it.`
                : `Only "${targetProjectName}" will see "${skill.name}". Tasks in other projects and agent defaults that still use it will stop receiving it.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleScopeChange}>{isPromotion ? 'Promote' : 'Move'}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={showDelete} onOpenChange={setShowDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete skill</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete &ldquo;{skill.name}&rdquo;? This skill will no longer be available to agents.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
