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

There are no hardcoded version numbers in the repository. All `package.json`
files and `pyproject.toml` use `0.0.0-dev` as a placeholder.

- The git tag is the single source of truth for release versions.
- `scripts/set-version.js` injects the version at build time in the release
  workflow. It is never committed back.
- Do not manually edit version fields in package manifests.

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

## Dependencies

- Use `npm install --save-dev` for dev dependencies; `npm install --save` for
  runtime dependencies.
- After adding or updating dependencies, run `npm run audit:check` to verify
  no new vulnerabilities are introduced.
- If a new vulnerability has no upstream fix and is dev-only, it may be added
  to `.audit-allowlist` with a comment explaining why and when to re-evaluate.
