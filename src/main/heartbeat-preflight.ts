/**
 * Cheap heartbeat pre-flight checks. They read GitHub state through `gh api`
 * so a heartbeat with nothing new can skip the LLM session entirely.
 */
import { execFileAsync } from './find-executable'

const GH_TIMEOUT_MS = 15_000

type GitHubUrl = { owner: string; repo: string; type: 'pull' | 'issue'; number: number }

type PreflightResult = 'no_changes' | 'changes_detected' | 'inconclusive'

type PrState = { mergeable: boolean | null; mergeable_state?: string | null }

/**
 * Matches a GitHub PR/issue URL. Non-global so it is safe for repeated `.test()`
 * calls (a global regex would carry `lastIndex` between calls).
 */
const GITHUB_URL_PATTERN = /https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/(?:pull|issues)\/\d+/

/**
 * Headings whose body is context the agent wrote for itself (status logs, past
 * findings, notes) rather than instructions to run. Lines under these headings
 * are not treated as checks when deciding whether pre-flight covers the file.
 *
 * Whole words only, so e.g. "Backlog" or "Catalog" are not informational.
 */
const INFORMATIONAL_HEADING_PATTERN = /\b(status|findings?|notes?|context|history|summary|progress|log|results?)\b/i

/**
 * Headings that describe work to do. These are never informational, even when
 * they also mention an informational word (e.g. "Status checks", "Monitor logs").
 */
const ACTIONABLE_HEADING_PATTERN = /\b(checks?|checklist|monitor(ing)?|verify|watch|todo|tasks?|instructions?)\b/i

async function ghApi(path: string, jq: string): Promise<string> {
  const { stdout } = await execFileAsync('gh', ['api', path, '--jq', jq], { timeout: GH_TIMEOUT_MS })
  return stdout.trim()
}

async function ghCount(path: string, jq: string): Promise<number> {
  return parseInt(await ghApi(path, jq), 10)
}

/**
 * Checks the GitHub PR/issue links in heartbeat.md for changes since the last check.
 *
 * - 'no_changes': every linked item is unchanged since lastCheck
 * - 'changes_detected': something changed, the LLM should analyze it
 * - 'inconclusive': no links, first run, or a gh error — the LLM decides
 */
export async function runPreflightChecks(heartbeatContent: string, lastCheck: string | null | undefined): Promise<PreflightResult> {
  const githubUrls = extractGitHubUrls(heartbeatContent)
  if (githubUrls.length === 0) return 'inconclusive'
  // Pre-flight can only clear a heartbeat when EVERY check in the file is a
  // GitHub check it knows how to verify with `gh api`. A file that mixes PR
  // links with free-text instructions (e.g. "Monitor if any new transactions
  // appeared in the profiler") would otherwise be marked 'no_changes' purely
  // because GitHub was quiet, and the free-text checks would silently never run.
  if (!preflightCoversAllChecks(heartbeatContent)) return 'inconclusive'
  // First check: the LLM has to establish a baseline.
  if (!lastCheck) return 'inconclusive'

  // CI status is checked for every PR first, even when current-state checks
  // follow, so a CI failure is never missed.
  for (const url of githubUrls.filter(u => u.type === 'pull')) {
    try {
      const headSha = await ghApi(`repos/${url.owner}/${url.repo}/pulls/${url.number}`, '.head.sha')
      if (headSha && await hasFailedCheckRuns(url.owner, url.repo, headSha)) {
        console.log(`[HeartbeatScheduler] Pre-flight: CI failure detected for ${url.owner}/${url.repo}#${url.number}`)
        return 'changes_detected'
      }
    } catch {
      return 'inconclusive'
    }
  }

  // Current-state checks that pre-flight cannot interpret reliably (for example
  // unresolved requested changes) go to the LLM. Conflicts, CI, comments and
  // reviews are covered by the hard checks.
  if (requiresLlmCurrentStateChecks(heartbeatContent)) return 'inconclusive'

  for (const url of githubUrls) {
    try {
      if (await checkGitHubUrlForChanges(url, lastCheck)) return 'changes_detected'
    } catch {
      return 'inconclusive'
    }
  }
  return 'no_changes'
}

/**
 * Whether every check in heartbeat.md is a GitHub check that pre-flight can
 * verify on its own. Only then may pre-flight report 'no_changes' and skip the
 * LLM entirely.
 *
 * A "check line" is any non-empty line that is not a heading, horizontal rule,
 * blockquote, or fenced code — minus the bodies of purely informational
 * sections (`## Current Status`, `## Latest Finding`, …), which agents use to
 * record context rather than instructions.
 *
 * Returns false when there are no check lines at all: an instruction-free file
 * gives pre-flight nothing to reason about, so the LLM should look at it.
 */
