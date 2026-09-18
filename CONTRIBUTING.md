# Contributing to 20x

Thanks for your interest in contributing! Here's how to get started.

## Prerequisites

- **Node.js** >= 22
- **pnpm** >= 9
- **Git**

## Dev Setup

```bash
git clone https://github.com/krazyjakee/21x.git
cd 21x
pnpm install
pnpm dev
```

**Windows:** Native modules require Visual Studio 2022 Build Tools. See [docs/windows-dev-setup.md](./docs/windows-dev-setup.md) for the full walkthrough (pnpm, MSVC, native rebuild, troubleshooting).

## Project Structure

```
src/
  main/           # Electron main process (SQLite, agents, IPC)
  preload/        # Context bridge
  renderer/       # React UI (Zustand, Tailwind CSS, Radix UI)
  shared/         # Shared constants and types
```

## Code Style

- TypeScript strict mode
- CSS variable tokens (no hardcoded color classes)
- Use `pnpm` (not npm)
- Minimal Tailwind classes

## Commit Convention

We use [Conventional Commits](https://www.conventionalcommits.org/):

- `feat:` — new feature
- `fix:` — bug fix
- `docs:` — documentation only
- `refactor:` — code change that neither fixes a bug nor adds a feature
- `test:` — adding or updating tests
- `chore:` — maintenance tasks

## Pull Request Process

1. Fork the repo and create a branch from `main`
2. Make your changes
3. Run `pnpm lint && pnpm typecheck && pnpm test:run`
4. Open a PR with a clear description of what changed and why

CI (`.github/workflows/verify.yml`) runs lint, typecheck, the build and the full test suite on every PR and push to `main`.

## Pre-commit Hook

`pnpm install` sets up a Husky pre-commit hook that runs in seconds:

- [lint-staged](https://github.com/lint-staged/lint-staged) — ESLint on the staged `.ts`/`.tsx` files only
- `pnpm typecheck`

The build and the test suite are left to CI. Run `pnpm test:run` yourself before opening a PR.

## Testing

```bash
pnpm test          # Watch mode
pnpm test:run      # Single run
pnpm test:main     # Main process tests only
pnpm test:renderer # Renderer tests only
```

## Questions?

Open a [GitHub Discussion](https://github.com/krazyjakee/21x/discussions).
