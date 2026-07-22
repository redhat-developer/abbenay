# Abbenay Roadmap

Status legend: **done** | **partial** | **stub** | **planned**

---

## 1. Tool Approval Tiers — done (M1–M2)

The `ToolPolicyConfig` defines three tiers (`auto_approve`, `require_approval`,
`disabled_tools`) and the web dashboard lets users assign per-tool policies.
All three tiers are enforced. The default for tools matching no tier is
**require approval** (secure-by-default, DR-019).

### What exists

| Layer | Status |
|---|---|
| `ToolPolicyConfig` type (`auto_approve`, `require_approval`, `disabled_tools`) | done |
| `disabled_tools` filter in `ToolRegistry.listForChat()` | done |
| Web dashboard per-tool policy dropdown (disable / ask / always) | done |
| Policy saved to `config.yaml → tool_policy` | done |
| `PolicyTool.tool_mode` field (`auto` / `ask` / `none`) in `policies.ts` | defined, not enforced |

### What needs to happen

1. **New chat chunk type: `approval_request`**
   Add a `{ type: 'approval_request', toolName, args, requestId }` chunk to the
   `ChatChunk` union. When the executor encounters a tool matching `require_approval`,
   it yields this chunk instead of executing and waits for a response.

2. **Approval callback in `ToolExecutor`**
   Extend `buildExecutor()` (or wrap it) with an `approvalCallback`:
   ```
   (tool: RegisteredTool, args: Record<string, any>) => Promise<'allow' | 'deny'>
   ```
   For web: the callback resolves when the client sends a POST to a new
   `/api/chat/:requestId/approve` endpoint.
   For CLI: the callback resolves from an interactive `readline` prompt.
   For VS Code: the callback delegates through the gRPC backchannel.

3. **Web chat UI: approval prompt**
   When the SSE stream emits an `approval_request` chunk, render an inline card
   with the tool name, arguments, and Allow / Deny buttons. On click, POST to
   `/api/chat/:requestId/approve` which unblocks the callback.

4. **CLI chat command** (see section 2 below)
   The CLI `aby chat` command needs an interactive `readline` prompt for approvals.

5. **`auto_approve` tier** — done
   Tools matching `auto_approve` patterns execute without pause.
   Tools matching neither tier default to **require approval** (secure-by-default,
   see DR-019). Users who want the previous auto-approve-all behavior can set
   `tool_policy.auto_approve: ['*:*/*']`.

6. **`max_tool_iterations` enforcement**
   Enforce the cap in the tool loop inside `streamChat` / `CoreState.chat()`.

### Milestones

- **M1**: Enforce `require_approval` in web chat (approval_request chunk + REST callback) — **done**
- **M2**: CLI `aby chat` with interactive approval — **done**
- **M3**: VS Code backchannel approval flow
- **M4**: `max_tool_iterations` enforcement — **done**
- **M5**: MCP HTTP (`/mcp`) uses the same tool_policy path as chat (DR-033) — **done**

---

## 2. CLI Chat Interface — done

The CLI has no `chat` command today. All chat goes through the web dashboard or gRPC.

### Design

```
aby chat [options]
  -m, --model <id>       Model to use (e.g. openai/gpt-4o)
  -s, --system <prompt>  System prompt
  -p, --policy <name>    Apply a named policy
  --no-tools             Disable tool use
  --json                 Output raw JSON chunks (for piping)
  --session <id>         Resume or create a named session
```

Interactive mode: multi-line input with readline, streaming output to stdout,
tool approval prompts inline. Ctrl+D to end input, Ctrl+C to abort.

Pipe mode (`--json`): emit newline-delimited JSON chunks for scripting.

### Implementation plan

1. Add `chat` command to `packages/daemon/src/daemon/index.ts`
2. Start daemon in-process if not running (same pattern as `web` command)
3. Use `DaemonState.chat()` directly (no gRPC overhead)
4. Render streaming text to stdout with ANSI formatting
5. Render tool calls with approval prompts via `readline`
6. Support `--session` flag once sessions are implemented (section 5)