export function preflightCoversAllChecks(heartbeatContent: string): boolean {
  let inCodeFence = false
  let inInformationalSection = false
  let checkLines = 0

  for (const rawLine of heartbeatContent.split('\n')) {
    const line = rawLine.trim()
    if (!line) continue

    if (/^(```|~~~)/.test(line)) {
      inCodeFence = !inCodeFence
      continue
    }
    if (inCodeFence) continue

    // Horizontal rules — `---`/`***`/`___` only, never a `- [ ]` list item
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line)) continue
    if (line.startsWith('>')) continue

    if (line.startsWith('#')) {
      inInformationalSection =
        INFORMATIONAL_HEADING_PATTERN.test(line) && !ACTIONABLE_HEADING_PATTERN.test(line)
      continue
    }
    if (inInformationalSection) continue

    checkLines++
    if (!GITHUB_URL_PATTERN.test(line)) return false
  }

  return checkLines > 0
}

/**
 * Whether the heartbeat instructions ask about current state, not just new
 * activity since the last run.
 */
export function requiresCurrentStateChecks(heartbeatContent: string): boolean {
  return /(requested changes|request changes|merge conflict|conflict|ci\b|pipeline|status check|check run)/i.test(heartbeatContent)
}

export function requiresLlmCurrentStateChecks(heartbeatContent: string): boolean {
  return /(requested changes|request changes)/i.test(heartbeatContent)
}

export function hasMergeConflicts(prState: PrState): boolean {
  return prState.mergeable_state === 'dirty'
}

/**
 * Whether a commit has failed check-runs (GitHub Actions etc.) or failed commit
 * statuses (Vercel, external CI). Returns false when the state cannot be read.
 */
export async function hasFailedCheckRuns(owner: string, repo: string, sha: string): Promise<boolean> {
  try {
    const failedCheckRuns = await ghCount(
      `repos/${owner}/${repo}/commits/${sha}/check-runs`,
      '[.check_runs[] | select(.status == "completed" and (.conclusion == "failure" or .conclusion == "timed_out" or .conclusion == "cancelled"))] | length'
    )
    if (failedCheckRuns > 0) return true

    const failedStatuses = await ghCount(
      `repos/${owner}/${repo}/commits/${sha}/status`,
      '[.statuses[] | select(.state == "failure" or .state == "error")] | length'
    )
    return failedStatuses > 0
  } catch {
    return false
  }
}

/** Finds https://github.com/owner/repo/pull/N and .../issues/N links. */
export function extractGitHubUrls(content: string): GitHubUrl[] {
  const urlRegex = /https:\/\/github\.com\/([^/]+)\/([^/]+)\/(pull|issues)\/(\d+)/g
  const results: GitHubUrl[] = []
  let match
  while ((match = urlRegex.exec(content)) !== null) {
    results.push({
      owner: match[1],
      repo: match[2],
      type: match[3] === 'pull' ? 'pull' : 'issue',
      number: parseInt(match[4], 10)
    })
  }
  return results
}

/** Throws on a gh error so the caller can treat the run as inconclusive. */
async function checkGitHubUrlForChanges(url: GitHubUrl, lastCheck: string): Promise<boolean> {
  const base = `repos/${url.owner}/${url.repo}`
  const updatedSince = `[.[] | select(.updated_at > "${lastCheck}")] | length`
  try {
    if (url.type === 'issue') {
      return await ghCount(`${base}/issues/${url.number}/comments`, updatedSince) > 0
    }

    if (await ghCount(`${base}/pulls/${url.number}/comments`, updatedSince) > 0) return true
    if (await ghCount(`${base}/pulls/${url.number}/reviews`, `[.[] | select(.submitted_at > "${lastCheck}")] | length`) > 0) return true
    if (await ghCount(`${base}/issues/${url.number}/comments`, updatedSince) > 0) return true

    const prState = JSON.parse(await ghApi(
      `${base}/pulls/${url.number}`,
      '{ mergeable: .mergeable, mergeable_state: .mergeable_state, head_sha: .head.sha }'
    )) as PrState & { head_sha?: string }
    if (hasMergeConflicts(prState)) return true
    return !!prState.head_sha && await hasFailedCheckRuns(url.owner, url.repo, prState.head_sha)
  } catch (err) {
    console.warn(`[HeartbeatScheduler] Pre-flight check failed for ${url.owner}/${url.repo}#${url.number}:`, err)
    throw err
  }
}
