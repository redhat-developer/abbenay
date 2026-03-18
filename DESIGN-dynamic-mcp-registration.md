# Design: Dynamic MCP Server Registration via gRPC

## Status

Accepted — implemented in `feat/dynamic-mcp-registration` (DR-025).

## Problem

Abbenay's MCP server integration currently only supports **config-time** registration: MCP servers are declared in `config.yaml` under `mcp_servers`, connected at daemon startup, and their tools are globally available to all chat calls. The `RegisterMcpServer` and `UnregisterMcpServer` RPCs exist in the proto but are unimplemented stubs.

```yaml
# Current: static config only
mcp_servers:
  filesystem:
    transport: stdio
    command: npx
    args: ["-y", "@modelcontextprotocol/server-filesystem", "/home/user"]
    enabled: true
```

There is no way for a gRPC caller to register an MCP server at **runtime** — either globally for the daemon's lifetime or scoped to a specific session. This forces every consumer that needs custom tools to pre-configure them in the admin's `config.yaml`, creating setup friction and coupling consumer requirements to daemon configuration.

## Motivation: APME Ansible Docstring Retrieval

APME's AI escalation flow sends Ansible-specific remediation requests to an LLM via Abbenay. When the LLM proposes fixes for violations like `M001` (FQCN migration), it needs access to Ansible module documentation to produce accurate fixes — correct parameter names, deprecated aliases, return values, etc.

APME ships a lightweight MCP server (`apme-mcp-ansible-doc`) that wraps `ansible-doc` via APME's session-scoped virtual environments. This tool:

- Takes a module FQCN (e.g., `ansible.builtin.copy`) and returns the module's docstring
- Runs inside APME's venv session (which has the correct collections installed)
- Is only relevant during APME remediation — not useful to other Abbenay consumers
- APME owns the MCP server lifecycle — it starts the server, uses it during remediation, and stops it when done

Today, APME would need the user to:

1. Manually add the MCP server entry to `~/.config/abbenay/config.yaml`
2. Restart or refresh the daemon
3. Hope no other consumer is confused by an `ansible-doc` tool appearing globally

None of these are acceptable for a frictionless `apme-scan fix --ai` experience.

## Proposal

Implement the existing `RegisterMcpServer` and `UnregisterMcpServer` RPCs to allow gRPC callers to register MCP servers at runtime. The **caller starts the MCP server** and provides connection details (URL or socket path) — Abbenay connects as an MCP client but does not spawn processes on behalf of callers. Registrations are **ephemeral** (not persisted to config) and optionally **session-scoped** (auto-cleaned on session end or client disconnect).

**Why caller-spawned?** The caller (e.g., APME) owns the MCP server lifecycle — it knows the correct scope, duration, virtual environment, and dependencies. Having Abbenay spawn processes on behalf of callers creates split lifecycle ownership and a significant security surface (arbitrary command execution, env injection). By keeping Abbenay as a pure MCP *client* for dynamic registrations, the security model reduces to "can this caller connect us to an endpoint?" rather than "can this caller execute commands on the host?"

Stdio transport remains available for **config-based** MCP servers (where the admin trusts the config) and is accepted but discouraged for dynamic registration (it carries the security implications documented below).

### Proto Changes

Expand the existing `RegisterMcpServerRequest` to carry the full connection config:

```protobuf
message RegisterMcpServerRequest {
  string server_id = 1;                  // e.g., "apme-ansible-doc"
  McpTransport transport = 2;            // connection details
  optional string session_id = 3;        // scope to session (auto-cleanup)
  repeated string tool_filter = 4;       // only expose these tools (empty = all)
  optional int32 max_response_size = 5;  // per-tool-call limit in bytes (default 100KB)
}

message McpTransport {
  string type = 1;                       // "stdio" | "http" | "sse"
  optional string command = 2;           // stdio: command to run
  repeated string args = 3;             // stdio: command arguments
  optional string url = 4;              // http/sse: endpoint URL
  map<string, string> headers = 5;      // http/sse: auth headers
  map<string, string> env = 6;          // stdio: environment variables
}

message RegisterMcpServerResponse {
  bool success = 1;
  string error = 2;                      // empty on success
  repeated string discovered_tools = 3;  // tools found after connection
}

message UnregisterMcpServerRequest {
  string server_id = 1;
}

message UnregisterMcpServerResponse {
  bool success = 1;
}
```

### Registration Scoping

Two modes:

