# Retained Git provider bindings

`GitProviderBackend` borrows the actual database, GitHub/GitLab/Forgejo
managers, and shared `GitProviderProcessOwner` from the production owner.
The registry exposes exactly these existing preload commands:

| Provider | Commands |
| --- | --- |
| GitHub | `github:checkCli`, `github:fetchOrgs`, `github:fetchOrgRepos`, `github:fetchUserRepos`, `github:fetchPullRequestDetails` |
| GitLab | `gitlab:checkCli`, `gitlab:fetchOrgs`, `gitlab:fetchOrgRepos`, `gitlab:fetchUserRepos` |
| Forgejo | `forgejo:checkCli`, `forgejo:setLogin`, `forgejo:fetchOrgs`, `forgejo:fetchOrgRepos`, `forgejo:fetchUserRepos` |
| Configuration | `git:recordRepoProviders` |

The typed codecs preserve zero-argument payloads, `org`, `url`, `loginName`,
and `repoFullNames`/`provider` keys. Clearing the selected tea login uses
`null`. Provider mapping preserves the original undefined result through
`{ defined: false }`; an undefined value is never fabricated as JSON null.
There are no added events, generic executable endpoints, CLI installers,
browser authentication controls, or GitLab pull-request routes.

Every invocation requires the current trusted desktop principal, epoch,
WebView label/origin, and global provider configuration read/write grant.
The backend checks actual manager/database/process-owner identities. It
captures the relevant configuration before accepted asynchronous work and
rechecks it before each nested CLI request, after raw results, and immediately
before settings writes. Provider-map SQL byte/type checks run before reading
or parsing stored JSON; malformed or oversized maps are preserved and refused.
Map writes use the existing actual `recordRepoProviders` service and retain
other valid entries and idempotence.

Selecting a tea login first reads the actual bounded CLI summary and requires
the supplied name to occur exactly once. Only then can the actual database
perform one selected-login write. The returned status comes from the real
manager after selection. Cancellation or disconnect after that accepted
write can leave the setting committed while its response is unavailable;
the transport must rehydrate instead of replaying the mutation. The backend
permits one configuration mutation and at most sixteen accepted requests.

Pull-request reads keep the existing shared GitHub-or-configured-Forgejo
selection. GitHub URLs use the actual GitHub manager. Other safe Forgejo PR
URLs must match an actual configured tea login before any server API read.
An unknown server is refused; a URL is never itself an endpoint grant.
Authentication remains in the configured CLI's own files, through the
host-selected finite environment and working directory. No credential values
are returned or copied into renderer-selected environment variables.

Public results contain only finite status, login, repository, organization,
and pull-request fields. URL fields discard credential userinfo, query, and
fragment values before publication; wire decoding rejects unsanitized URL
fields. Tea error messages are fixed by a finite status code, and raw child
errors never cross the service boundary. Human repository descriptions and
PR bodies remain human content, rather than raw CLI diagnostics. Results
are bounded to fewer than 890,000 UTF-8 bytes including the optional-result
envelope, below the private 1 MiB frame budget. Bounds include 2,048 repos,
512 organizations, 64 tea logins, 128 PR checks, 128 KiB PR bodies, and 128
repository names per map mutation. Oversized output is refused, not truncated.

`withRequestGuard` belongs to the actual process owner and retains all raw
children/queued requests accepted by a call, including siblings after a
`Promise.all` failure. Callback delivery, child close, and stdout/stderr drain
are separate receipts. Cancellation requests termination but cannot release
raw ownership. Backend `shutdown()` fences admission and aborts only its
accepted request scopes; `close()` waits those raw guard promises, reporting
an incomplete deadline if they remain live. It does not globally stop the
borrowed process owner. The production owner closes that shared boundary
after all its Git/source/worktree users drain, preserving the database/profile
lease while child ownership remains uncertain.

Authored tests use actual SQLite, actual managers and process owner, with a
controlled trusted `execFile` boundary. They cover provider projections,
configured PR routing, login/map writes, malformed input/results, private URL
and error projection, scope withdrawal, changed configuration, missing CLIs,
native-close ordering, cancellation, and request/mutation bounds. This is
controlled owner evidence, not an installed CLI/login, live provider, native
release, or all-platform proof. CLI installation, native authentication,
remaining worktree integration, configured credential environments, and
installed platform acceptance keep #213/#202/#208 open.
