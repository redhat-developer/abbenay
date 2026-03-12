---
name: development
description: >
  Guide for development practices in the Abbenay project. Covers decision
  logging, version management, build architecture, and package structure.
  Use when making architectural choices, adding features, or modifying the
  build system.
---

# Development

This skill defines development practices for the Abbenay project.

## Decision log

The project maintains a lightweight architecture decision record at
`docs/decisions.md`. This log MUST be kept current.

### Rules

- When an architectural, tooling, or process decision is made during
  development, it MUST be recorded in `docs/decisions.md` before the
  relevant code is committed.
- Each entry has a sequential ID (DR-NNN), date, decision statement, and
  rationale explaining *why* the decision was made.
- Entries MUST NOT be deleted. If a decision is superseded, add a new entry
  referencing the old one and mark the old entry as superseded.
- The decision log is a reviewable artifact. PRs that introduce architectural
  changes without a corresponding decision log entry are incomplete.
- When in doubt about whether something is a "decision," err on the side of
  recording it. Minor implementation details can be omitted, but anything
  that affects project structure, tooling, CI, packaging, dependencies, or
  conventions belongs in the log.

### Entry format

```markdown
## DR-NNN: Short title

**Date:** YYYY-MM-DD
**Decision:** What was decided.
**Rationale:** Why this decision was made.
```

If superseding a prior decision:

```markdown
**Supersedes:** DR-XXX
```

## Version management

All package manifests (`package.json`, `pyproject.toml`) and version constants
(`packages/daemon/src/version.ts`, `packages/python/src/abbenay_grpc/__init__.py`)
use `0.0.0-dev` as a placeholder in the repository.

- The git tag is the single source of truth for release versions.
- `scripts/set-version.js` injects the version into all manifests and source
  constants at build time in the release workflow. It is never committed back.
- Do not manually edit version fields. If you add a new location that needs a
  version (e.g., a new package or API response), add a `0.0.0-dev` placeholder
  and update `scripts/set-version.js` to inject it.

## Package structure

The monorepo produces these packages:

| Package | Path | Type | Notes |
|---------|------|------|-------|
| `@abbenay/core` | `packages/daemon/src/core/` | npm (JS) | Built as standalone bundle in `dist/core/` |
| `@abbenay/daemon` | `packages/daemon/` | SEA binary | Single Executable Application via Node.js |
| `abbenay-provider` | `packages/vscode/` | VSIX | Platform-specific; bundles daemon + keytar |
| `abbenay-client` | `packages/python/` | Python wheel | gRPC client library |
| `@abbenay/proto` | `packages/proto-ts/` | npm (TS) | Generated protobuf stubs |

### Key relationships

- The daemon embeds core (it is not a separate dependency at runtime).
- The VSIX embeds the daemon SEA binary and `keytar.node` in its `bin/`
  directory, making it platform-specific.
- Core is also published independently for programmatic use outside the daemon.

## Build system

- `build.js` (root) orchestrates the full build: proto generation, daemon SEA,
  VSIX packaging, and distribution archives.
- `packages/daemon/build.js` handles daemon-specific steps: esbuild bundle,
  core package build, SEA injection via postject.
- Platform-specific VSIXes use `vsce package --target <platform>`.
- Distribution archives are `.tar.gz` with version in the filename.

### Adding new build steps

1. Add the logic as an npm script in the relevant `package.json`.
2. If it's a CI-only concern, prefix with `ci:` (e.g., `ci:package-python`).
3. Wire it into `build.js` if it's part of the standard build flow.
4. Update the lean-ci skill if it changes workflow structure.

## Documentation

Every user-facing change MUST include corresponding documentation updates.
Documentation is not a follow-up task — it ships with the code.

### Rules

- New CLI commands, flags, or subcommands MUST be documented in `README.md`
  (quick start / usage section) and `docs/DEVELOPMENT.md` (detailed reference).
- New or changed APIs in `@abbenay/core` MUST be documented in `docs/CORE.md`.
- Changes to build steps, CI, or release packaging MUST be reflected in
  `docs/DEVELOPMENT.md` and the lean-ci skill.
- A PR that adds a feature without updating the relevant docs is incomplete.

## Testing

Every behavioral change MUST include tests. Tests are not optional and are not
a follow-up task.

### Rules

- New CLI commands MUST have unit tests exercising their data layer (e.g.,
  test the functions the command calls, not the process spawn).
- New or changed core library functions MUST have unit tests.
- Bug fixes MUST include a regression test proving the fix.
- PRs that add features or fix bugs without tests are incomplete.
- Use the `mock` engine for tests that would otherwise require network access
  or API keys.
- Tests MUST NOT sort data before asserting it is sorted — this is tautological
  and will always pass regardless of the actual ordering. Instead, compare the
  original order against a separately sorted copy, or assert pairwise ordering
  on the unsorted result.
- Branching logic (if/else chains, policy tiers, precedence rules) MUST have
  tests covering every branch and combination. These are the most common
  source of subtle bugs caught only in review.
- Interactive prompts that accept multiple inputs with different semantics
  (e.g., `a` vs `A`) MUST have tests for all valid inputs including case
  variants.
- Glob patterns referenced in documentation or config examples MUST be
  validated in a test against real namespaced identifiers.
- Run `npm run test:coverage -w packages/daemon` locally before pushing to
  review uncovered lines in changed files.

## CLI commands

- Read-only CLI commands (listing, querying) MUST use the lightest possible
  state construction. Do not start daemons, servers, or listeners for commands
  that only read data. Use `CoreState` directly instead of `startDaemon()`.
- Never show API keys or secrets on command lines in documentation or examples.
  Demonstrate env var usage (e.g., `# reads OPENAI_API_KEY from env`) and
  reserve `--api-key` flags for exceptional cases only.
- Avoid `process.exit()` in command handlers. Let the command return naturally
  so cleanup runs and `--json` output is not polluted by startup/shutdown logs.

## Dependencies

- Use `npm install --save-dev` for dev dependencies; `npm install --save` for
  runtime dependencies.
- After adding or updating dependencies, run `npm run audit:check` to verify
  no new vulnerabilities are introduced.
- If a new vulnerability has no upstream fix and is dev-only, it may be added
  to `.audit-allowlist` with a comment explaining why and when to re-evaluate.