| Mode | Behavior |
|------|----------|
| **Global** (no `session_id`) | Tools available to all chat calls. Persists until `UnregisterMcpServer`, client disconnect, or daemon restart. |
| **Session-scoped** (`session_id` set) | Tools only available in that session's `SessionChat` calls. Auto-unregistered when session is deleted or expires. |

Session-scoped tools are only accessible via the `SessionChat` RPC (which carries a `session_id`). The stateless `Chat` RPC does not have a session context, so session-scoped tools are never exposed there. This is a deliberate restriction -- callers that need session-scoped tools should use `SessionChat`.

For global registrations, the daemon tracks the `client_id` of the registering caller. When a client disconnects (`Unregister`), its global dynamic registrations are cleaned up automatically. This prevents orphaned MCP server processes when a client crashes without calling `UnregisterMcpServer`.

APME's use case is session-scoped: register the `ansible-doc` tool at the start of an AI escalation run, use it during remediation chat calls, auto-cleanup when done.

### Tool Namespacing

Dynamically registered tools follow the same `mcp:{serverId}/{toolName}` convention as config-based tools. The `server_id` must not collide with config-based servers; if it does, return `ALREADY_EXISTS`.

### Implementation

#### `McpClientPool` changes

`McpClientPool` already has `connect()` and `disconnect()` methods. The changes:

1. Add `connectDynamic(serverId, transport, scope?)` — same as `connect()` but marks the entry as `source: 'dynamic'` (vs. `source: 'config'`).
2. `syncWithConfig()` skips entries where `source === 'dynamic'` — config refreshes don't touch dynamic registrations.
3. Add `disconnectByScope(sessionId)` — removes all dynamic entries scoped to a session.

#### `ToolRegistry` changes

1. `listForChat(toolPolicy, sessionId?)` — when `sessionId` is provided, include both global tools and tools scoped to that session.
2. Session-scoped tools are invisible to other sessions and unscoped chat calls.

#### `AbbenayService` changes

Wire the `RegisterMcpServer` handler:

```typescript
async RegisterMcpServer(
  call: grpc.ServerUnaryCall<RegisterMcpServerRequest, RegisterMcpServerResponse>,
  callback: grpc.sendUnaryData<RegisterMcpServerResponse>
): Promise<void> {
  const { server_id, transport, session_id, tool_filter } = call.request;

  // Validate: no collision with config-based servers
  if (state.mcpClientPool.hasConfigServer(server_id)) {
    callback({ code: grpc.status.ALREADY_EXISTS, message: `MCP server '${server_id}' already configured` });
    return;
  }

  // Consumer auth: require capability 'mcp_register'
  // (see Security section)

  const config = transportProtoToConfig(transport);
  const tools = await state.mcpClientPool.connectDynamic(server_id, config, session_id);

  // Apply tool_filter if provided
  if (tool_filter.length > 0) {
    state.toolRegistry.filterServer(server_id, tool_filter);
  }

  callback(null, {
    success: true,
    discovered_tools: tools.map(t => t.name),
  });
}
```

#### Session lifecycle hook

When a session is deleted (`DeleteSession`) or expires, call `mcpClientPool.disconnectByScope(sessionId)` to clean up.

### Orphan Detection and Cleanup

Dynamic MCP registrations can become orphaned when the caller crashes without unregistering. Multiple layers of defense:

| Layer | Trigger | What it catches |
|-------|---------|-----------------|
| **Explicit unregister** | Caller calls `UnregisterMcpServer` | Happy path |
| **Client disconnect** | Caller calls `Unregister` (graceful exit) | Graceful shutdown without explicit unregister |
| **MCP health check** | Periodic ping (every 60s) on dynamic MCP servers | Caller crash — the MCP server it started dies with it, Abbenay detects the dead endpoint |
| **Session deletion** | `DeleteSession` RPC or session expiry (future) | Session-scoped cleanup |

The **MCP health check** is the critical safety net. Since the caller starts and owns the MCP server process, when the caller crashes, its MCP server typically dies with it (child process, same process group, or explicit shutdown hook). Abbenay's periodic ping detects the dead endpoint and removes the registration:

```typescript
// Every 60 seconds, ping all dynamic MCP servers
for (const [serverId, entry] of this.dynamicEntries) {
  try {
    await client.ping();  // MCP protocol ping
  } catch {
    console.warn(`[McpClientPool] Dynamic server '${serverId}' unreachable, removing`);
    await this.disconnect(serverId);
  }
}
```