---

## 3. OpenAI-Compatible HTTP Server — partial (M1 done)

Abbenay now exposes an OpenAI-compatible API alongside the existing `/api/*` routes,
making it a drop-in replacement for any OpenAI-compatible client (Cursor, Continue,
aider, any `openai` SDK script, etc.). See DR-020.

### What exists

| Layer | Status |
|---|---|
| `GET /v1/models` — list virtual models in OpenAI format | done |
| `POST /v1/chat/completions` — streaming SSE (`data: {...}\ndata: [DONE]`) | done |
| `POST /v1/chat/completions` — non-streaming JSON response | done |
| Tool calls mapped to OpenAI `tool_calls` format in stream | done |
| `aby serve` CLI command (starts OpenAI-compat server) | done |
| Format translation helpers with unit tests | done |
| Integration tests (models, streaming, non-streaming, errors, tools) | done |

### What needs to happen

| Endpoint | Priority |
|---|---|
| `POST /v1/completions` | low — legacy |
| `POST /v1/embeddings` | low — if engines support it |
| Usage/token stats (real counts from providers) | medium |
| Bearer token auth on all HTTP routes (`server.api_token` / `ABBENAY_API_TOKEN`) | **done** (DR-030) |
| Localhost-first HTTP bind + CORS allowlist (never `*`) | **done** (DR-030) |
| gRPC TLS / fail-closed non-loopback binds | **done** (DR-029) |
| Air-gap / privacy docs aligned with defaults (finding A4) | **done** — [SECURITY.md](./SECURITY.md) |
| Rate limiting | low |

### Key files

- `packages/daemon/src/daemon/web/openai-compat.ts` — route registration + format helpers
- `packages/daemon/src/daemon/web/openai-compat.test.ts` — unit tests
- `packages/daemon/tests/integration/openai-compat.test.ts` — integration tests

### Milestones

- **M1**: `/v1/models` + `/v1/chat/completions` (streaming + non-streaming + tools) — **done**
- **M2**: Usage stats, HTTP Bearer auth — **auth done** (usage stats remaining)
- **M3**: Rate limiting, `/v1/completions` (legacy)

---

## 4. Policy Enforcement Phase 2 — partial (tool.* done)

The policy pipeline (resolve → flatten → merge → apply) is fully wired for sampling,
output, and reliability fields. Several fields are defined but logged as unenforced.

### Unenforced fields

| Field | What it should do |
|---|---|
| `output.reserved_output_tokens` | Reduce `max_tokens` by this amount to leave room for tool results |
| `context.context_threshold` | Trigger context compression when message tokens exceed threshold |
| `context.compression_strategy` | `truncate` oldest messages or `rolling_summary` via LLM |
| `tool.tool_mode` | Override tool mode per-policy (`auto` / `ask` / `none`) — **done** |
| `tool.max_tool_iterations` | Cap tool execution rounds — **done** |

### Dependencies

- `tool.*` fields depend on section 1 (tool approval tiers)
- `context.*` fields require a token counting utility (tiktoken or model-specific)

---

## 5. Session Management — partial (M1+M3 done)

Sessions are stored as JSON files in `$XDG_DATA_HOME/abbenay/sessions/` with a
companion `index.json` for fast listing. See DR-021.

### What exists

| Layer | Status |
|---|---|
| `SessionStore` class (core, file-based CRUD + index) | done |
| `getDataDir()` / `getSessionsDir()` path utilities | done |
| `SessionStore` wired into `DaemonState` | done |
| gRPC: `CreateSession`, `GetSession`, `ListSessions`, `DeleteSession`, `SessionChat` | done |
| Web API: `POST/GET/DELETE /api/sessions`, `POST /api/sessions/:id/chat` (SSE) | done |
| CLI: `aby sessions list/show/delete`, `aby chat --session <id>` | done |
| Unit tests: `session-store.test.ts` (19 tests) | done |
| Integration tests: `tests/integration/sessions.test.ts` (11 tests) | done |

