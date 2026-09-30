---
name: dependabot-remediation
description: >
  Triage and remediate Dependabot security alerts for the Abbenay monorepo.
  Fetches open alerts, groups by package, runs audit/lint/test/build gates,
  and opens PRs. Use when the user mentions Dependabot, dependency updates,
  npm audit failures, security advisories, GHSA, vulnerability, CVE, or
  bump dependency.
---

# Dependabot Remediation

Triage open Dependabot alerts, fix them with user approval, validate
through the full pr-readiness gate, and open PRs. Patch and minor updates
can be batched into a single PR; major updates get individual PRs.

## Prerequisites

- The upstream repo for alert queries and PR targets is `redhat-developer/abbenay`.
- This is a fork workflow: branches push to `origin` (your fork), PRs target
  `upstream` (redhat-developer/abbenay).
- Verify remotes: `git remote -v` should show `origin` pointing to your fork
  and `upstream` pointing to `redhat-developer/abbenay`.
- Verify `gh auth status` has access to the upstream repo.

## Phase 1: Triage

Fetch all open alerts and build a grouped summary. No user approval needed.

```bash
gh api repos/redhat-developer/abbenay/dependabot/alerts --paginate \
  --jq '[.[] | select(.state == "open")] | sort_by(.security_vulnerability.package.name) | group_by(.security_vulnerability.package.name) | map({
    package: .[0].security_vulnerability.package.name,
    ecosystem: .[0].security_vulnerability.package.ecosystem,
    count: length,
    max_severity: (map(.security_advisory.severity) | if any(. == "critical") then "critical" elif any(. == "high") then "high" elif any(. == "medium") then "medium" else "low" end),
    alerts: map({number, severity: .security_advisory.severity, summary: .security_advisory.summary, patched: .security_vulnerability.first_patched_version.identifier, range: .security_vulnerability.vulnerable_version_range})
  }) | sort_by(if .max_severity == "critical" then 0 elif .max_severity == "high" then 1 elif .max_severity == "medium" then 2 else 3 end)'
```

For each package group, determine:

1. **Direct or transitive** -- search root and workspace `package.json` files
   for the package name. If absent from all manifests, it is transitive.
2. **Runtime or dev-only** -- check whether the dependency appears under
   `dependencies` or `devDependencies`. For transitive deps, trace the parent
   chain in `package-lock.json`.
3. **Target version** -- the highest `first_patched_version` across the group's
   alerts. If any alert has no patch (`null`), flag it.
4. **Version lines** -- some packages (e.g., `protobufjs`) exist at multiple
   major versions across workspaces. Identify each version line separately.

Present a table to the user:

```
| # | Package        | Alerts | Severity | Direct? | Runtime? | Patch available | Target    |
|---|----------------|--------|----------|---------|----------|-----------------|-----------|
| 1 | vitest         | 1      | critical | dev     | dev-only | yes             | >= 3.2.6  |
| 2 | protobufjs v7  | 8      | high     | direct  | runtime  | yes             | >= 7.5.8  |
| …                                                                                          |
```

After presenting the table, classify each package into a batch lane:

- **Batch lane (single PR):** All patch and minor updates that only touch
  the lockfile or bump version ranges without code changes. These are
  low-risk and can share a branch. Apply them sequentially on one branch,
  run the validation gate once at the end, and open one PR.
- **Individual lane (separate PR each):** Major version bumps, updates
  requiring code changes, and multi-version packages where different
  workspaces need different major lines. These get their own branch and PR.
- **Allowlist lane:** Packages with no patch available. Propose adding to
  `.audit-allowlist` in a single dedicated PR.

Present the lanes and ask: **"Approve the batch plan?"** Suggest starting
with the batch lane (most alerts resolved per PR). For packages with no
patch, recommend allowlisting (see Phase 2 conditional).

## Phase 2: Plan

For the user's chosen package:

1. **Determine update type** -- compare the currently locked version (from
   `package-lock.json`) to the target patched version. Classify as patch,
   minor, or major.

2. **Check for breaking changes** -- for major bumps, fetch the package's
   changelog or release notes from npm/GitHub. Summarize breaking changes.