This is cheap (one ping per server per minute) and directly addresses the failure mode where a caller dies and leaves Abbenay pointing at a dead endpoint.

### Per-Request Tool Filtering (`ChatOptions.tool_filter`)

`ChatOptions` already defines `tool_filter` (field 7) in the proto but it is unimplemented. This feature implements it as a complementary mechanism to MCP registration scoping.

When `tool_filter` is non-empty on a `ChatRequest` or `SessionChatRequest`, only the listed tools are exposed to the LLM for that request. This gives callers explicit control over which tools the LLM can call, regardless of how many are registered.

Example: APME registers `apme-ansible-doc` (which exposes `get_ansible_doc`), but the admin also has a `filesystem` MCP server in config. Without `tool_filter`, both are visible. With it:

```python
async for chunk in client.session_chat(
    session_id=session_id,
    message="Fix this M001 violation...",
    tool_filter=["mcp:apme-ansible-doc/get_ansible_doc"],
):
    ...
```

Only `get_ansible_doc` is exposed. The `filesystem` tools are hidden for this request.

Implementation: `CoreState.chat()` applies `tool_filter` after `listForChat()` returns — filter the `ToolDefinition[]` array to only include tools whose namespaced name matches a filter entry. Empty filter means all tools (current behavior).

### Error Handling for `RegisterMcpServer`

Connection failures (bad command, MCP server crash during init, transport timeout) return a gRPC `FAILED_PRECONDITION` error with the underlying failure message:

```typescript
try {
  const tools = await state.mcpClientPool.connectDynamic(server_id, config, session_id);
  // ...
} catch (error) {
  callback({
    code: grpc.status.FAILED_PRECONDITION,
    message: `Failed to connect to MCP server '${server_id}': ${error.message}`,
  });
}
```

### What This Enables

APME's AI escalation flow becomes:

```python
# 1. APME starts its own MCP server (owns the lifecycle)
mcp_proc = await start_ansible_doc_server(
    venv_path=session.venv_path,
    port=9123,
)

# 2. Tell Abbenay to connect to the running server
tools = await client.register_mcp_server(
    server_id="apme-ansible-doc",
    transport={"type": "http", "url": "http://localhost:9123"},
    session_id=session_id,
    tool_filter=["get_ansible_doc"],
)
# tools == ["mcp:apme-ansible-doc/get_ansible_doc"]

# 3. Chat via SessionChat — only ansible-doc tool is visible
async for chunk in client.session_chat(
    session_id=session_id,
    message="Fix this M001 violation...",
    enable_tools=True,
    policy={...},
    tool_filter=tools,  # restrict to just our registered tools
):
    ...

# 4. Cleanup: unregister from Abbenay, then stop the server
await client.unregister_mcp_server("apme-ansible-doc")
mcp_proc.terminate()
# (If APME crashes, Abbenay detects the dead server via health check)
```

The user's only setup: install Abbenay, configure a provider. No MCP config needed.

### Python Client Change

Add methods to `AbbenayClient`:

```python
async def register_mcp_server(
    self,
    server_id: str,
    transport: dict,
    *,
    session_id: Optional[str] = None,
    tool_filter: Optional[list[str]] = None,
) -> list[str]:
    """Register an MCP server. Returns list of discovered tool names."""

async def unregister_mcp_server(self, server_id: str) -> bool:
    """Unregister a dynamically registered MCP server."""
```

## Scope of Changes

| File | Change |
|------|--------|
| `proto/abbenay/v1/service.proto` | Expand `RegisterMcpServerRequest`, add `McpTransport`, update RPC return types to `RegisterMcpServerResponse` / `UnregisterMcpServerResponse` |
| `packages/daemon/src/core/config.ts` | Add `mcp_register` to `ConsumerCapabilities` |
| `packages/daemon/src/core/state.ts` | Implement `tool_filter` in `chat()` — filter `ToolDefinition[]` after `listForChat()` |
| `packages/daemon/src/daemon/mcp-client-pool.ts` | `connectDynamic()`, `disconnectByScope()`, `disconnectByClient()`, `hasConfigServer()`, source/scope/client tracking, periodic health check for dynamic servers |
| `packages/daemon/src/core/tool-registry.ts` | `listForChat()` session scope, `filterServer()` |
| `packages/daemon/src/daemon/state.ts` | Hook `disconnectByClient()` into client unregister path |
| `packages/daemon/src/daemon/server/abbenay-service.ts` | Implement `RegisterMcpServer`, `UnregisterMcpServer` handlers with auth; hook `disconnectByScope()` into `DeleteSession` |
| `packages/python/src/abbenay_grpc/client.py` | Add `register_mcp_server()`, `unregister_mcp_server()`, `session_chat()` with `tool_filter` |
| `packages/daemon/src/state.test.ts` | Unit tests for dynamic registration, scoping, cleanup, tool_filter, consumer auth |

