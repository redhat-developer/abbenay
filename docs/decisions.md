# Decision Log

Lightweight architecture decision records for the Abbenay project. Each entry
captures the *why* behind a choice so future contributors can understand context
without archaeology.

---

## DR-001: Project name "Abbenay"

**Date:** 2026-02-28  
**Decision:** Name the project "Abbenay" after the capital city in Ursula K.
Le Guin's *The Dispossessed*.  
**Rationale:** The novel explores open collaboration across boundaries -- fitting
for an open-source project that bridges many AI providers into a single unified
interface. The npm scope is `@abbenay/*` and the CLI is available as both
`abbenay` and `aby`.

---

## DR-002: Monorepo structure

**Date:** 2026-02-28  
**Decision:** Ship as a monorepo with five packages: `@abbenay/core` (library),
`@abbenay/daemon` (service + CLI), `abbenay-provider` (VS Code extension),
`abbenay-client` (Python client), and `@abbenay/proto` (TypeScript protobuf
stubs).  
**Rationale:** A single repo keeps cross-package changes atomic. The daemon
embeds core, the extension embeds the daemon, and proto is shared -- tight
coupling that benefits from unified CI and versioning.

---

## DR-003: CI as thin wrapper

**Date:** 2026-03-05  
**Decision:** GitHub Actions workflows only call `npm run` scripts.
No `actions/setup-node`, no `actions/setup-python`, no other setup actions.  
**Rationale:** If it can't run locally with `npm run <script>`, it shouldn't
exist. This keeps CI debuggable and prevents workflow lock-in. The only
CI-specific concern is `xvfb-run` for headless VS Code extension tests on Linux.

---

## DR-004: bootstrap.sh toolchain

**Date:** 2026-03-05  
**Decision:** A single `bootstrap.sh` script downloads Node.js (with SEA fuse),
uv (Python toolchain), and prek (pre-commit hooks) into `.build-tools/`. The
only host prerequisites are `curl` and `bash`.  
**Rationale:** Guarantees the exact Node.js binary with `NODE_SEA_FUSE` sentinel
for Single Executable Application builds. Isolates the toolchain from whatever
the developer or CI runner has installed. Auto-detects CI via `$GITHUB_PATH`.

---

## DR-005: Conventional Commits

**Date:** 2026-03-08  
**Decision:** Enforce the Conventional Commits specification via prek +
commitlint at the `commit-msg` hook.  
**Rationale:** Structured commit messages enable automated changelogs and make
git history scannable. The prek hook catches violations before they're pushed.

---

## DR-006: ESLint 9 flat config

**Date:** 2026-03-09  
**Decision:** Use ESLint 9 flat config (`eslint.config.js` / `.mjs`) for all
packages. Dropped ESLint 8 and `@typescript-eslint/eslint-plugin` in favor of
`typescript-eslint` v8.  
**Rationale:** ESLint 8 was deprecated and dragged in deprecated transitive
dependencies (`@humanwhocodes/*`, `rimraf@3`, `glob@7`). Migrating eliminated
all deprecation warnings from `npm install`.

---

## DR-007: npm audit allowlist

**Date:** 2026-03-11  
**Decision:** Use `scripts/audit-check.js` + `.audit-allowlist` to manage known
unfixable vulnerabilities. A prek pre-commit hook runs the check when
`package.json` or `package-lock.json` changes.  
**Rationale:** Three dev-only vulnerabilities (serialize-javascript via mocha via
`@vscode/test-cli`) have no upstream fix. Rather than ignoring all audit output
or setting `audit-level` to hide them, the allowlist makes accepted
vulnerabilities explicit and reviewable. New vulnerabilities fail the hook.

---

## DR-008: PR readiness policy

**Date:** 2026-03-08  
**Decision:** All lint, tests, and builds must pass locally before pushing.
"Pre-existing" failures are not an excuse -- if a test fails, it must be fixed
before the PR. PR descriptions must accurately reflect all commits in the
branch.  
**Rationale:** Catching issues before CI saves time and keeps the main branch
clean. The `.agents/skills/pr-readiness/SKILL.md` codifies this as a hard
policy for AI agents working on the codebase.

---

## DR-009: No tool approval for VS Code-sourced tools

**Date:** 2026-03-04  
**Decision:** Tool approval tiers (auto/ask/always-ask) are not needed for tools
surfaced through VS Code's Language Model API, because VS Code already handles
its own consent UX for tool invocations.  
**Rationale:** Adding a second approval layer on top of VS Code's built-in
consent would create redundant friction without security benefit. The approval
system remains available for CLI and web interfaces where the daemon is the
direct consumer.

---

## DR-010: Platform-specific VSIXes

**Date:** 2026-03-11  
**Decision:** Build separate `.vsix` files per platform (linux-x64, linux-arm64,
darwin-arm64) using `vsce package --target`. Each VSIX bundles the daemon SEA
binary and `keytar.node` for its target platform.  
**Rationale:** The VSIX bundles two native binaries: the daemon SEA (a compiled
Node.js Single Executable Application linked to a specific OS and CPU
architecture) and `keytar.node` (a native addon linked against platform-specific
keychain libraries -- libsecret on Linux, Keychain.framework on macOS). Neither
can run on a different OS or architecture. A "universal" VSIX would need to
bundle all platform variants (tripling size) or would silently fail on
non-matching platforms. Platform-specific VSIXes ensure the marketplace and
manual installs deliver the correct binaries for each user's system.

