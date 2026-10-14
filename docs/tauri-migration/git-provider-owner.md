# Portable Git provider process owner

`GitProviderProcessOwner` is the application-owned child-process boundary used
by the actual GitHub, GitLab and Forgejo managers. GitHub and GitLab accept an
optional `{ process, assertCurrent? }` host; Forgejo accepts that host as its
second constructor argument after its existing settings reader. Constructors
without a host retain the existing Electron CLI commands and behavior.
Forgejo requests continue through `tea api`; this boundary adds neither an HTTP
client nor a token reader/store.

## Captured authority

The host supplies the actual `execFile`, approved absolute home/profile cwd,
an immutable finite environment and an application-lifetime assertion.
`assertOwners(processOwner)` verifies each manager's captured owner identity.
`withRequestGuard(effect, beforeEffect, signal?)` carries the current caller's
grant and cancellation through nested manager calls, pagination and fallback.
Every CLI admission and completed raw result rechecks both caller and owner.
An accepted operation is never automatically replayed after an error,
cancellation or a lost grant.

Provider execution is restricted to `gh`, `glab` and `tea`. A separate trusted
`execWorktree('git' | 'gh' | 'glab', args, options)` uses only explicitly supplied
repository/workspace roots, checks physical directory identities and accepts
only `GIT_TERMINAL_PROMPT: '0'` as an environment override. Forgejo's optional
`cloneBare({fullName, barePath, cloneUrl, login})` host callback supplies the
actual worktree clone/configuration implementation. Its absence refuses the
portable clone before CLI or Git effects. Neither seam is a public route for
caller-selected programs, environment or filesystem roots.

The finite environment includes host home/config/temp roots and the provider
variables `GH_TOKEN`, `GITHUB_TOKEN`, `GH_ENTERPRISE_TOKEN`,
`GITHUB_ENTERPRISE_TOKEN`, `GITLAB_TOKEN`, `GITLAB_ACCESS_TOKEN` and `GITLAB_HOST`.
These opaque values go only to the trusted child environment. They are not
returned, logged or persisted by these managers. GitHub documents the token
precedence and enterprise variants in its [environment reference](https://cli.github.com/manual/gh_help_environment).
GitLab documents token precedence and host selection in its
[authentication reference](https://docs.gitlab.com/cli/authentication/) and
[connection reference](https://docs.gitlab.com/cli/connection/).
`SSH_AUTH_SOCK` and explicit configuration directories preserve existing
worktree authentication. `GIT_SSH_COMMAND`, `GIT_ASKPASS`, model keys, task API
tokens and arbitrary inherited variables are refused. CLI prompts, pagers and
update notifiers are disabled. HOME is always the approved host home.

PATH retains only normalized absolute directories, removes empty components
and duplicate directories, and never changes the parent process environment.
An empty captured PATH cannot perform a production symbolic CLI lookup. Fixed
absolute fixture executables are available only through the trusted constructor
test boundary. Directory checks reject links, noncanonical paths and changed
device/inode receipts. These checks establish the exercised Node filesystem
boundary; they are not an atomic kernel containment guarantee across every OS.

## Raw lifecycle and bounds

At most four children execute concurrently, with at most 32 queued requests.
Requests admit at most 64 arguments, 512 KiB per argument and 1 MiB aggregate.
Provider output is bounded to 10 MiB aggregate stdout/stderr per request;
worktree output is bounded to 64 MiB. Provider deadlines are at most 60 seconds
and worktree deadlines at most 300 seconds. Auth/version operations use a
smaller 64 KiB output bound. GitHub and GitLab pagination uses explicit pages
(100 rows, at most 40 pages); Forgejo uses 50-row pages and at most 40 pages.
Aggregate JSON bytes and row counts are bounded; reaching a full final page
fails visibly instead of silently claiming a complete result.

The execFile callback, actual child `close`, and stdout/stderr `close` are
separate required receipts. Error delivery, timeout, SIGTERM or SIGKILL alone
does not release ownership. Cancellation signals only registered child
objects, then retains actual callback/pipe/process completion. Scoped request
guards also join every accepted Promise.all sibling when another branch fails.
`stop()` fences admission and requests owned-child shutdown. `close(timeoutMs)`
joins raw work; a drain deadline reports `GIT_PROVIDER_DRAIN_INCOMPLETE` while
ownership remains retained. Domain backends drain their scoped operations;
the final production owner closes the shared process owner.

Portable failures expose fixed codes/messages and omit raw command lines,
stdout/stderr, credentials, provider bodies and signed/auth material. GitLab
legacy logs are suppressed in the portable host path. Nonzero auth-status
output remains internally parsed for actual logged-in accounts; an unavailable
or unauthenticated CLI remains an explicit status. Owner or caller loss cannot
be converted into a successful fallback.

## Authored evidence and remaining gates

`git-provider-process-owner.test.ts` uses standalone Node fixture programs,
actual child processes, real pipes and temporary physical directories. It covers
callback-before-close and close-before-callback, ignored SIGTERM, deadlines,
output/concurrency/queue bounds, scoped sibling drains, late grant withdrawal,
PATH normalization, finite private environment, unrelated-child preservation,
physical-root replacement, actual-manager authentication/pagination, fixed
Forgejo failures and accepted-mutation/no-follow-on behavior. The clone test
exercises the exact trusted callback and owned worktree process seam; it does
not claim a live Forgejo clone.

No validation was executed by this implementation worker. The coordinator
must run the manager regressions and standalone suite after all sources freeze.
Installed real gh/glab/tea authentication, live provider networking, all-platform
process behavior, installer execution, historical profiles and release/cutover
gates remain separate acceptance work for #213/#208. Synthetic child evidence
does not establish those gates.