## Security Considerations

### Caller-Spawned Model (Reduced Surface)

Because the recommended flow is **caller-spawned** (the caller starts its own MCP server and provides connection details), the security surface for dynamic registration is significantly smaller than if Abbenay spawned processes:

- **No arbitrary command execution.** Abbenay connects to an endpoint — it does not run commands on behalf of callers.
- **No env injection.** The `McpTransport.env` field is only relevant for stdio transport (config-based or opt-in dynamic). HTTP/SSE transports don't spawn processes.
- **No command allowlists needed** for the initial implementation.

### Consumer Authorization

Extend the consumer authorization model from DR-024:

```yaml
consumers:
  apme:
    token_env: APME_ABBENAY_TOKEN
    capabilities:
      inline_policy: true
      mcp_register: true          # NEW: allowed to register MCP servers
```

When `consumers` is configured, only callers with `mcp_register: true` and a valid token can use `RegisterMcpServer`. Without `consumers`, registration is allowed for all callers (consistent with inline policy behavior).

### Transport Restrictions

- **http/sse** (recommended for dynamic): Low risk — Abbenay connects to a URL, no process spawning.
- **stdio** (accepted for dynamic, discouraged): Spawns a subprocess — carries the same security implications as config-based stdio servers. When used dynamically, the consumer auth gate is critical. Future hardening options include command allowlists and env-var allowlists, deferred until there is a concrete need.
- The daemon should log all dynamic registrations at `info` level with the consumer identity and transport details.

## Backward Compatibility

- Fully backward compatible. Config-based MCP servers continue to work unchanged.
- The expanded `RegisterMcpServerRequest` is additive; old proto clients sending the minimal message (just `server_id` + `transport` string) would fail validation for the new `McpTransport` message, but there are no existing callers (the RPC is a stub today).
- No config file format changes.
- `tool_filter` on `ChatOptions` (field 7) is implemented as part of this feature. It was already defined in the proto but had no server-side implementation.

## Alternatives Considered

### Alternative 1: Config File Injection

The caller writes directly to `~/.config/abbenay/config.yaml` and triggers a refresh via `UpdateConfig` or by signaling the daemon.

**Rejected**: Mutating another application's config file is fragile, creates race conditions with manual edits, and doesn't support session scoping or automatic cleanup.

### Alternative 2: Per-Request Tool Definitions

Instead of registering MCP servers, allow callers to pass tool definitions and an executor callback directly on `ChatRequest`.

**Rejected for MCP**: This works for simple tools but breaks the MCP lifecycle model (connection, tool discovery, stateful execution). It also doesn't allow the LLM to autonomously discover and call tools across multiple turns in a conversation.

### Alternative 3: Implement `tool_filter` on `ChatOptions` Only

Keep MCP servers config-only but implement the `tool_filter` field on `ChatOptions` so callers can select which tools to expose per request.

**Partial solution**: Useful but insufficient alone — it requires config-time MCP setup. Now implemented as a **complementary feature** alongside dynamic registration, giving callers both registration and per-request filtering.

## Resolved Questions

1. **Should dynamic registrations survive daemon restart?** **No.** Ephemeral by design. Persistent tools belong in `config.yaml`.

2. **Concurrency: what if two consumers register the same `server_id`?** **`ALREADY_EXISTS`.** First caller wins. The `server_id` namespace is flat and global.

3. **Resource limits: max dynamic MCP servers per daemon?** **Configurable limit (default 10).** Prevents runaway registrations. Configured via `security.max_dynamic_mcp_servers` in `config.yaml`.

4. **Should `tool_filter` on `RegisterMcpServerRequest` be enforced?** **Yes.** Least-privilege: only filtered tools are registered, even if the MCP server advertises more.

5. **Session-scoped tools via `Chat` vs `SessionChat`?** **`SessionChat` only.** The stateless `Chat` RPC has no session context. Callers needing session-scoped tools must use `SessionChat`.

6. **Global registration cleanup on client crash?** **Auto-cleanup.** The daemon tracks the registering `client_id` and cleans up its dynamic registrations on `Unregister` (disconnect).