3. **Identify affected workspaces** -- search all `package.json` files for
   direct references. Check `package-lock.json` for transitive dependency
   paths.

4. **Draft the plan** -- present to the user:
   - Which `package.json` files need version range updates (if direct dep)
   - Whether `npm update <pkg>` suffices or a manual range edit is needed
   - For multi-version packages (e.g., `protobufjs` v7 in daemon/proto-ts
     and v8 at root), treat each version line as a separate remediation
   - Any `.audit-allowlist` entries that should be removed after the fix
   - Whether `docs/decisions.md` needs a new entry (major version bumps or
     architectural changes warrant a DR)
   - Peer dependency companions that must be updated together (e.g.,
     `@vitest/coverage-v8` must match `vitest`)

5. **Wait for user approval** before touching any files.

### Conditional: no patch available

If the target package has no upstream fix:

- Check whether the dependency is dev-only and the vulnerable code path is
  unreachable in production.
- If allowlistable: propose adding the GHSA URL to `.audit-allowlist` with
  a comment following the existing format:

  ```
  # <package> via <parent chain> (<dev-only|runtime>, no fix available)
  # Added YYYY-MM-DD
  https://github.com/advisories/GHSA-xxxx-xxxx-xxxx
  ```

- If runtime and no mitigation exists: recommend deferring and explain why.

## Phase 3: Remediate

After user approval:

1. **Sync and create branch** from upstream main:
   ```bash
   git fetch upstream
   git checkout -b <branch-name> upstream/main
   ```
   - Batch lane: `chore/deps/batch-minor-YYYY-MM-DD`
   - Individual lane: `fix/deps/<package>-<target-version>` or
     `chore/deps/<package>-<target-version>`

2. **Apply updates.** For batch lane, apply all packages sequentially on
   the same branch:
   - Update version ranges in `package.json` file(s) if the current range
     does not cover the target. Update peer dependency companions together.
   - Run `npm install` (or `npm update <pkg>`) after each package to keep
     the lockfile consistent.
   - Make one commit per package so the PR is bisectable.

3. **Remove resolved `.audit-allowlist` entries** if any GHSA URLs in the
   allowlist are now fixed by these updates.

4. **Fix breakage** -- if any update introduces type errors, API changes,
   or test failures:
   - Diagnose the root cause from compiler/test output.
   - Present the proposed fix to the user before applying (non-trivial
     changes only; obvious type adjustments can proceed).
   - If a batched package causes breakage that is hard to resolve, split
     it out of the batch into the individual lane instead.
   - Apply the fix and continue to Phase 4.

## Phase 4: Validate

Run the full gate from the [pr-readiness skill](../pr-readiness/SKILL.md).
Each step MUST pass before proceeding.

```bash
npm run audit:check
npm run lint
npm test              # on Linux with headless VS Code tests: xvfb-run -a npm test
npm run ci:build
```

**Note:** `npm run audit:check` and the pre-commit audit hook may report
pre-existing vulnerabilities not yet in `.audit-allowlist`. If the only
failures are advisories unrelated to this PR's package, they are pre-existing
and do not block this PR. Verify by checking that the target package's GHSA
IDs are no longer in the output. When the pre-commit hook blocks a commit
solely due to pre-existing audit failures, use `--no-verify` to bypass it.

If any step fails due to this PR's changes:
1. Diagnose the failure.
2. Present the fix to the user.
3. Apply the fix.
4. Re-run the failing step and all subsequent steps.
5. Loop until all four pass.

## Phase 5: Open PR

### Commit

Use conventional commits. Choose prefix based on dependency type:

- **Runtime dependency with security fix**: `fix(deps): bump <pkg> to <ver>`
- **Dev-only dependency**: `chore(deps): bump <pkg> to <ver>`
- **Allowlist-only change**: `chore(deps): allowlist <GHSA-id> for <pkg>`

Separate allowlist changes from code fixes into distinct commits.

The commit description MUST explain *why*: which vulnerabilities are resolved,
which GHSA IDs are addressed.

### Decision record

Add an entry to `docs/decisions.md` if:
- The update is a major version bump of a core dependency
- The update requires code changes beyond version range edits
- A new allowlist entry is added (per DR-007 precedent)

