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

## DR-021: File-based session storage with JSON index

**Date:** 2026-03-12  
**Decision:** Store sessions as individual JSON files in `getDataDir()/sessions/`
(`$XDG_DATA_HOME/abbenay/sessions/` on Linux) with a companion `index.json`
for fast listing. Each session is `<uuid>.json` containing the full
conversation history plus metadata.  
**Rationale:** JSON files are human-readable, easy to debug, and sufficient for
the expected session count (tens to low hundreds). The index file avoids O(n)
file reads when listing. SQLite is deferred until scale demands it. Sessions
live in the *data* dir (not config dir) because they are user data, not
configuration.

## DR-022: Periodic session summarization every 10 user turns

**Date:** 2026-03-12  
**Decision:** Generate an LLM session summary every 10 user messages via a
fire-and-forget background call, stored on the session as `summary` and
`summaryMessageCount`.  
**Rationale:** Sessions have no explicit close event (CLI gets EOF, web SSE
drops, gRPC streams end — none reliably signal "done"). Periodic summarization
ensures summaries stay reasonably current without requiring user action. The
10-message interval balances freshness against token cost. The `maybeSummarize`
helper is shared across all three transports and catches errors silently to
avoid disrupting the user's chat flow. On-demand summarization is also available
via the `SummarizeSession` gRPC RPC and `GET /api/sessions/:id/summary`.  
**Future work:**
- **Context window management:** The current summary is informational only.
  It is not yet used to compress conversation history when approaching the
  model's context window limit (see `context.context_threshold` /
  `context.compression_strategy` in the roadmap policy table).
