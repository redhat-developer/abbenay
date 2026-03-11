# Abbenay Roadmap

Status legend: **done** | **partial** | **stub** | **planned**

---

## 1. Tool Approval Tiers — done (M1–M2)

The `ToolPolicyConfig` already defines three tiers (`auto_approve`, `require_approval`,
`disabled_tools`) and the web dashboard already lets users assign per-tool policies.
`disabled_tools` is enforced at chat time. The other two are **not enforced** — every
non-disabled tool executes immediately.

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

5. **`auto_approve` tier**
   Tools matching `auto_approve` patterns execute without pause (current behavior).
   Tools matching neither tier default to `auto_approve` (current behavior preserved).

6. **`max_tool_iterations` enforcement**
   Enforce the cap in the tool loop inside `streamChat` / `CoreState.chat()`.

### Milestones

- **M1**: Enforce `require_approval` in web chat (approval_request chunk + REST callback) — **done**
- **M2**: CLI `aby chat` with interactive approval — **done**
- **M3**: VS Code backchannel approval flow
- **M4**: `max_tool_iterations` enforcement — **done**

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

## 3. OpenAI-Compatible HTTP Server — planned

Abbenay acts as a *client* to OpenAI-compatible providers but does not expose its own
OpenAI-compatible API. The existing `POST /api/chat` uses a custom SSE format.

### Endpoints to implement

| Endpoint | Priority |
|---|---|
| `GET  /v1/models` | high — list virtual models |
| `POST /v1/chat/completions` | high — streaming + non-streaming |
| `POST /v1/completions` | low — legacy |
| `POST /v1/embeddings` | low — if engines support it |

### Design notes

- Mount at `/v1/` on the existing Express app (alongside `/api/`)
- Map Abbenay virtual model IDs to OpenAI `model` field
- Translate tool calls to OpenAI `tool_calls` format in response chunks
- Support `stream: true` (SSE with `data: {...}\ndata: [DONE]`) and `stream: false`
- API key auth: optional Bearer token configurable via `config.yaml → server.api_key`
- This makes Abbenay a drop-in replacement for any OpenAI-compatible client
  (Cursor, Continue, aider, etc.)

### Milestones

- **M1**: `/v1/models` + `/v1/chat/completions` (streaming)
- **M2**: Non-streaming completions, usage stats
- **M3**: Tool calls in OpenAI format
- **M4**: Optional auth, rate limiting

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

## 5. Session Management — stub

The proto defines 9 session RPCs. All are stubs returning `UNIMPLEMENTED` in
`abbenay-service.ts`. No session storage, no session state.

### Data model

```
Session {
  id: string (uuid)
  title: string (auto-generated or user-provided)
  model: string (composite model ID)
  policy?: string
  messages: Message[]
  created_at: timestamp
  updated_at: timestamp
  metadata: Record<string, string>
  parent_session_id?: string (for forks)
  tags: string[]
}
```

### Storage

- Default: JSON files in `<dataDir>/sessions/<id>.json`
- Index file: `<dataDir>/sessions/index.json` (id, title, model, timestamps)
- Future: SQLite option for large session counts

### RPCs to implement

| RPC | Description | Priority |
|---|---|---|
| `CreateSession` | Create empty session with model + optional policy | high |
| `SessionChat` | Chat within session context (appends messages) | high |
| `GetSession` | Retrieve session by ID | high |
| `ListSessions` | List sessions with optional filters | high |
| `DeleteSession` | Delete session and its file | high |
| `ForkSession` | Clone session to new ID (branching) | medium |
| `ExportSession` | Export as JSON or markdown | medium |
| `ImportSession` | Import from JSON | medium |
| `ReplaySession` | Re-run session messages against (possibly different) model | low |
| `SummarizeSession` | Generate summary via LLM | low |

### Web + CLI integration

- Web dashboard: session sidebar listing past conversations, click to resume
- CLI: `aby chat --session <id>` to resume, `aby sessions list`, `aby sessions export <id>`
- VS Code: session picker in the language model provider

### Milestones

- **M1**: `CreateSession`, `SessionChat`, `GetSession`, `ListSessions`, `DeleteSession`
  — file-based storage, basic CRUD
- **M2**: Web dashboard session sidebar
- **M3**: CLI session commands
- **M4**: `ForkSession`, `ExportSession`, `ImportSession`
- **M5**: `ReplaySession`, `SummarizeSession`

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
| `SessionChat` | stub | section 5 |
| `CreateSession` | stub | section 5 |
| `GetSession` | stub | section 5 |
| `ListSessions` | empty list | section 5 |
| `DeleteSession` | stub | section 5 |
| `ReplaySession` | stub | section 5 |
| `SummarizeSession` | stub | section 5 |
| `ForkSession` | stub | section 5 |
| `ExportSession` | stub | section 5 |
| `ImportSession` | stub | section 5 |

`ListTools` and `ExecuteTool` have no dependencies and can be implemented immediately
by wiring to `ToolRegistry`.

---

## Suggested implementation order

| Phase | Sections | Rationale | Status |
|---|---|---|---|
| **Phase 1** | 1 (M1–M2, M4) + 2 | Tool approval in web + CLI chat | **done** |
| **Phase 2** | 5 (M1–M3) | Session CRUD + UI — enables persistent conversations | next |
| **Phase 3** | 3 (M1–M2) | OpenAI-compatible server — unlocks third-party integrations | |
| **Phase 4** | 6 + 5 (M4–M5) | Session sharing, fork, replay | |
| **Phase 5** | 4 + 7 | Policy Phase 2 (context.*) + remaining gRPC stubs | |