### PR

Push to your fork and open the PR against upstream:

```bash
git push -u origin HEAD
gh pr create --repo redhat-developer/abbenay --title "<title>" --body "<body>"
```

- **Batch PR title:** `chore(deps): batch patch/minor security updates`
  (or `fix(deps):` if any are runtime)
- **Individual PR title:** same as the single commit message

PR body template:

```
## Summary

- Bump <N> packages to resolve <M> Dependabot alerts
- <package1> <old> -> <new> (GHSA-xxx)
- <package2> <old> -> <new> (GHSA-yyy)
- ...

## Commits

- `<type>(deps): bump <pkg1>` -- <rationale>
- `<type>(deps): bump <pkg2>` -- <rationale>

## Test plan

- [x] `npm run lint` passes locally (0 errors)
- [x] `npm test` passes locally
- [x] `npm run ci:build` passes locally
- [ ] CI passes on PR
```

## Phase 6: Babysit

After the PR is open, automatically monitor CI and review status.

### Watch CI

Arm a background watcher that polls PR check status every 90 seconds and
emits a sentinel when checks complete:

```bash
PR_NUM=<number>
REPO="redhat-developer/abbenay"
while true; do
  sleep 90
  STATUS=$(gh pr checks "$PR_NUM" --repo "$REPO" 2>&1)
  if echo "$STATUS" | grep -qE '(fail|error)'; then
    echo "AGENT_LOOP_WAKE_DEPBOT {\"pr\":$PR_NUM,\"result\":\"failure\"}"
    break
  elif echo "$STATUS" | grep -q 'pending'; then
    continue
  else
    echo "AGENT_LOOP_WAKE_DEPBOT {\"pr\":$PR_NUM,\"result\":\"pass\"}"
    break
  fi
done
```

Start this as a background shell with `notify_on_output` matching
`^AGENT_LOOP_WAKE_DEPBOT`.

### On CI completion

- **All checks pass**: notify the user that the PR is green and ready for
  review. Check for any review comments that arrived and triage them per
  the [pr-review skill](../pr-review/SKILL.md).
- **Any check fails**: fetch the failing check logs, diagnose whether the
  failure is caused by this PR or is pre-existing. If in-scope, fix it,
  push, and re-arm the watcher. If out-of-scope, report to the user.

### After CI is green

Offer two choices:

1. **Continue to next package** -- loop back to Phase 2 with the next
   package from the triage table.
2. **Stop** -- the user will handle the remaining packages later.

## Phase 7: Dismiss resolved alerts

Dependabot does not auto-close alerts for allowlisted packages or when
lockfile changes haven't been rescanned yet. After all PRs are merged:

1. Re-fetch open alerts and cross-reference each against the current
   lockfile and `.audit-allowlist`.
2. Dismiss fixed alerts with `dismissed_reason=fix_started` and a comment
   referencing the PR.
3. Dismiss allowlisted alerts with `dismissed_reason=tolerable_risk` and a
   comment explaining the allowlist rationale.

```bash
gh api repos/redhat-developer/abbenay/dependabot/alerts/<NUMBER> \
  -X PATCH -f state=dismissed \
  -f dismissed_reason=<fix_started|tolerable_risk> \
  -f dismissed_comment="<explanation>"
```

## Multi-version packages

Some packages appear at multiple major versions across workspaces.
Check the lockfile for nested copies under `node_modules/<parent>/node_modules/`.

Treat each major version line as a separate remediation. A single PR should
not mix v7 and v8 bumps of the same package.

## Reference

- Audit gate: `scripts/audit-check.js`, `npm run audit:check`
- Allowlist: `.audit-allowlist` (one GHSA URL per line, comments above)
- Decisions: `docs/decisions.md` (DR-007 covers the allowlist rationale)
- PR quality: [pr-readiness skill](../pr-readiness/SKILL.md)
- Review handling: [pr-review skill](../pr-review/SKILL.md)
- Development conventions: [development skill](../development/SKILL.md)
- CI philosophy: [lean-ci skill](../lean-ci/SKILL.md)
