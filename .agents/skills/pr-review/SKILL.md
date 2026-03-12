---
name: pr-review
description: >
  Guide for handling pull request reviews, including automated (Copilot) and
  human reviewer feedback. Use when responding to PR comments, resolving
  review threads, or updating PRs after review.
---

# PR Review

This skill defines how to handle PR review feedback in the Abbenay project.

## Responding to review comments

Every review comment MUST receive a response and resolution. Unanswered
comments block merge.

### Rules

- Address ALL review comments before requesting re-review. Do not leave
  comments unanswered.
- Reply to each comment with a brief explanation of what was done, referencing
  the commit hash (e.g., "Fixed in abc1234.").
- If a comment is a false positive or you disagree, reply with a clear
  technical explanation. Do not dismiss without justification.
- After pushing fixes, update the PR description to reflect the expanded scope
  (per the pr-readiness skill).

## Copilot review patterns

Copilot automated reviews surface recurring categories. Address these
proactively before pushing to avoid review round-trips:

### Tautological tests

Tests that sort data before asserting it is sorted will always pass. Compare
the original output against a separately sorted copy, or validate structural
properties instead.

### Heavyweight state for lightweight operations

Read-only CLI commands (listing, querying) should use the lightest possible
state construction. Do not start daemons, servers, or listeners. Use
`CoreState` directly.

### Secrets in documentation

Never show API keys, tokens, or credentials on command lines in docs or
examples. Demonstrate env var usage instead. Shell history and process lists
expose command-line arguments.

### Inaccurate comments

Code comments and docstrings MUST accurately describe what the code does. If
you rename a function, change behavior, or remove functionality, update all
associated comments in the same commit.

### Redundant conditionals

Expressions like `x ? x : x` or `x && typeof x === 'object' ? x : x` are
always identity operations. Simplify them.

## Workflow

1. After pushing a PR, wait for both CI and Copilot review.
2. Read all Copilot comments and CI logs.
3. Fix all issues in a single commit (or minimal commits).
4. Reply to each comment with the fix commit hash.
5. **Resolve each review thread** after replying. Replying alone does not
   resolve the thread. Use the GitHub GraphQL API:

   ```bash
   # List unresolved threads
   gh api graphql -f query='{
     repository(owner: "OWNER", name: "REPO") {
       pullRequest(number: N) {
         reviewThreads(first: 20) {
           nodes { id isResolved comments(first:1) { nodes { body } } }
         }
       }
     }
   }'

   # Resolve a thread
   gh api graphql -f query='mutation {
     resolveReviewThread(input: {threadId: "THREAD_ID"}) {
       thread { isResolved }
     }
   }'
   ```

6. Update the PR description to include the new commit(s).
7. If CI failure is unrelated to your changes (e.g., flaky prebuild-install),
   fix it anyway — the PR owns the green build.

## Lessons from past reviews

- `keytar` native module requires `libsecret-1-dev` on Linux. The
  `prebuild-install` download can fail non-deterministically, causing source
  compilation to be attempted. Always install `libsecret-1-dev` in CI.
- `process.exit()` in CLI command handlers prevents cleanup and can pollute
  `--json` output with unrelated logs. Let commands return naturally.
- VS Code extension `tsc` errors are not caught by `npm test -w packages/daemon`
  alone. Always run `npm test` (all workspaces) and `tsc --noEmit` for all
  packages before pushing.
