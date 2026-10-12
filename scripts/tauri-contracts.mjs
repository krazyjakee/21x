#!/usr/bin/env node
/** Parse-only contract generation. No schema, authority or runtime behavior is inferred. */
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { scanRepository, serializeInventory } from './tauri-inventory.mjs'

const nativeCommands = new Set([
  'app:getLoginItemSettings', 'app:getMinimizeToTray', 'app:getNotificationPermission', 'app:getVersion',
  'app:requestNotificationPermission', 'app:setLoginItemSettings', 'app:setMinimizeToTray', 'app:setTitleBarOverlay',
  'attachments:pick', 'chatImages:readClipboard', 'notifications:show',
  'shell:openExternal', 'shell:openPath', 'shell:showItemInFolder',
  'updater:check', 'updater:download', 'updater:getVersion', 'updater:install',
  'voice:getPermission', 'voice:requestPermission', 'voice:pickModelDir'
])
const knownFamilies = new Set(['agent-installer', 'agent', 'agentConfig', 'agentSession', 'app', 'artifact', 'artifacts',
  'attachments', 'browser', 'captainRuntime', 'chat', 'chatImages', 'claudePlugin', 'cliMcp', 'commander', 'concurrency',
  'connectors', 'db', 'env', 'forgejo', 'git', 'github', 'gitlab', 'heartbeat', 'mcp', 'menu', 'mobile', 'notifications',
  'oauth', 'overdue', 'plugin', 'project', 'projectLimits', 'projectRepo', 'projectResource', 'secrets', 'settings',
  'shell', 'skills', 'task', 'taskSource', 'tasks', 'terminal', 'transcript', 'ui', 'updater', 'voice', 'workspace', 'worktree'])
const callbackCommands = new Set(['artifacts:copyFile', 'attachments:open', 'attachments:download',
  'oauth:startFlow', 'oauth:startLocalhostFlow', 'mcp:startOAuthFlow', 'connectors:oauthConnect',
  'voice:setShortcut', 'voice:startTurn', 'voice:tts:speak', 'voice:tts:preview'])
const reviewedEventTypes = {
  'agent:output': 'AgentOutputEvent',
  'agent:output-batch': 'AgentOutputBatchEvent',
  'agent:recoveryStateChanged': 'AgentRecoveryStateChangedEvent',
  'workspace:cleanup-complete': 'WorkspaceCleanupCompleteEvent',
  'task:checkpointAnswered': 'TaskCheckpointAnsweredEvent',
  'task:subtasks-reordered': 'TaskSubtasksReorderedEvent'
}

function name(node) { return ts.isIdentifier(node) || ts.isStringLiteral(node) ? node.text : null }
function methodPath(node) {
  const result = []
  for (let current = node; current; current = current.parent) {
    if (ts.isPropertyAssignment(current)) {
      const part = name(current.name)
      if (part === null) return null
      result.unshift(part)
    }
  }
  return result
}

