/** Advisory metadata, never used to fold/reset sessions or change requests.
 * Unknown models stay unknown; deployments may supply their own exact value. */
export const MODEL_CONTEXT_WINDOWS: Readonly<Record<string, number>> = {
  'gpt-4o': 128_000,
  'gpt-4o-mini': 128_000,
  'gpt-4.1': 1_047_576,
  'gpt-4.1-mini': 1_047_576,
  'o3': 200_000,
  'o4-mini': 200_000,
  'claude-3-5-sonnet': 200_000,
  'claude-3-7-sonnet': 200_000
}

export function modelContextWindow(model: string, overrides: Readonly<Record<string, number>> = {}): number | null {
  const name = model.trim().toLowerCase().split('/').at(-1) ?? ''
  const exact = overrides[model] ?? overrides[name] ?? MODEL_CONTEXT_WINDOWS[name]
  if (Number.isSafeInteger(exact) && exact > 0) return exact
  const dated = Object.keys(MODEL_CONTEXT_WINDOWS).find((key) => name.startsWith(`${key}-20`))
  return dated ? MODEL_CONTEXT_WINDOWS[dated] : null
}
