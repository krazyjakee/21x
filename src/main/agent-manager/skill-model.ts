/**
 * Per-session model choice from skills' optional `preferred_model`.
 *
 * Precedence (see docs/skills.md):
 *  1. A skill's preferred model, taking skills in order: the task's
 *     `skill_ids` first, then the agent's `skill_ids` (deduplicated, the same
 *     merge `writeSkillFiles` uses). The first skill whose preferred model is
 *     usable on the session's backend wins; later requests are ignored.
 *  2. The agent's configured model.
 *
 * Tasks have no model of their own today; if one is added it goes above (1).
 * The result only feeds that session's config; the agent record is never
 * changed. A preferred model the backend does not offer is skipped with a
 * reason, and the session keeps the agent model: it never blocks the run.
 */

export interface SkillModelCandidate {
  name: string
  preferred_model: string | null
}

export interface SkillModelResolution {
  /** Model for this session; undefined leaves the backend default. */
  model: string | undefined
  source: 'skill' | 'agent'
  /** Skill whose preferred model was used. */
  skillName?: string
  /** Why one or more preferred models were not used, when that happened. */
  notice?: string
}

/** Backends whose models use OpenCode's `provider/model` id form. */
const PROVIDER_PREFIXED_BACKENDS = new Set(['opencode', 'pi'])

/** Skill order: task selections first, then agent selections, no repeats. */
export function orderedSkillIds(taskSkillIds?: string[] | null, agentSkillIds?: string[] | null): string[] {
  return [...new Set([...(taskSkillIds ?? []), ...(agentSkillIds ?? [])])]
}

/**
 * Why `model` cannot run on `backend`, or null when it can (or cannot be
 * ruled out). `availableModels` is the backend's model list when known;
 * without it only the id's shape is checked.
 */
export function preferredModelProblem(
  model: string,
  backend: string,
  availableModels?: readonly string[] | null
): string | null {
  if (availableModels && availableModels.length > 0) {
    return availableModels.includes(model) ? null : `not offered by the ${backend} backend`
  }
  const prefixed = model.includes('/')
  if (PROVIDER_PREFIXED_BACKENDS.has(backend)) {
    return prefixed ? null : `${backend} needs a provider/model id`
  }
  if (prefixed) return `provider/model ids are not supported by the ${backend} backend`
  if (backend === 'claude-code' && !/^(claude-|opus|sonnet|haiku|fable)/i.test(model)) {
    return 'not a Claude model'
  }
  return null
}

export function resolveSkillModel(input: {
  agentModel?: string | null
  backend: string
  /** Skills in precedence order (see orderedSkillIds). */
  skills: SkillModelCandidate[]
  availableModels?: readonly string[] | null
}): SkillModelResolution {
  const skipped: string[] = []
  for (const skill of input.skills) {
    const model = skill.preferred_model?.trim()
    if (!model) continue
    const problem = preferredModelProblem(model, input.backend, input.availableModels)
    if (!problem) {
      const overridden = skipped.length > 0 ? ` Skipped: ${skipped.join('; ')}.` : ''
      return {
        model,
        source: 'skill',
        skillName: skill.name,
        notice: overridden ? `Using model ${model} preferred by skill "${skill.name}".${overridden}` : undefined
      }
    }
    skipped.push(`"${skill.name}" prefers ${model} (${problem})`)
  }
  const agentModel = input.agentModel || undefined
  return {
    model: agentModel,
    source: 'agent',
    notice: skipped.length > 0
      ? `Skill preferred model unavailable, using the agent model${agentModel ? ` ${agentModel}` : ''}: ${skipped.join('; ')}.`
      : undefined
  }
}

// Model ids last listed by each backend (OpenCode/Pi provider listings), so
// session setup can validate synchronously. Empty until a listing ran.
const knownModels = new Map<string, string[]>()

export function rememberBackendModels(backend: string, models: string[]): void {
  if (models.length > 0) knownModels.set(backend, models)
}

export function knownBackendModels(backend: string): string[] | null {
  return knownModels.get(backend) ?? null
}

/** Flattens a getProviders result into `provider/model` ids (as the agent form does). */
export function flattenProviderModels(
  result: { providers?: { id: string; models?: unknown }[] } | null | undefined
): string[] {
  const ids: string[] = []
  for (const provider of result?.providers ?? []) {
    const models = provider.models
    if (Array.isArray(models)) {
      for (const m of models as { id?: string }[]) if (m?.id) ids.push(`${provider.id}/${m.id}`)
    } else if (models && typeof models === 'object') {
      for (const [key, m] of Object.entries(models as Record<string, { id?: string } | undefined>)) {
        ids.push(`${provider.id}/${m?.id || key}`)
      }
    }
  }
  return ids
}