### What needs to happen

| Feature | Priority |
|---|---|
| `ForkSession` gRPC + web API | medium |
| `ExportSession` / `ImportSession` | medium |
| `ReplaySession` / ~~`SummarizeSession`~~ | low (SummarizeSession done) |
| Web dashboard session sidebar UI | medium |
| VS Code session picker | low |
| SQLite storage backend (large session counts) | low |
| Session TTL / auto-cleanup | low |
| `WatchSessions` (real-time events) | low |

### Milestones

- **M1**: `CreateSession`, `SessionChat`, `GetSession`, `ListSessions`, `DeleteSession`
  — file-based storage, basic CRUD — **done**
- **M2**: Web dashboard session sidebar
- **M3**: CLI session commands — **done**
- **M4**: `ForkSession`, `ExportSession`, `ImportSession`
- **M5**: `ReplaySession`, ~~`SummarizeSession`~~ (done)

---

## 6. Session Sharing — planned

Export and import sessions for collaboration, debugging, and reproducibility.

### Export formats

| Format | Use case |
|---|---|
| JSON | Machine-readable, full fidelity (messages, tool calls, metadata) |
| Markdown | Human-readable transcript |
| HTML | Standalone shareable page with styling |

### Sharing flows

1. **File export**: `aby sessions export <id> --format json|md|html > file`
2. **Web share link**: `POST /api/sessions/:id/share` generates a static HTML page
   served at `/shared/<token>`. No auth required for read-only access. Optionally
   time-limited.
3. **Import**: `aby sessions import < file.json` or `POST /api/sessions/import`

### Privacy controls

- Strip API keys and secrets before export (already not in messages)
- Option to redact tool call arguments (`--redact-args`)
- Option to strip system prompts (`--strip-system`)

### Dependencies

- Requires section 5 (session management) to be at M1

---

## 7. gRPC Stubs — stub

Several gRPC RPCs in `abbenay-service.ts` are unimplemented stubs.

| RPC | Status | Depends on |
|---|---|---|
| `ListTools` | stub | — |
| `ExecuteTool` | stub | — |
| `UpdateConfig` | no-op stub | — |
| `SessionChat` | done | section 5 |
| `CreateSession` | done | section 5 |
| `GetSession` | done | section 5 |
| `ListSessions` | done | section 5 |
| `DeleteSession` | done | section 5 |
| `ReplaySession` | stub | section 5 |
| `SummarizeSession` | **done** | section 5 |
| `ForkSession` | stub | section 5 |
| `ExportSession` | stub | section 5 |
| `ImportSession` | stub | section 5 |

`ListTools` and `ExecuteTool` have no dependencies and can be implemented immediately
by wiring to `ToolRegistry`.

---

## 8. Air-gap docs vs network exposure (A4) — done

Product copy historically overstated air-gap / privacy while defaults exposed
HTTP on all interfaces, plaintext gRPC, and wildcard CORS. Docs now state the
real defaults and that **network isolation alone does not secure Abbenay** —
see [SECURITY.md](./SECURITY.md) (DR-038), including the operator checklist
(bind, auth, CORS, TLS, consumers, MCP) and residual risks. Release notes:
`packages/vscode/CHANGELOG.md` (Unreleased → Security). Code fixes: DR-030 /
DR-029.

---

## Suggested implementation order

| Phase | Sections | Rationale | Status |
|---|---|---|---|
| **Phase 1** | 1 (M1–M2, M4) + 2 | Tool approval in web + CLI chat | **done** |
| **Phase 2** | 3 (M1) | OpenAI-compatible server — unlocks third-party integrations | **done** |
| **Phase 3** | 5 (M1+M3) | Session CRUD + CLI — enables persistent conversations | **done** |
| **Phase 4** | 6 + 5 (M4–M5) | Session sharing, fork, replay | |
| **Phase 5** | 4 + 7 | Policy Phase 2 (context.*) + remaining gRPC stubs | |
