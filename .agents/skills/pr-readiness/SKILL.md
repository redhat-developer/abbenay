---
name: pr-readiness
description: >
  Hard gate for code quality before pushing or creating a pull request. MUST be
  followed before every push, every PR, and every PR update. No exceptions.
---

# PR Readiness

This skill defines the mandatory quality gates for the Abbenay project. These
are not suggestions. Code that violates these rules MUST NOT be pushed.

## Local validation gate

Every change MUST pass ALL of the following locally before being pushed to any
remote branch. There are no exceptions. Do not push code hoping CI will tell
you what is broken.

1. **Bootstrap** (first time or after `.node-version` change):

   ```bash
   ./bootstrap.sh
   source .build-tools/env.sh
   ```

2. **Install dependencies** (after any `package.json` or lockfile change):

   ```bash
   npm ci
   ```

3. **Lint** -- MUST exit 0 with zero errors and no new warnings:

   ```bash
   npm run lint
   ```

4. **Test** -- MUST exit 0:

   ```bash
   npm test
   ```

   On Linux, VS Code extension tests require Xvfb:

   ```bash
   xvfb-run -a npm test
   ```

5. **Build** -- MUST exit 0:

   ```bash
   npm run ci:build
   ```

6. Only after steps 3, 4, and 5 all pass may the code be pushed.

### Rules

- You MUST NOT push to a remote branch if lint, test, or build fails locally.
- You MUST NOT create a pull request if lint, test, or build fails locally.
- You MUST NOT push commits hoping CI will surface failures for you.
- You MUST NOT skip the build step. TypeScript compilation errors and SEA fuse
  issues are only caught here.
- **"Pre-existing" failures are not an excuse.** If a test fails, it MUST be
  fixed before pushing -- regardless of whether you wrote the test or the
  failure predates your changes. PRs will not be merged with failing tests.
  The correct action is to fix the test or the code it covers, not to push
  and hope someone else deals with it.
- If a test is flaky, you MUST diagnose and fix the root cause before pushing.
  Do not dismiss flaky tests as acceptable. A test that sometimes fails is
  broken and MUST be repaired.
- **Lint warnings MUST NOT increase.** If the lint baseline has N warnings,
  your change must leave it at N or fewer. Auto-fixable warnings (e.g.,
  `eqeqeq`, `curly`) MUST be resolved by running `eslint --fix` before
  committing. If you encounter warnings unrelated to your change, fix them
  anyway -- the goal is zero warnings, not zero responsibility.
- **Prefer defensive checks over one-time fixes.** When you find a quality
  problem, the preferred response is to add a lint rule, test, or hook that
  prevents recurrence -- not just to fix the immediate instance. One-time
  fixes decay; automated checks are self-sustaining. If you can turn a
  warning into an error, add a pre-commit hook, or write a regression test,
  do that instead of (or in addition to) the manual fix.
- **Do not suppress or exclude lint rules** to make warnings disappear.
  Inline `eslint-disable` comments are acceptable only when the code is
  genuinely correct and the rule cannot be configured to allow it. Blanket
  disables at the file or directory level require justification in the PR.
- prek pre-commit hooks enforce lint and conventional commits at commit time,
  but hooks can be bypassed with `--no-verify`. These rules remain the
  authoritative standard regardless of hook status.

## Commit messages

This project uses [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/).
Every commit message MUST follow the format:

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

- The description MUST explain *why*, not just *what*.
- Separate unrelated changes into separate commits.
- If a PR contains both feature code and lint/style fixes, the lint fixes
  MUST be in their own commit so they can be reviewed independently.
- Use `!` after the type or a `BREAKING CHANGE:` footer for breaking changes.

## Pull request descriptions

PR descriptions MUST accurately reflect the full scope of changes in the
branch at all times. A stale or inaccurate PR description is a defect.

### Rules

- The PR title MUST be a conventional-commit-style summary of the overall
  change (e.g., `feat(ci): add prek hooks and VS Code extension tests`).
- The PR body MUST include:
  - A summary section with bullet points describing what changed and why.
  - A list of the commits in the branch, each with its conventional type.
  - A test plan describing how the changes were validated.
- After pushing additional commits to a PR branch, the PR description MUST
  be updated to include the new commits and reflect the expanded scope.
- A PR whose description says "Add CI badge" but whose branch also contains
  lint fixes, new skill files, and test infrastructure is **wrong**. The
  description must cover everything.
- If a PR grows significantly beyond its original scope, consider splitting
  it into focused PRs instead.

### PR body template

```markdown
## Summary

- <What changed and why, 1-3 bullets>

## Commits

- `<type>(scope): description` -- brief rationale
- `<type>(scope): description` -- brief rationale

## Test plan

- [ ] `npm run lint` passes locally (0 errors)
- [ ] `npm test` passes locally
- [ ] `npm run ci:build` passes locally
- [ ] <any additional manual verification>
```