- **Session retrieval tool:** No internal MCP/tool is registered that would
  let the LLM query or search past sessions. Adding a `session_lookup` tool
  would allow cross-session knowledge reuse (e.g., "what did we decide last
  time about X?").

---

## DR-023: Inline policy uses full replacement, not merge

**Date:** 2026-03-18  
**Decision:** When a `ChatRequest` carries an inline `PolicyConfig`, it
completely replaces the named policy from model config. There is no field-level
merge between the inline and named policies -- if a caller sends only
`{ sampling: { temperature: 0.0 } }`, they do not inherit the named policy's
`output`, `reliability`, or other fields.  
**Rationale:** Merge semantics create a hidden coupling: the caller's behavior
would depend on whichever named policy the admin configured on the model, which
the caller may not know about or control. A service like APME should not break
because someone changed a named policy in `config.yaml`. Full replacement makes
inline policy hermetic -- behavior is fully determined by what the caller sends.
If merge-on-top-of-named is ever needed, the design doc identifies an explicit
path: add both `policy_name` and inline `PolicyConfig` to the request, with
clear precedence rules and a named base the caller opted into.

---

## DR-024: Privileged consumer model for inline policy authorization

**Date:** 2026-03-18  
**Decision:** Add a `consumers` section to `config.yaml` that maps named
consumer applications to tokens and capability flags. When the section is
present, only consumers with a valid token (passed via `x-abbenay-token` gRPC
metadata) and the `inline_policy` capability can send inline policy on
`ChatRequest`. When the section is absent, inline policy is allowed for all
callers (default-open).  
**Rationale:** Inline policy includes `system_prompt_snippet` with a `replace`
mode that can override the admin's intended system prompt -- a prompt injection
vector if the gRPC endpoint is reachable by untrusted clients. The consumer
model lets the admin explicitly opt in trusted apps (e.g., APME) while keeping
the default frictionless for single-user local deployments. Token-based auth
was chosen over client-type gating because it provides per-app granularity --
the admin can trust APME without trusting all Python clients.

---

## DR-025: Dynamic MCP server registration via gRPC

**Date:** 2026-03-18  
**Decision:** Implement the existing `RegisterMcpServer` and `UnregisterMcpServer`
gRPC RPCs to allow runtime MCP server registration. The recommended flow is
**caller-spawned**: the caller starts its own MCP server and provides connection
details (URL or socket path) — Abbenay connects as an MCP client but does not
spawn processes on behalf of callers. Registrations are ephemeral (not persisted)
and optionally session-scoped (auto-cleaned on session delete or client disconnect).  
**Rationale:** Config-time MCP server registration creates friction for consumer
apps like APME that need session-specific tools (e.g., `ansible-doc` inside a
venv). Dynamic registration lets consumers self-serve without touching the
admin's `config.yaml`. The caller-spawned model keeps Abbenay's security surface
small — it connects to endpoints rather than executing commands on behalf of
callers. Orphaned registrations are handled by four layers: explicit unregister,
client disconnect cleanup, periodic MCP health checks (ping every 60s), and
session deletion hooks. The `mcp_register` consumer capability gates access when
the `consumers` section is present in config (same pattern as DR-024).
`ChatOptions.tool_filter` (proto field 7, previously unimplemented) is also
implemented as a complementary feature, giving callers per-request control over
which tools the LLM sees.

---

## DR-026: Vertex Anthropic engine with Bearer-token proxy support

**Date:** 2026-04-06
**Decision:** Add a `vertex-anthropic` engine backed by `@ai-sdk/google-vertex/anthropic`.
When an API key is configured, inject it as a Bearer token via a synthetic
`authClient` passed to `googleAuthOptions`, bypassing Google credential
discovery. When no key is configured, fall back to standard Google Cloud ADC.
**Rationale:** Corporate Vertex AI proxies (e.g., Red Hat APIcast) front the
Vertex Anthropic API but authenticate with a simple Bearer token instead of
Google OAuth. The `@ai-sdk/google-vertex` Node.js variant requires
`google-auth-library` and always attempts Google credential resolution, which
throws when real GCP credentials are absent. Injecting a synthetic `authClient`
satisfies the library's auth contract without dummy credentials and avoids
needing a fetch wrapper for authentication; proxy deployments may still use a
small fetch wrapper for request sanitization and optional JSON→SSE adaptation,
while keeping the integration aligned with SDK updates. The `base_url` config
field carries the full URL prefix (including any proxy-specific path segments);
the SDK appends `/<model>:streamRawPredict` automatically.

---

## DR-027: Full configuration support via gRPC

**Date:** 2026-05-05
**Decision:** Expand the gRPC `Abbenay` service to support full configuration
management at parity with the daemon's REST API. The proto `Config` message is
replaced with a richer structure matching the on-disk `ConfigFile` (providers
with per-model params, MCP servers, tool policy, consumers). New RPCs are added
for provider CRUD (`ConfigureProvider`, `RemoveProvider`, `GetProviderTemplates`),
MCP server config (`ListMcpServerConfigs`, `ReconnectMcpServer`), policy CRUD
(`CreatePolicy`, `DeletePolicy`), and key status checks (`GetKeyStatus`).
`DiscoverModels` gains a `provider_id` field for daemon-side credential
resolution. `GetConfig`/`UpdateConfig` become location-aware (user vs workspace).
**Rationale:** The VS Code extension communicates exclusively via gRPC, but the
config RPCs were stubbed — `UpdateConfig` was a no-op and `GetConfig` returned
only partial data. Adding a native webview for configuration requires the
extension to read and write the full config through the existing gRPC channel.
Rather than adding HTTP calls to the extension (which would duplicate transport
layers and complicate remote-dev scenarios), bringing gRPC to parity keeps the
architecture clean and benefits all gRPC clients (CLI, Python, future editors).

---

## DR-028: Publish to VS Code Marketplace and OpenVSX

**Date:** 2026-06-15
**Decision:** Automate publishing to the VS Code Marketplace and OpenVSX Registry
as part of the release workflow. VS Code Marketplace uses
`VSCODE_MARKETPLACE_TOKEN` and OpenVSX uses `OVSX_MARKETPLACE_TOKEN`, both
passed to `scripts/publish-vscode.js` which handles multi-platform VSIX
publishing. The publish job uses the `release` GitHub environment. Alpha releases
are excluded from publishing; beta/rc go as pre-release. The extension publisher
is changed from `abbenay` to `redhat`. This follows the Red Hat convention
established by `redhat-developer/vscode-yaml`.
**Rationale:** GitHub Release assets require manual download and sideloading —
fine for early adopters but a barrier to organic adoption. Publishing to both
VS Code Marketplace and OpenVSX ensures coverage for VS Code and compatible
editors (Eclipse Theia, VSCodium, Gitpod). Gating alpha releases prevents
incomplete builds from reaching end users.

---

## DR-029: Fail-closed TLS for non-loopback gRPC TCP binds

**Date:** 2026-07-15
**Decision:** TCP gRPC listeners require TLS (or an explicit `--insecure` opt-in)
when binding to any non-loopback address, including `0.0.0.0` / `::`. Loopback
binds (`127.0.0.1`, `::1`, `localhost`) may remain plaintext for local DX. Unix
sockets stay plaintext (local IPC). `--grpc-tls` enables TLS with auto-generated
self-signed material under the runtime `tls/` directory. Clients that use TCP
(grpc-web-control, Python `AbbenayClient`) support matching SSL credentials;
SSL target name for auto-generated certs is `abbenay-grpc`. The container
default CMD uses `--grpc-tls`.
**Rationale:** Plaintext gRPC on all interfaces exposes API keys, chat, provider
config, and tools. A warning alone is insufficient (finding C2). Fail-closed
startup forces an explicit security choice while preserving localhost DX and
allowing an escape hatch for trusted networks.

---

## DR-030: Secure-by-default HTTP API

**Date:** 2026-07-14
**Decision:** Require Bearer (or SameSite cookie) authentication on all HTTP
routes (`/api/*`, `/v1/*`, `/mcp`) by default, restrict CORS to an explicit
origin allowlist (never `*`), and bind the HTTP server to `127.0.0.1` by
default. Non-localhost bind requires explicit opt-in (`--host`,
`ABBENAY_HTTP_HOST`, or `server.host`). The API token resolves from
`ABBENAY_API_TOKEN` / `server.api_token` / `server.api_token_env`, or is
auto-generated and persisted as `http-api-token` in the config directory.
The dashboard uses `SameSite=Strict` cookies plus a CSRF token for browser
state-changing requests. Prefer `GET/POST /login` (token in the form/body)
over `/?token=` query login to avoid leaking credentials via history,
Referer, and access logs; the query form remains for compatibility and uses
a timing-safe compare. Cookies set the `Secure` flag when the request is
HTTPS or `X-Forwarded-Proto: https`. For local development only,
`ABBENAY_HTTP_AUTH=0` (or `false`/`off`/`no`/`disabled`) turns auth off and
logs a loud warning. Combining auth-disabled with a non-loopback bind
(`0.0.0.0`, LAN IP, etc.) fails closed: the HTTP server refuses to start.
**Rationale:** The previous defaults (no auth, `Access-Control-Allow-Origin: *`,
`app.listen(port)` → `0.0.0.0`) allowed any website the user visited to
cross-origin call the daemon and read/write secrets, config, chat, MCP, and
sessions. Secure-by-default closes that gap while keeping intentional network
exposure possible for containers with an explicit opt-in and a strong token.
An env-var escape hatch keeps local DX workable without baking an insecure
default back into production paths.

---

## DR-031: Session ownership principals

**Date:** 2026-07-14
**Decision:** Stamp every session with an `owner` principal and enforce
owner-scoped list/get/delete/chat on HTTP and gRPC. Principals are
`local` (CLI / local gRPC), `http:<token-fingerprint>` (HTTP API token, with
optional `X-Abbenay-Session-Owner` claim), or `consumer:<name>` (gRPC consumer
token). Legacy sessions without `owner` are treated as `local`. Cross-owner
access returns "not found".
**Rationale:** Authentication alone (DR-030) blocks anonymous access but does
not isolate sessions between authenticated principals sharing one daemon.
Ownership closes H9: HTTP clients, CLI, and named consumers cannot enumerate
or read each other's conversation history.

---

## DR-032: Opt-in OpenAI-compatible tools passthrough on `/v1`

**Date:** 2026-07-17
**Decision:** `/v1/chat/completions` keeps tools disabled by default (DR-019).
Operators may opt in to **passthrough** via global `openai_compat.tools` and/or
per-model `openai_compat_tools` (YAML, or the dashboard checkbox which sets
`passthrough` / clears the override; forcing per-model `off` is YAML-only).
In passthrough,
Abbenay forwards client-provided OpenAI `tools` to the model and returns
structured `tool_calls` (streaming and non-streaming); the **client** executes
tools and posts `role: tool` follow-ups. Abbenay does not run MCP/tool
execution or the approval UI on `/v1`. Resolve order: model override → global →
`off`.
**Rationale:** Clients such as Open WebUI Native function calling need
OpenAI-shaped tool schemas and `tool_calls` through a drop-in `/v1` endpoint.
Forcing tools off forever breaks those clients; enabling Abbenay-side execution
on `/v1` without an approval UI would weaken DR-019. Passthrough preserves the
secure default while unblocking client-executed tools for explicitly opted-in
models.

---

## DR-033: MCP HTTP uses the same tool approval policy as chat

**Date:** 2026-07-17
**Decision:** Every tool invocation on the embedded MCP HTTP endpoint (`/mcp`)
goes through the shared `createToolValidator` / `authorizeToolExecution` helper
used by chat. Precedence is `disabled_tools` → deny, `require_approval` → ask,
`auto_approve` → allow, default → ask (DR-019). Pending MCP approvals block the
MCP `tools/call` until the user resolves them via
`GET/POST /api/mcp/approvals` (dashboard consent UX). `/mcp` remains behind the
DR-030 Bearer/cookie auth gate. There is no executor path that bypasses
`tool_policy`. After connection consent (DR-034), the daemon keeps a
sessionful Streamable HTTP transport per approved `Mcp-Session-Id`
(`enableJsonResponse: true`); non-initialize requests without an approved
session are rejected.
**Rationale:** Finding C3/A2 — `registerTools()` previously invoked executors
directly, so an authenticated (or, before DR-030, open) MCP client could run
tools while skipping approval tiers. Sharing one validator with chat closes
that bypass and keeps policy configuration consistent across surfaces.

---

## DR-034: Explicit consent for MCP client connections

**Date:** 2026-07-17
**Decision:** Before an MCP client may establish a Streamable HTTP session on
`/mcp`, the user must explicitly allow the connection (dashboard /
`POST /api/mcp/connections/:requestId`). `initialize` blocks until allow/deny.
Non-initialize requests without an approved `Mcp-Session-Id` are rejected with
403 so `tools/call` cannot skip connection consent. Optional "Allow & Remember"
keeps a **non-empty** `clientInfo.name` for the daemon lifetime (the default
placeholder `unknown-client` is never remembered — remember is a DX shortcut,
not strong client identity; any token bearer can present a remembered name).
Sessions can be revoked via
`DELETE /api/mcp/connections/sessions/:sessionId`.
**Rationale:** Bearer auth alone (DR-030) proves possession of the API token but
does not express user intent to let a specific MCP client attach. Connection
consent closes the remaining C3 recommendation and stops token-bearing callers
from silently opening an MCP session. API-token holders can both call `/mcp`
and approve via `/api/mcp/connections`, so consent is interactive friction, not
a second principal against a stolen/shared token.
