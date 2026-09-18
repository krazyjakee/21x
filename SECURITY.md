# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in 21x, **please do not open a public issue.**

Instead, report it privately through [GitHub's private vulnerability reporting](https://github.com/krazyjakee/21x/security/advisories/new) on krazyjakee/21x.

This is a personally maintained fork, so reports are handled on a best-effort basis.

## Scope

The following are in scope:

- Electron security issues (context isolation bypass, IPC vulnerabilities)
- SQLite injection or data leakage
- OAuth token exposure or mishandling
- API key leakage
- Remote code execution via agent sessions
- Privilege escalation

Out of scope:

- Social engineering attacks
- Vulnerabilities in third-party dependencies (report these upstream)
- Issues requiring physical access to the user's machine

## Disclosure

We follow coordinated disclosure. We'll work with you to understand and fix the issue before any public disclosure.
