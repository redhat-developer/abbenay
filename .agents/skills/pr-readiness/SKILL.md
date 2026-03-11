---
name: pr-readiness
description: >
  Checklist for preparing code before creating a pull request. Use this before
  committing, pushing, or creating a PR. Ensures lint, tests, and builds pass
  locally before code reaches CI.
---

# PR Readiness

Before creating a pull request, every change must be validated locally. Never
push code that has not been verified on your machine first. CI exists to catch
cross-platform issues, not to be your first line of defense.

## Required steps before creating a PR

1. **Bootstrap** (if not already done):

   ```bash
   ./bootstrap.sh
   source .build-tools/env.sh
   ```

2. **Install dependencies** (if package.json or lockfile changed):

   ```bash
   npm ci
   ```

3. **Lint** -- must exit 0:

   ```bash
   npm run lint
   ```

4. **Test** -- must exit 0:

   ```bash
   npm test
   ```

5. **Build** -- must exit 0 (verifies TypeScript compilation, SEA injection,
   VSIX packaging):

   ```bash
   npm run ci:build
   ```

6. Only after all of the above pass, commit and push.

## Rules

- **DO NOT** create a PR if lint or tests fail locally. Fix the issues first.
- **DO NOT** push commits hoping CI will tell you what's broken. Run the checks
  yourself.
- **DO NOT** skip the build step. TypeScript compilation errors and SEA fuse
  issues are caught here, not in lint or tests.
- If you are fixing pre-existing lint errors alongside a feature change, verify
  the lint fixes independently before combining them into the PR.
- If a test is flaky, investigate before pushing. Do not merge flaky tests.

## Commit messages

This project uses [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/).
Every commit message must follow the format:

```
<type>[optional scope]: <description>
```

Common types: `feat`, `fix`, `docs`, `style`, `refactor`, `test`, `ci`, `chore`.

Examples:

```
feat(core): add token counting to policy enforcement
fix(daemon): prevent socket leak on reconnect
ci: add linux-arm64 to build matrix
docs: update DEVELOPMENT.md with bootstrap instructions
refactor(vscode): remove unused extensionVersion variable
```

Additional rules:

- The description should explain *why*, not just *what*.
- Separate unrelated changes into separate commits.
- If a PR contains both feature code and lint/style fixes, the lint fixes
  should be in their own commit so they can be reviewed independently.
- Use `!` after the type or a `BREAKING CHANGE:` footer for breaking changes.
