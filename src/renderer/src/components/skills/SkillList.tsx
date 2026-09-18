import { Badge } from '@/components/ui/Badge'
import { formatRelativeDate } from '@/lib/utils'
import { useProjectStore } from '@/stores/project-store'
import { skillScopeLabel } from '@shared/skill-scope'
import type { Skill } from '@/types'

interface SkillListProps {
  skills: Skill[]
  selectedSkillId: string | null
  onSelectSkill: (id: string) => void
  emptyMessage?: string
}

/** The Global / project-name badge every skill row and the editor show (#74). */
export function SkillScopeBadge({ skill, className }: { skill: Pick<Skill, 'project_id'>; className?: string }) {
  const projects = useProjectStore((s) => s.projects)
  const project = skill.project_id ? projects.find((p) => p.id === skill.project_id) : undefined
  const label = skillScopeLabel(skill, project?.name)
  return (
    <Badge variant={skill.project_id ? 'blue' : 'green'} className={className} title={skill.project_id ? `Project skill: ${label}` : 'Global skill: visible to every project'}>
      {label}{project?.archived ? ' (archived)' : ''}
    </Badge>
  )
}

export function SkillList({ skills, selectedSkillId, onSelectSkill, emptyMessage }: SkillListProps) {
  if (skills.length === 0) {
    return (
      <div className="px-4 py-8 text-center text-sm text-muted-foreground">
        {emptyMessage || 'No skills yet. Create one to get started.'}
      </div>
    )
  }

  return (
    <div className="space-y-0.5 px-2">
      {skills.map((skill) => (
        <button
          key={skill.id}
          onClick={() => onSelectSkill(skill.id)}
          className={`w-full text-left rounded-md px-3 py-2.5 cursor-pointer transition-colors ${
            selectedSkillId === skill.id
              ? 'bg-accent'
              : 'hover:bg-accent/50'
          }`}
        >
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium truncate flex-1">{skill.name}</span>
            <div className="flex items-center gap-1.5 shrink-0">
              <span className="text-[10px] text-muted-foreground">{Math.round(skill.confidence * 100)}%</span>
              <Badge className="shrink-0">v{skill.version}</Badge>
            </div>
          </div>
          <p className="text-xs text-muted-foreground mt-0.5 truncate">{skill.description}</p>
          <div className="flex items-center gap-2 mt-1">
            <SkillScopeBadge skill={skill} className="shrink-0 max-w-[10rem] truncate" />
            <p className="text-[10px] text-muted-foreground/70">{formatRelativeDate(skill.updated_at)}</p>
            {skill.uses > 0 && (
              <span className="text-[10px] text-muted-foreground/70">• {skill.uses} uses</span>
            )}
          </div>
        </button>
      ))}
    </div>
  )
}
