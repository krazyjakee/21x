/**
 * Tool definitions for the chat runtime.
 *
 * A tool is a plain async function with a JSON schema. The caller supplies the
 * list (the Commander's delegation tools arrive in a later issue); the runtime
 * never invents tools of its own. Which tools a model can call is therefore
 * enforced by what is passed here, not by prompting.
 */

/** JSON Schema (draft 2020-12) for a tool's input. Always an object at the root. */
export interface ChatToolInputSchema {
  type: 'object'
  properties?: Record<string, unknown>
  required?: string[]
  additionalProperties?: boolean
  [key: string]: unknown
}

export interface ChatToolResult {
  content: string
  isError?: boolean
}

export interface ChatToolContext {
  /** Aborted when the turn is cancelled. Long-running handlers should honour it. */
  signal: AbortSignal
  toolCallId: string
}

export interface ChatToolDefinition {
  name: string
  description: string
  inputSchema: ChatToolInputSchema
  /** A thrown error becomes an `isError` result the model can read; it never ends the turn. */
  handler: (input: Record<string, unknown>, context: ChatToolContext) => Promise<ChatToolResult | string>
}

const TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/

/** Rejects duplicate or malformed names up front so a bad tool list fails loudly, not mid-turn. */
export function validateTools(tools: ChatToolDefinition[]): Map<string, ChatToolDefinition> {
  const byName = new Map<string, ChatToolDefinition>()
  for (const tool of tools) {
    if (!TOOL_NAME.test(tool.name)) throw new Error(`Invalid chat tool name: ${JSON.stringify(tool.name)}`)
    if (byName.has(tool.name)) throw new Error(`Duplicate chat tool name: ${tool.name}`)
    if (tool.inputSchema?.type !== 'object') throw new Error(`Chat tool ${tool.name} must declare an object input schema`)
    byName.set(tool.name, tool)
  }
  return byName
}

/**
 * Runs one tool and always produces a result the model can be shown. Errors
 * are reported, not thrown, because the model should get the chance to recover.
 */
export async function runTool(
  tool: ChatToolDefinition | undefined,
  name: string,
  input: Record<string, unknown>,
  context: ChatToolContext
): Promise<ChatToolResult> {
  if (!tool) return { content: `Unknown tool: ${name}`, isError: true }
  try {
    const result = await tool.handler(input, context)
    return typeof result === 'string' ? { content: result } : { content: result.content, isError: result.isError === true }
  } catch (err) {
    if (context.signal.aborted) throw err
    return { content: err instanceof Error ? err.message : String(err), isError: true }
  }
}