export function preloadMappings(source, resolvedOperations) {
  const sf = ts.createSourceFile('src/preload/index.ts', source, ts.ScriptTarget.Latest, true)
  const byPosition = new Map(resolvedOperations.filter(item => item.file === 'src/preload/index.ts')
    .map(item => [`${item.line}:${item.column}`, item]))
  const mappings = new Map()
  function visit(node) {
    if (ts.isCallExpression(node)) {
      const position = sf.getLineAndCharacterOfPosition(node.getStart(sf))
      const operation = byPosition.get(`${position.line + 1}:${position.character + 1}`)
      const path = operation && methodPath(node)
      if (operation?.channel && path?.length) {
        const key = `${operation.method}:${operation.channel}`
        const entry = { apiPath: path, method: operation.method,
          arguments: operation.method === 'invoke' || operation.method === 'send'
            ? node.arguments.slice(1).map(argument => argument.getText(sf)) : [],
          source: { file: operation.file, line: operation.line, column: operation.column } }
        const entries = mappings.get(key) ?? []
        if (!entries.some(item => JSON.stringify(item) === JSON.stringify(entry))) entries.push(entry)
        mappings.set(key, entries)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return mappings
}

function apiReference(path) { return 'DesktopApi' + path.map(part => `[${JSON.stringify(part)}]`).join('') }

export function generateDesktopApi(declarationSource) {
  const sf = ts.createSourceFile('electron.d.ts', declarationSource, ts.ScriptTarget.Latest, true)
  const statements = []
  for (const statement of sf.statements) {
    if (ts.isModuleDeclaration(statement)) continue // No global Window/electronAPI declaration.
    if (ts.isImportDeclaration(statement)) {
      const specifier = statement.moduleSpecifier.text
      if (specifier === '@shared/browser-recording') continue
      const converted = specifier.startsWith('@shared/') ? './' + specifier.slice(8)
        : specifier === './index' ? '../renderer/src/types/index' : specifier
      statements.push(ts.factory.updateImportDeclaration(statement, statement.modifiers, statement.importClause,
        ts.factory.createStringLiteral(converted), statement.attributes))
    } else if (ts.isInterfaceDeclaration(statement) && statement.name.text === 'ElectronAPI') {
      statements.push(ts.factory.updateInterfaceDeclaration(statement, [ts.factory.createModifier(ts.SyntaxKind.ExportKeyword)],
        ts.factory.createIdentifier('DesktopApi'), statement.typeParameters, statement.heritageClauses,
        statement.members.filter(member => name(member.name) !== 'browser')))
    } else statements.push(statement)
  }
  const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed })
  const transformed = ts.transform(ts.factory.updateSourceFile(sf, statements), [context => {
    const visit = node => {
      if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) {
        const specifier = node.argument.literal.text
        // agent-store explicitly re-exports this shared enum; do not pull its runtime/store graph into the service.
        const converted = specifier === '@/stores/agent-store' && node.qualifier?.getText(sf) === 'SessionStatus'
          ? './constants' : specifier.startsWith('@shared/') ? './' + specifier.slice(8) : specifier
        if (converted !== specifier) return ts.factory.updateImportTypeNode(node,
          ts.factory.createLiteralTypeNode(ts.factory.createStringLiteral(converted)), node.attributes, node.qualifier, node.typeArguments, node.isTypeOf)
      }
      return ts.visitEachChild(node, visit, context)
    }
    return node => ts.visitNode(node, visit)
  }])
  const printed = printer.printFile(transformed.transformed[0])
  transformed.dispose()
  return '// Generated by scripts/tauri-contracts.mjs from current renderer declarations.\n' +
    '// Types preserve existing signatures; they are not runtime validation or permission grants.\n' +
    printed
}

export function reviewEventForwarding(inventory, operations, review) {
  const unresolved = inventory.operations.filter(item => !item.channel)
  const policies = review?.policies ?? []
  const events = new Map(operations.filter(item => item.kind === 'event' && item.disposition === 'retained').map(item => [item.name, item]))
  const seen = new Set()
  const references = unresolved.map(reference => {
    const matches = policies.filter(policy => ['file', 'line', 'column', 'target', 'method', 'channelExpression'].every(key => policy.source?.[key] === reference[key]))
    if (matches.length !== 1) return { ...reference, forwardingReview: null }
    const policy = matches[0]
    if (seen.has(policy.id) || !policy.allowedNames?.length || new Set(policy.allowedNames).size !== policy.allowedNames.length ||
        policy.allowedNames.some(name => !events.has(name) || policy.channelOwners?.[name] !== events.get(name).owner || policy.destination !== events.get(name).destination) ||
        Object.keys(policy.channelOwners ?? {}).length !== policy.allowedNames.length) throw new Error('Invalid explicit event forwarding review')
    seen.add(policy.id)
    return { ...reference, forwardingReview: { policyId: policy.id, producerOwner: policy.producerOwner,
      allowedNames: policy.allowedNames, channelOwners: policy.channelOwners, destination: policy.destination,
      runtimeEnforcement: policy.runtimeEnforcement } }
  })
  return { references, review: { reviewVersion: review?.reviewVersion ?? 1,
    status: 'manual-source-review; not runtime validation or namespace authority',
    reviewedReferences: seen.size, unreviewedReferences: references.length - seen.size,
    stalePolicies: policies.filter(policy => !seen.has(policy.id)).map(policy => policy.id), policies } }
}