---

## DR-011: Version from git tag

**Date:** 2026-03-11  
**Decision:** The git tag is the single source of truth for version numbers. A
`scripts/set-version.js` script injects the version from `GITHUB_REF_NAME` into
`package.json` files at build time. The repo keeps `0.0.0-dev` as a placeholder.  
**Rationale:** Eliminates version-bump commits and the risk of forgetting to
update a `package.json`. The tag-based flow is: create tag -> CI builds with
injected version -> release created. No commits needed.

---

## DR-012: Core tarball cross-platform validation

**Date:** 2026-03-11  
**Decision:** Build `@abbenay/core` on all 3 CI runners (linux-x64, linux-arm64,
darwin-arm64) with a smoke test on each, but only upload the npm tarball from
linux-x64.  
**Rationale:** Core is pure JavaScript with no native code, so the output is
identical everywhere. Building and testing on all platforms provides confidence
without producing redundant artifacts. All 3 must pass to gate the release.

---

## DR-013: tar.gz distribution archives

**Date:** 2026-03-11  
**Decision:** Use `.tar.gz` instead of `.zip` for daemon distribution archives.  
**Rationale:** Smaller file size. tar.gz is the standard for Linux/macOS binary
distribution and is natively supported on both platforms.

---

## DR-014: GitHub Releases for artifacts

**Date:** 2026-03-07  
**Decision:** Attach build artifacts to GitHub Releases (triggered by `v*` tags)
for permanent availability outside of CI run retention.  
**Rationale:** CI artifacts expire (default 90 days). GitHub Releases provide
permanent, linkable URLs for each version's binaries, VSIXes, and packages.

---

## DR-015: Decision log

**Date:** 2026-03-11  
**Decision:** Maintain this decision log (`docs/decisions.md`) in the repo.  
**Rationale:** Keeps the "why" behind architectural choices visible and
reviewable alongside the code. Lightweight alternative to full ADRs --
each entry is a paragraph, not a document.

---

## DR-016: Escalate auto-fixable lint rules to error

**Date:** 2026-03-11  
**Decision:** Promote `eqeqeq` and `curly` from `warn` to `error` in all ESLint
configs. Configure `eqeqeq` with `{ null: 'ignore' }` to allow the idiomatic
TypeScript `!= null` pattern (checks both `null` and `undefined`).  
**Rationale:** Warnings that have auto-fix are easy to resolve and should never
accumulate. Making them errors means the prek pre-commit hook catches them
before code is committed. The `null: 'ignore'` option avoids forcing verbose
`!== null && !== undefined` checks when `!= null` is the idiomatic pattern.

---

## DR-017: Defensive checks over one-time fixes

**Date:** 2026-03-11  
**Decision:** When a quality problem is found, the preferred response is to add
a lint rule, test, or hook that prevents recurrence -- not just fix the
immediate instance.  
**Rationale:** One-time fixes decay as new code is written. Automated checks
are self-sustaining. This principle is codified in the pr-readiness skill and
applies to all contributors, human and AI.

## DR-018: CalVer versioning with vsce compatibility

**Date:** 2026-03-11  
**Decision:** Use CalVer format `YYYY.M.MICRO[-prerelease]` for releases
(e.g., `v2026.3.1-alpha`). The VS Code extension receives the version without
the pre-release suffix (e.g., `2026.3.1`) because `vsce` requires strict
`MAJOR.MINOR.PATCH` with no pre-release identifiers. Month numbers must not
have leading zeros (semver prohibits them).  
**Rationale:** `vsce package` rejects any version with a pre-release suffix --
VS Code uses a separate `--pre-release` flag instead. CalVer was chosen over
semver because the project is not yet stable enough for semver semantics to be
meaningful, and date-based versions communicate recency at a glance.

## DR-019: Secure-by-default tool approval

**Date:** 2026-03-12  
**Decision:** All tool calls require user approval unless the tool is explicitly
listed in `tool_policy.auto_approve`. The previous default (auto-approve
everything when no policy is configured) is replaced by ask-by-default.  
**Rationale:** MCP servers can expose arbitrary tools. A malicious or
misconfigured server could execute destructive operations without the user
knowing. Defaulting to "ask" matches browser permission semantics — the user
must grant trust explicitly. Friction is mitigated by session-scoped "allow
always" in the CLI (not persisted) and "Allow & Remember" in the web UI
(persisted to `config.yaml`). Users who want the previous behavior can set
`tool_policy.auto_approve: ['*:*/*']`.

## DR-020: OpenAI-compatible API on the existing Express server

**Date:** 2026-03-12  
**Decision:** Mount OpenAI-compatible `/v1/` routes (`GET /v1/models`,
`POST /v1/chat/completions`) on the existing Express server rather than a
separate process or server.  
**Rationale:** Single server, single port, no extra process management. The
existing Express app already handles CORS, static assets, and SSE. Adding `/v1/`
routes is purely additive and doesn't affect existing `/api/` behavior. Abbenay
composite model IDs (e.g., `openai/gpt-4o`) serve as the `model` field in
OpenAI requests. A new `aby serve` CLI command highlights the OpenAI-compat
angle while reusing the same `startEmbeddedWebServer()` lifecycle.