export function buildOperationManifest(inventory, preloadSource, forwardingReview) {
  const mappings = preloadMappings(preloadSource, inventory.operations)
  const channels = [...new Set(inventory.operations.map(item => item.channel).filter(Boolean))].sort()
  const operations = []
  for (const channel of channels) {
    if (!knownFamilies.has(channel.split(':')[0])) throw new Error(`Unassigned operation family: ${channel}`)
    const references = inventory.operations.filter(item => item.channel === channel)
    const hasCommand = references.some(item => item.target === 'ipcMain' || item.target === 'ipcRenderer' && ['invoke', 'send'].includes(item.method))
    const hasEvent = references.some(item => item.target === 'ipcRenderer' && item.method === 'on' ||
      item.target !== 'ipcMain' && item.target !== 'ipcRenderer' && item.method === 'send')
    for (const kind of [hasCommand && 'command', hasEvent && 'event'].filter(Boolean)) {
      const removed = channel.startsWith('browser:')
      const owner = nativeCommands.has(channel) || kind === 'event' && ['menu:', 'updater:'].some(prefix => channel.startsWith(prefix)) ? 'native-host' : 'service'
      const preload = kind === 'command' ? [...(mappings.get(`invoke:${channel}`) ?? []), ...(mappings.get(`send:${channel}`) ?? [])]
        : mappings.get(`on:${channel}`) ?? []
      operations.push({ name: channel, kind, disposition: removed ? 'removed-browser' : 'retained', owner,
        caller: removed ? 'none' : kind === 'command' ? 'trusted-desktop-main' : owner,
        destination: removed ? 'none' : kind === 'command' ? owner : 'trusted-desktop-main',
        nativeCallback: !removed && callbackCommands.has(channel),
        permission: removed ? 'no-registration' : 'exact-operation; validate native caller and domain authorization before effects',
        input: { convention: kind === 'command' ? 'legacy-preload-api-arguments; explicit codec required for IPC transformations'
          : 'validated event payload; targeted desktop delivery only',
          preload: preload.map(item => ({ ...item, typeReference: apiReference(item.apiPath) })),
          reviewedType: kind === 'event' ? reviewedEventTypes[channel] ?? null : null,
          validation: 'required-before-binding; source signatures are not runtime schemas' },
        result: { convention: kind === 'command' ? 'preserve declared undefined/null/void semantics with explicit result codec'
          : 'no request result; subscription returns disposable listener', validation: kind === 'command' ? 'required-before-binding' : 'not-applicable' },
        deadline: '30000ms default; cancellation advisory; no automatic mutation replay',
        references: references.map(({ file, line, column, target, method, resolution }) => ({ file, line, column, target, method, resolution })) })
    }
  }
  const forwarding = reviewEventForwarding(inventory, operations, forwardingReview)
  return { contractVersion: 1, status: 'contract-foundation; G1 not accepted',
    removedFeatures: ['embedded-browser', 'remote-webpage-panels', 'built-in-browser-tools', 'browser-recording-capture', 'browser-cookie-import'],
    retainedSecurity: ['trusted-app-webview', 'sandboxed-artifact-previews', 'external-OAuth', 'external-link-validation'],
    operations, unresolvedReferences: forwarding.references, forwardingReview: forwarding.review,
    localOnlyPreloadMethods: [{ apiPath: ['webUtils', 'getPathForFile'], portableReplacement: 'required; File objects are not stdio payloads' }] }
}

export function generateOperationTypes(manifest) {
  const lines = [
    '// Generated by scripts/tauri-contracts.mjs. Browser operations have no retained typed entry.',
    "import type { DesktopApi } from './desktop-api'",
    "import type { AgentOutputEvent, AgentOutputBatchEvent, AgentRecoveryStateChangedEvent, WorkspaceCleanupCompleteEvent, TaskCheckpointAnsweredEvent, TaskSubtasksReorderedEvent } from './desktop-domain-events'",
    'type CallbackPayload<F> = F extends (...args: infer A) => unknown ? A[0] extends (...data: infer P) => unknown ? P[0] : unknown : unknown',
    'export interface DesktopCommandMap {'
  ]
  for (const operation of manifest.operations.filter(item => item.kind === 'command' && item.disposition === 'retained')) {
    const references = [...new Set(operation.input.preload.map(item => item.typeReference))]
    const args = references.length ? references.map(ref => `Parameters<NonNullable<${ref}>>`).join(' | ') : 'readonly unknown[]'
    const result = references.length ? references.map(ref => `Awaited<ReturnType<NonNullable<${ref}>>>`).join(' | ') : 'unknown'
    lines.push(`  ${JSON.stringify(operation.name)}: { apiArguments: ${args}; result: ${result} }`)
  }
  lines.push('}', 'export interface DesktopEventMap {')
  for (const operation of manifest.operations.filter(item => item.kind === 'event' && item.disposition === 'retained')) {
    const references = [...new Set(operation.input.preload.map(item => item.typeReference))]
    lines.push(`  ${JSON.stringify(operation.name)}: ${references.length ? references.map(ref => `CallbackPayload<NonNullable<${ref}>>`).join(' | ') : operation.input.reviewedType ?? 'unknown'}`)
  }
  lines.push('}', 'export const DESKTOP_OPERATION_MANIFEST = {')
  for (const operation of manifest.operations) lines.push(`  ${JSON.stringify(operation.kind + '/' + operation.name)}: ${JSON.stringify({ name: operation.name, kind: operation.kind,
    disposition: operation.disposition, owner: operation.owner, caller: operation.caller, destination: operation.destination })},`)
  lines.push('} as const', '')
  return lines.join('\n')
}

export function contractOutputs(root) {
  const inventory = scanRepository(root)
  const preloadSource = readFileSync(resolve(root, 'src/preload/index.ts'), 'utf8')
  const review = JSON.parse(readFileSync(resolve(root, 'docs/tauri-migration/event-forwarding-review.json'), 'utf8'))
  const manifest = buildOperationManifest(inventory, preloadSource, review)
  if (manifest.forwardingReview.unreviewedReferences || manifest.forwardingReview.stalePolicies.length) throw new Error('Event forwarding review must cover each current dynamic source site exactly')
  return {
    'docs/tauri-migration/inventory.json': serializeInventory(inventory),
    'docs/tauri-migration/operations.json': serializeInventory(manifest),
    'src/shared/desktop-api.ts': generateDesktopApi(readFileSync(resolve(root, 'src/renderer/src/types/electron.d.ts'), 'utf8')),
    'src/shared/desktop-operations.ts': generateOperationTypes(manifest),
    'src/shared/desktop-event-forwarding.ts': '// Generated finite source-review map; no runtime forwarding is installed by this declaration.\n' +
      'export const DESKTOP_EVENT_FORWARDING = ' + JSON.stringify(Object.fromEntries(review.policies.map(policy => [policy.id, policy])), null, 2) + ' as const\n' +
      'export type DesktopForwardingPolicyId = keyof typeof DESKTOP_EVENT_FORWARDING\n' +
      'export function isReviewedForwardedName(policyId: DesktopForwardingPolicyId, value: unknown): value is string {\n' +
      '  return Object.hasOwn(DESKTOP_EVENT_FORWARDING, policyId) && typeof value === "string" && DESKTOP_EVENT_FORWARDING[policyId].allowedNames.some(name => name === value)\n}\n'
  }
}

export function runContracts(args, root = resolve(dirname(fileURLToPath(import.meta.url)), '..')) {
  if (args.some(arg => arg !== '--check')) throw new Error('Usage: tauri-contracts.mjs [--check]')
  const outputs = contractOutputs(root)
  for (const [path, bytes] of Object.entries(outputs)) {
    if (args.includes('--check')) {
      if (readFileSync(resolve(root, path), 'utf8') !== bytes) throw new Error(`Stale contract output: ${path}`)
    } else {
      let previous
      try { previous = readFileSync(resolve(root, path), 'utf8') } catch (error) { if (error.code !== 'ENOENT') throw error }
      if (previous !== bytes) writeFileSync(resolve(root, path), bytes)
    }
  }
  console.log(`${args.includes('--check') ? 'Verified' : 'Generated'} explicit desktop contract outputs`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { runContracts(process.argv.slice(2)) } catch (error) { console.error(error.message); process.exitCode = 1 }
}
