# Abbenay Daemon Vision

**Status:** Historical (original design document)  
**Author:** Abbenay Team  
**Date:** February 2026

---

> **Historical document.** This is the original design document. For current architecture,
> see [ARCHITECTURE.md](ARCHITECTURE.md).
>
> **Post-vision changes:**
> - Providers now use the [Vercel AI SDK](https://sdk.vercel.ai/) (`@ai-sdk/*`), not `multi-llm-ts`
> - Source reorganized into `src/core/` (reusable library) and `src/daemon/` (full application)
> - `CoreState` (transport-agnostic) and `DaemonState extends CoreState`
> - `@abbenay/core` published as a standalone library for agent/web developers
> - Dynamic provider loading — AI SDK packages loaded on demand
>
> **Implemented:**
> - TypeScript daemon (migrated from Rust) with gRPC on Unix socket
> - Web dashboard with RHDS styling (embedded in daemon via Express)
> - VS Code extension (gRPC client + Language Model API registration)
> - 19 LLM engines via Vercel AI SDK
> - Mock provider for testing (echo, fixed, error, empty, slow modes)
> - Single Executable Application (SEA) binary packaging
> - Keychain secret storage (via keytar)
> - YAML configuration (user/workspace levels)
> - Dynamic model discovery from provider APIs
> 
> **Changed from original design:**
> - Daemon rewritten in TypeScript (originally Rust)
> - Web dashboard embedded in daemon (not separate process)
> - Providers via multi-llm-ts (not genai crate)
> - Sessions deferred to future phase
> 
> **Deferred:**
> - Session management (create, list, resume, fork, export/import)
> - MCP shim for Claude Desktop
> - VsCodeProvider for accessing Copilot models

---

## Executive Summary

Abbenay is a **unified AI daemon** that serves as the single source of truth for LLM access, configuration, and session state across all clients—VS Code, CLI, Python scripts, and web dashboard.

The daemon enables:
- **Session continuity**: Start a chat in VS Code, continue it from the CLI
- **Universal model access**: All clients share the same provider configuration
- **Zero configuration conflicts**: One daemon = one config = one source of truth
- **Web dashboard**: Browser-based UI for provider and model configuration

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│                              Clients                                     │
│                                                                          │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐ │
│  │ VS Code Ext  │  │  Python CLI  │  │ Web Dashboard│  │  Node.js     │ │
│  │  (gRPC)      │  │   (gRPC)     │  │ (HTTP→gRPC) │  │  (gRPC)      │ │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘ │
│         │                 │                 │                 │         │
│         │ gRPC            │ gRPC            │ HTTP            │ gRPC    │
│         └─────────────────┴─────────────────┴─────────────────┘         │
└─────────────────────────────────────────────┬───────────────────────────┘
                                              │
                                              ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                        abbenay-daemon (Rust)                             │
│                                                                          │
│  ┌─────────────────────────────────────────────────────────────────────┐│
│  │                         Session Manager                              ││
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐                  ││
│  │  │ sess-abc123 │  │ sess-def456 │  │ sess-xyz789 │                  ││
│  │  │ VS Code     │  │ CLI         │  │ Web         │                  ││
│  │  │ 15 messages │  │ 3 messages  │  │ 8 messages  │                  ││
│  │  └─────────────┘  └─────────────┘  └─────────────┘                  ││
│  └─────────────────────────────────────────────────────────────────────┘│
│                                                                          │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐         │
│  │  LLM Providers  │  │  Config/Secrets │  │  VS Code        │         │
│  │  OpenAI, etc.   │  │  (YAML+Keychain)│  │  Backchannel    │         │
│  └────────┬────────┘  └─────────────────┘  └────────┬────────┘         │
│           │                                          │                   │
│           │ HTTP                                     │ gRPC (workspace)  │
└───────────┼──────────────────────────────────────────┼──────────────────┘
            │                                          │
            ▼                                          ▼
    ┌───────────────┐                         ┌───────────────────────┐
    │   LLM APIs    │                         │  VS Code Extension    │
    │  OpenAI       │                         │  • Workspace paths    │
    │  Anthropic    │                         │  • LM API registration│
    │  Google       │                         └───────────────────────┘
    │  Mistral      │
    └───────────────┘
```

---

## Core Components

### 1. abbenay-daemon

The central Rust binary that runs as a background process.

**Responsibilities:**
- Serve gRPC API on Unix socket (`/run/user/{uid}/abbenay/daemon.sock`)
- Manage persistent chat sessions
- Route requests to LLM providers (HTTP) or VS Code (MCP)
- Execute tool calling loops
- Hold unified configuration and secrets

**Lifecycle:**
- Started by first client (VS Code, CLI, MCP shim)
- Stays alive while any client is connected
- Graceful shutdown after configurable idle timeout (default: 5 min)

### 2. VS Code Extension

The extension acts as a **gRPC client** to the daemon with a **backchannel** for workspace info.

**On activation:**
1. Check if daemon is running (try connect to socket)
2. If not running → spawn daemon as child process
3. Connect to daemon via gRPC
4. Start backchannel stream (provides workspace paths)
5. Register as LanguageModelChatProvider with VS Code

**On deactivation:**
1. Disconnect from daemon
2. Unregister from VS Code LM API

### 3. Web Dashboard (`abbenay web`)

Browser-based configuration UI served by a separate process.

**Purpose:** Provide easy provider and model configuration without editing YAML.

**Features:**
- Configure API keys (keychain or env var reference)
- Enable/disable providers and models
- Choose user vs workspace config level
- View connection status

**URL:** `http://localhost:8787`

### 4. Python/Node.js Clients

Thin gRPC client libraries (auto-generated from proto).

```python
from abbenay_grpc import AbbenayClient

client = AbbenayClient()  # Connects to daemon, starts if needed

# Chat with any model
for chunk in client.chat("openai/gpt-4o", "Hello!"):
    print(chunk.text, end="")

# Use Copilot (if VS Code is connected to daemon)
for chunk in client.chat("vscode/copilot-gpt-4o", "Explain this code"):
    print(chunk.text, end="")

# Continue a session started in VS Code
session = client.get_session("sess-abc123")
for chunk in session.chat("Now refactor it"):
    print(chunk.text, end="")
```

### 5. CLI

Command-line interface for interactive and scripted use.

```bash
# Quick chat
$ abbenay chat "Hello" --model openai/gpt-4o

# List sessions
$ abbenay session list
ID            MODEL           MESSAGES  AGE        SOURCE
sess-abc123   openai/gpt-4o   15        10m ago    vscode
sess-def456   anthropic/...   3         2h ago     cli

# Attach to a session (started in VS Code)
$ abbenay session attach sess-abc123
Resuming session with openai/gpt-4o (15 messages)
---
You: Now add error handling
Assistant: Here's the updated code...

# Detach (session persists)
$ abbenay session detach
Session saved.

# Export session to share with team
$ abbenay session export sess-abc123 > session.json

# Import a colleague's session
$ abbenay session import < session.json
Imported session: sess-abc123

# Daemon management
$ abbenay daemon status
$ abbenay daemon stop
```

---

## Session Management

Sessions are the key to the "pickup" feature—starting a conversation in one client and continuing in another.

### Session State

```rust
pub struct Session {
    /// Unique identifier (e.g., "sess-abc123")
    pub id: String,
    
    /// Provider and model (e.g., "openai/gpt-4o")
    pub model: String,
    
    /// Full conversation history
    pub messages: Vec<ChatMessage>,
    
    /// Which client created this session
    pub created_by: ClientType,  // VsCode, Cli, McpClient, Python
    
    /// Creation timestamp
    pub created_at: DateTime<Utc>,
    
    /// Last activity timestamp
    pub updated_at: DateTime<Utc>,
    
    /// Optional metadata (workspace path, etc.)
    pub metadata: HashMap<String, String>,
    
    /// Tool state (pending tool calls, results)
    pub tool_state: Option<ToolState>,
}

pub enum ClientType {
    VsCode { workspace: Option<String> },
    Cli,
    McpClient { name: String },  // "claude-desktop", "cursor"
    Python,
    NodeJs,
}
```

### Session Lifecycle

```
┌──────────────────────────────────────────────────────────────────┐
│                        Session Lifecycle                          │
└──────────────────────────────────────────────────────────────────┘

  VS Code                    Daemon                      CLI
     │                         │                          │
     │  CreateSession(model)   │                          │
     │ ──────────────────────► │                          │
     │                         │ ← sess-abc123 created    │
     │  ◄────────────────────  │                          │
     │  session_id             │                          │
     │                         │                          │
     │  Chat(sess, "Hello")    │                          │
     │ ──────────────────────► │                          │
     │  ◄──── stream ──────    │                          │
     │                         │                          │
     │  Chat(sess, "Thanks")   │                          │
     │ ──────────────────────► │                          │
     │  ◄──── stream ──────    │                          │
     │                         │                          │
     │         [User switches to terminal]                │
     │                         │                          │
     │                         │   ListSessions()         │
     │                         │ ◄──────────────────────  │
     │                         │ ────────────────────────►│
     │                         │   [sess-abc123, ...]     │
     │                         │                          │
     │                         │   AttachSession(abc123)  │
     │                         │ ◄──────────────────────  │
     │                         │ ────────────────────────►│
     │                         │   session + history      │
     │                         │                          │
     │                         │   Chat(sess, "Continue") │
     │                         │ ◄──────────────────────  │
     │                         │ ────────────────────────►│
     │                         │   stream...              │
     │                         │                          │
```

### Session Persistence

Sessions are persisted to disk for crash recovery:

```
~/.config/abbenay/sessions/
├── sess-abc123.json
├── sess-def456.json
└── index.json  # Quick lookup metadata
```

**Retention policy:**
- Active sessions: kept indefinitely
- Inactive sessions: pruned after configurable TTL (default: 7 days)
- Manual deletion via CLI or API

### Session Sharing Between Engineers

Because sessions are human-readable JSON files, they become **shareable knowledge artifacts**:

```bash
# Export a session
$ abbenay session export sess-abc123 > debugging-session.json

# Share via git, Slack, email, etc.
$ git add docs/ai-sessions/auth-refactor.json
$ git commit -m "Add AI-assisted auth refactor session for reference"

# Colleague imports the session
$ abbenay session import < debugging-session.json
Imported session: sess-abc123 (15 messages)

# Or just copy the file
$ cp debugging-session.json ~/.config/abbenay/sessions/
```

**Use cases:**

| Scenario | How it helps |
|----------|--------------|
| **Debugging handoff** | "I couldn't figure out the memory leak—here's my session" |
| **Code review** | Include AI reasoning alongside the PR |
| **Onboarding** | Share sessions that explain codebase architecture |
| **Pair programming** | Hand off mid-session to a colleague |
| **Documentation** | "Here's how I solved X" with full AI context |
| **Knowledge base** | Curated sessions as team reference material |

**Session JSON structure:**

```json
{
  "id": "sess-abc123",
  "topic": "Debugging memory leak in auth service",
  "model": "abbenay/copilot-gpt-4o",
  "created_by": { "client": "vscode", "user": "alice" },
  "created_at": "2026-02-09T10:30:00Z",
  "messages": [
    { "role": "user", "content": "I'm seeing OOM errors in production..." },
    { "role": "assistant", "content": "Let's investigate..." },
    ...
  ],
  "tool_calls": [...],
  "metadata": {
    "workspace": "/home/alice/projects/auth-service",
    "branch": "fix/memory-leak",
    "files_referenced": ["src/auth.ts", "src/session.ts"]
  }
}
```

The readable format means sessions can be:
- Searched with grep/ripgrep
- Diffed to see conversation evolution  
- Linted or validated with JSON schemas
- Stored in version control alongside code
- Indexed for team-wide search

### Session Notifications

When a session is modified by one client, others can be notified:

```protobuf
service Abbenay {
  // Subscribe to session events
  rpc WatchSessions(WatchSessionsRequest) returns (stream SessionEvent);
}

message SessionEvent {
  string session_id = 1;
  oneof event {
    SessionCreated created = 2;
    SessionUpdated updated = 3;
    SessionDeleted deleted = 4;
  }
}
```

VS Code could use this to show a notification: "Session updated from CLI."

---

## Protocol Definition

### gRPC Service

```protobuf
syntax = "proto3";
package abbenay.v1;

import "google/protobuf/timestamp.proto";
import "google/protobuf/empty.proto";

service Abbenay {
  //
  // Chat
  //
  
  // Stateless chat (no session)
  rpc Chat(ChatRequest) returns (stream ChatChunk);
  
  // Chat within a session
  rpc SessionChat(SessionChatRequest) returns (stream ChatChunk);
  
  //
  // Sessions
  //
  
  rpc CreateSession(CreateSessionRequest) returns (Session);
  rpc GetSession(GetSessionRequest) returns (Session);
  rpc ListSessions(ListSessionsRequest) returns (ListSessionsResponse);
  rpc DeleteSession(DeleteSessionRequest) returns (google.protobuf.Empty);
  rpc WatchSessions(WatchSessionsRequest) returns (stream SessionEvent);
  rpc ExportSession(ExportSessionRequest) returns (ExportSessionResponse);
  rpc ImportSession(ImportSessionRequest) returns (Session);
  
  //
  // Models
  //
  
  rpc ListModels(ListModelsRequest) returns (ListModelsResponse);
  rpc ListProviders(ListProvidersRequest) returns (ListProvidersResponse);
  
  //
  // Tools
  //
  
  rpc ListTools(ListToolsRequest) returns (ListToolsResponse);
  
  //
  // Configuration
  //
  
  rpc GetConfig(GetConfigRequest) returns (GetConfigResponse);
  rpc SetConfig(SetConfigRequest) returns (google.protobuf.Empty);
  
  //
  // Secrets
  //
  
  rpc GetSecret(GetSecretRequest) returns (GetSecretResponse);
  rpc SetSecret(SetSecretRequest) returns (google.protobuf.Empty);
  rpc DeleteSecret(DeleteSecretRequest) returns (google.protobuf.Empty);
  
  //
  // Daemon Lifecycle
  //
  
  rpc Ping(PingRequest) returns (PingResponse);
  rpc GetStatus(GetStatusRequest) returns (DaemonStatus);
  rpc Shutdown(ShutdownRequest) returns (google.protobuf.Empty);
  
  //
  // MCP Registration (for VS Code)
  //
  
  rpc RegisterMcpEndpoint(RegisterMcpEndpointRequest) returns (google.protobuf.Empty);
  rpc UnregisterMcpEndpoint(UnregisterMcpEndpointRequest) returns (google.protobuf.Empty);
}

//
// Chat Messages
//

message ChatRequest {
  string provider = 1;        // "openai", "anthropic", "vscode"
  string model = 2;           // "gpt-4o", "claude-3-5-sonnet"
  repeated ChatMessage messages = 3;
  ChatOptions options = 4;
}

message SessionChatRequest {
  string session_id = 1;
  string content = 2;         // User message
  ChatOptions options = 3;
}

message ChatOptions {
  optional float temperature = 1;
  optional int32 max_tokens = 2;
  bool enable_tools = 3;
  int32 max_tool_iterations = 4;
}

message ChatMessage {
  string role = 1;            // "system", "user", "assistant", "tool"
  string content = 2;
  optional string name = 3;   // For tool messages
  optional string tool_call_id = 4;
  repeated ToolCall tool_calls = 5;
}

message ChatChunk {
  oneof chunk {
    TextChunk text = 1;
    ToolCallChunk tool_call = 2;
    ToolResultChunk tool_result = 3;
    ErrorChunk error = 4;
    DoneChunk done = 5;
  }
}

message TextChunk {
  string text = 1;
}

message ToolCallChunk {
  string id = 1;
  string name = 2;
  string arguments = 3;       // JSON string
}

message ToolResultChunk {
  string id = 1;
  string content = 2;
  bool is_error = 3;
}

message ErrorChunk {
  string message = 1;
  string code = 2;
}

message DoneChunk {
  optional string stop_reason = 1;
}

//
// Sessions
//

message Session {
  string id = 1;
  string model = 2;
  repeated ChatMessage messages = 3;
  string created_by = 4;
  google.protobuf.Timestamp created_at = 5;
  google.protobuf.Timestamp updated_at = 6;
  map<string, string> metadata = 7;
}

message CreateSessionRequest {
  string model = 1;
  optional string system_prompt = 2;
  map<string, string> metadata = 3;
}

message GetSessionRequest {
  string session_id = 1;
}

message ListSessionsRequest {
  optional int32 limit = 1;
  optional string cursor = 2;
}

message ListSessionsResponse {
  repeated SessionSummary sessions = 1;
  optional string next_cursor = 2;
}

message SessionSummary {
  string id = 1;
  string model = 2;
  int32 message_count = 3;
  string created_by = 4;
  google.protobuf.Timestamp created_at = 5;
  google.protobuf.Timestamp updated_at = 6;
}

message DeleteSessionRequest {
  string session_id = 1;
}

message WatchSessionsRequest {}

message SessionEvent {
  string session_id = 1;
  oneof event {
    SessionCreated created = 2;
    SessionUpdated updated = 3;
    SessionDeleted deleted = 4;
  }
}

message SessionCreated {
  Session session = 1;
}

message SessionUpdated {
  int32 new_message_count = 1;
}

message SessionDeleted {}

//
// Models & Providers
//

message ListModelsRequest {
  optional string provider = 1;  // Filter by provider
}

message ListModelsResponse {
  repeated Model models = 1;
}

message Model {
  string id = 1;              // "openai/gpt-4o"
  string provider = 2;        // "openai"
  string name = 3;            // "gpt-4o"
  string display_name = 4;    // "GPT-4o"
  ModelCapabilities capabilities = 5;
}

message ModelCapabilities {
  bool streaming = 1;
  bool tool_calling = 2;
  bool vision = 3;
}

message ListProvidersRequest {}

message ListProvidersResponse {
  repeated Provider providers = 1;
}

message Provider {
  string id = 1;
  string display_name = 2;
  bool requires_api_key = 3;
  bool is_connected = 4;      // For vscode provider: is MCP connected?
}

//
// Tools
//

message ListToolsRequest {}

message ListToolsResponse {
  repeated Tool tools = 1;
}

message Tool {
  string name = 1;
  string description = 2;
  string input_schema = 3;    // JSON Schema
  string source = 4;          // "vscode", "builtin"
}

//
// Daemon
//

message PingRequest {}

message PingResponse {
  string version = 1;
  int64 uptime_seconds = 2;
}

message GetStatusRequest {}

message DaemonStatus {
  string version = 1;
  int64 uptime_seconds = 2;
  int32 active_sessions = 3;
  int32 connected_clients = 4;
  bool mcp_connected = 5;     // Is VS Code MCP connected?
  repeated string connected_providers = 6;
}

message ShutdownRequest {
  bool force = 1;             // Shutdown even with active clients
}

//
// MCP Registration
//

message RegisterMcpEndpointRequest {
  string socket_path = 1;     // Path to VS Code's MCP socket
}

message UnregisterMcpEndpointRequest {}
```

---

## MCP Server Exposure

The daemon exposes itself as an MCP server (via the shim) with these tools:

### Core Tools

| Tool | Description |
|------|-------------|
| `abbenay_chat` | Send a chat message, get streaming response |
| `abbenay_list_models` | List all available models (all providers) |
| `abbenay_get_config` | Get configuration |

### Session Tools (Cross-Tool Pickup)

| Tool | Description |
|------|-------------|
| `abbenay_session_list` | List available sessions with metadata |
| `abbenay_session_get` | Get full session with message history |
| `abbenay_session_create` | Create a new session |
| `abbenay_session_chat` | Chat within a session (uses session's model) |
| `abbenay_session_replay` | Get session formatted for context injection |
| `abbenay_session_summarize` | Get AI-generated summary of a session |
| `abbenay_session_fork` | Fork a session (new session linked to parent) |
| `abbenay_session_export` | Export session as shareable JSON artifact |

This allows Claude Desktop to use Abbenay's configured models:

```
Claude Desktop
     │
     │ "Use abbenay_chat with gpt-4o to..."
     ▼
abbenay-mcp-server
     │
     │ gRPC Chat(openai/gpt-4o, ...)
     ▼
abbenay-daemon
     │
     │ HTTP
     ▼
OpenAI API
```

---

## Cross-Tool Session Pickup

One of the most powerful features: **start a session in one tool (VS Code), continue it in another (Cursor/Claude Desktop)**.

### Important: The Proxy Requirement

For Abbenay to capture a session, **all chat messages must flow through Abbenay**, even when using underlying models like Copilot. Native Copilot Chat (or any direct model access) bypasses Abbenay and cannot be captured.

```
❌ Native Copilot Chat (Abbenay CANNOT capture):

  VS Code Copilot Chat
       │
       │ Direct to Copilot extension
       ▼
  GitHub Copilot → GPT-4o
  
  Abbenay has NO visibility. Session NOT captured.


✅ Abbenay Chat using Copilot model (Abbenay CAN capture):

  Abbenay Chat UI (or VS Code Chat with vendor: 'abbenay')
       │
       │ User selects: "abbenay/copilot-gpt-4o"
       ▼
  Abbenay Daemon ◄─── Session captured here (sess-abc123)
       │
       │ MCP: abbenay_llm_send
       ▼
  VS Code Extension (MCP Server)
       │
       │ vscode.lm.sendRequest()
       ▼
  GitHub Copilot → GPT-4o
  
  Same model underneath, but Abbenay sees all messages.
```

### How Abbenay Exposes vscode.lm Models

Abbenay acts as a **proxy** for vscode.lm models:

1. **Discovery**: Daemon queries VS Code's MCP server for available `vscode.lm` models
2. **Re-exposure**: Models appear in Abbenay with `abbenay/` prefix (e.g., `abbenay/copilot-gpt-4o`)
3. **Routing**: When user selects this model, Abbenay routes through MCP to real Copilot
4. **Capture**: All messages flow through daemon → session persisted

```
┌─────────────────────────────────────────────────────────────────┐
│  Abbenay Model Selector                                         │
│                                                                  │
│  Direct Providers (HTTP):                                        │
│    ○ openai/gpt-4o                                              │
│    ○ anthropic/claude-3-5-sonnet                                │
│    ○ ollama/llama3                                              │
│                                                                  │
│  VS Code LM Models (via MCP proxy):                             │
│    ● abbenay/copilot-gpt-4o        ◄── Same as native Copilot  │
│    ○ abbenay/copilot-gpt-4              but Abbenay sees it    │
│    ○ abbenay/github-claude-3-5-sonnet                           │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### User Experience Trade-off

| Approach | Session Captured? | Cross-Tool Pickup? | Notes |
|----------|-------------------|-------------------|-------|
| Native Copilot Chat | ❌ No | ❌ No | Direct, but isolated |
| Abbenay Chat → Copilot | ✅ Yes | ✅ Yes | Same model, full features |
| Abbenay Chat → OpenAI | ✅ Yes | ✅ Yes | Direct HTTP, full features |

**Recommendation**: For users who want session continuity, use Abbenay's chat interface (or VS Code Chat with Abbenay as provider) instead of native Copilot Chat. The underlying model is identical—only the routing changes.

### The Challenge

When switching between tools:
- **Different models**: GPT-4o → Claude have different tokenization and context formats
- **Different UIs**: Each tool has its own chat interface
- **Context limits**: Need to fit history into new model's context window
- **Tool state**: May have pending tool calls or results

### The Solution: Session MCP Tools

The daemon exposes session tools via MCP, allowing any MCP client to discover and continue sessions.

### Example: VS Code → Cursor Handoff

```
┌────────────────────────────────────────────────────────────────────┐
│  Step 1: User works in Abbenay Chat (VS Code) with Copilot model   │
│                                                                     │
│  [User selected model: abbenay/copilot-gpt-4o]                     │
│                                                                     │
│  User: "Help me refactor auth.ts to async/await"                   │
│  Assistant: "I'll help with that. Looking at your code..."        │
│  ... 20 messages later ...                                         │
│  User: "Now I need to handle session refresh"                      │
│  Assistant: "For session refresh, consider..."                     │
│                                                                     │
│  [Session sess-abc123 captured by Abbenay daemon]                  │
│  [20 messages, model: abbenay/copilot-gpt-4o, source: vscode]      │
│                                                                     │
│  Note: Under the hood, Abbenay routes to real Copilot via MCP.     │
│  User gets same responses as native Copilot, but session is saved. │
└────────────────────────────────────────────────────────────────────┘
                              │
                              │ User switches to Cursor
                              ▼
┌────────────────────────────────────────────────────────────────────┐
│  Step 2: User asks Cursor to continue                              │
│                                                                     │
│  User: "Continue my VS Code session about the refactor"            │
│                                                                     │
│  Claude: Let me check for your recent sessions...                  │
│          [calls abbenay_session_list]                              │
│                                                                     │
│  Tool Result:                                                       │
│  ┌────────────────────────────────────────────────────────────────┐│
│  │ Sessions:                                                       ││
│  │ - sess-abc123: "Refactoring auth module"                       ││
│  │   Model: abbenay/copilot-gpt-4o | 20 msgs | VS Code | 1 hour ago││
│  │ - sess-def456: "Bug investigation"                             ││
│  │   Model: openai/gpt-4o | 5 msgs | CLI | 3 hours ago            ││
│  └────────────────────────────────────────────────────────────────┘│
│                                                                     │
│  Claude: I found a session about refactoring from an hour ago.     │
│          Would you like me to:                                      │
│          1. Read the context and continue here (I respond)         │
│          2. Relay messages to that session (Copilot responds)      │
│          3. Fork the session (new thread, linked history)          │
│                                                                     │
│  User: Option 1, read the context                                  │
│                                                                     │
│  Claude: [calls abbenay_session_replay(session_id="sess-abc123")]  │
│                                                                     │
└────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌────────────────────────────────────────────────────────────────────┐
│  Step 3: Claude receives the session context                       │
│                                                                     │
│  Tool Result (abbenay_session_replay):                             │
│  ┌────────────────────────────────────────────────────────────────┐│
│  │ === Abbenay Session: sess-abc123 ===                           ││
│  │ Model: abbenay/copilot-gpt-4o (via vscode.lm)                  ││
│  │ Created: 2026-02-09 10:30 in VS Code                           ││
│  │ Topic: Refactoring auth module to async/await                  ││
│  │                                                                 ││
│  │ --- Conversation (20 messages) ---                             ││
│  │                                                                 ││
│  │ [User]: Help me refactor auth.ts to async/await                ││
│  │                                                                 ││
│  │ [Assistant]: I'll help with that. Looking at your code, I see  ││
│  │ several callback-based patterns. Here's my approach:           ││
│  │ 1. Convert outer callbacks first...                            ││
│  │                                                                 ││
│  │ ... (intermediate messages) ...                                ││
│  │                                                                 ││
│  │ [User]: Now I need to handle session refresh                   ││
│  │                                                                 ││
│  │ [Assistant]: For session refresh, I recommend implementing     ││
│  │ a separate refreshSession() function that checks token expiry  ││
│  │ before each API call...                                        ││
│  │                                                                 ││
│  │ === End Session ===                                            ││
│  └────────────────────────────────────────────────────────────────┘│
│                                                                     │
│  Claude: I now have the full context of your refactoring work.     │
│          Based on where you left off with session refresh,         │
│          here's how I'd implement the automatic refresh logic...   │
│                                                                     │
└────────────────────────────────────────────────────────────────────┘

Key insight: The original session used GPT-4o (via Copilot), but Claude can 
now continue it because Abbenay captured and persisted the session history.
The model changed, but the context transferred successfully.
```

### Session MCP Tool Definitions

```json
{
  "name": "abbenay_session_list",
  "description": "List Abbenay chat sessions available for continuation. Sessions can be started in VS Code, CLI, or other tools.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "limit": {
        "type": "integer",
        "description": "Maximum sessions to return (default: 10)"
      },
      "source_filter": {
        "type": "string",
        "description": "Filter by source: 'vscode', 'cli', 'cursor', etc."
      },
      "model_filter": {
        "type": "string", 
        "description": "Filter by model: 'openai/*', 'anthropic/*', etc."
      }
    }
  }
}
```

```json
{
  "name": "abbenay_session_replay",
  "description": "Get a session's conversation history formatted for context injection. Use this to understand and continue a conversation started in another tool.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "session_id": {
        "type": "string",
        "description": "Session ID from abbenay_session_list"
      },
      "max_messages": {
        "type": "integer",
        "description": "Limit to N most recent messages (0 = all)"
      },
      "format": {
        "type": "string",
        "enum": ["full", "condensed", "summary_only"],
        "description": "full: complete history, condensed: summary + recent, summary_only: just summary"
      }
    },
    "required": ["session_id"]
  }
}
```

```json
{
  "name": "abbenay_session_summarize",
  "description": "Get an AI-generated summary of a session. Useful for large sessions that won't fit in context, or to quickly understand what was discussed.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "session_id": {
        "type": "string"
      },
      "max_tokens": {
        "type": "integer",
        "description": "Target summary length in tokens"
      },
      "include_key_decisions": {
        "type": "boolean",
        "description": "Highlight key decisions and conclusions"
      }
    },
    "required": ["session_id"]
  }
}
```

```json
{
  "name": "abbenay_session_continue",
  "description": "Send a message to an existing session. The response comes from the session's original model (e.g., if session was with GPT-4o, response comes from GPT-4o).",
  "inputSchema": {
    "type": "object",
    "properties": {
      "session_id": {
        "type": "string"
      },
      "message": {
        "type": "string",
        "description": "The message to send"
      }
    },
    "required": ["session_id", "message"]
  }
}
```

```json
{
  "name": "abbenay_session_fork",
  "description": "Fork a session to create a new branch. The new session starts with the same history but can diverge. Useful for exploring alternative approaches.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "session_id": {
        "type": "string",
        "description": "Session to fork from"
      },
      "new_model": {
        "type": "string",
        "description": "Model for the forked session (optional, defaults to same model)"
      },
      "fork_point": {
        "type": "integer",
        "description": "Message index to fork from (optional, defaults to end)"
      }
    },
    "required": ["session_id"]
  }
}
```

```json
{
  "name": "abbenay_session_export",
  "description": "Export a session as a portable JSON artifact. Can be shared with colleagues, stored in git, or imported into another Abbenay instance.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "session_id": {
        "type": "string",
        "description": "Session to export"
      },
      "include_tool_results": {
        "type": "boolean",
        "description": "Include full tool call results (default: true, set false for smaller export)"
      },
      "include_metadata": {
        "type": "boolean",
        "description": "Include workspace/file metadata (default: true)"
      }
    },
    "required": ["session_id"]
  }
}
```

### Replay Format Options

#### Full Replay
Complete message history, suitable for models with large context windows:

```markdown
=== Abbenay Session: sess-abc123 ===
Model: copilot/gpt-4o
Created: 2026-02-09 10:30 in VS Code
Topic: Refactoring auth module

--- Conversation ---

[User]: Help me refactor auth.ts to async/await

[Assistant]: I'll help with that. Looking at your code, I see several 
callback-based patterns that can be converted. Here's my approach:

1. Start with the outermost callbacks
2. Convert each to async/await
3. Add proper error handling with try/catch

Let me show you the login function first...

[User]: The login function is particularly complex

[Assistant]: You're right. The login function has nested callbacks for:
- Initial authentication
- Token refresh
- Session storage

Here's how I'd break it down...

... (full history) ...

=== End Session ===
```

#### Condensed Replay
Summary + recent messages, for models with smaller context:

```markdown
=== Abbenay Session: sess-abc123 ===
Model: copilot/gpt-4o
Created: 2026-02-09 10:30 in VS Code

--- Summary (20 messages condensed) ---

This session covered refactoring auth.ts from callback-based to async/await 
patterns. Key work completed:
- Converted login() to async/await with try/catch
- Refactored token validation as separate async function
- Discussed error boundary patterns

Key decisions made:
- Use try/catch instead of .catch() for consistency
- Add timeout handling to login()
- Implement refresh token as separate concern

Current focus: Implementing session refresh logic

--- Recent Messages (last 3) ---

[User]: The token refresh is timing out sometimes

[Assistant]: That's likely a race condition. When multiple requests trigger 
refresh simultaneously, they can conflict. I recommend:
1. Add a refresh lock
2. Queue pending requests
3. Resolve all when refresh completes

[User]: Now I need to handle session refresh

[Assistant]: For session refresh, I recommend implementing a separate 
refreshSession() function that checks token expiry before each API call...

=== End Session ===
```

#### Summary Only
Just the high-level summary, for quick context:

```markdown
=== Abbenay Session Summary: sess-abc123 ===
Model: copilot/gpt-4o | 20 messages | VS Code | 1 hour ago

**Topic**: Refactoring auth.ts from callbacks to async/await

**Key Points**:
- Converted login() and validateToken() to async/await
- Added comprehensive try/catch error handling
- Discussed race conditions in token refresh
- Decided on refresh lock pattern

**Current State**: Working on session refresh implementation

**Last Message**: Discussion of refreshSession() function design
=== End Summary ===
```

### Continuation Options

When a user picks up a session in a different tool, they have three options:

#### Option 1: Context Injection (Read & Continue Locally)

The new model reads the history and continues in its own context.

```
Cursor (Claude) reads sess-abc123 history
   → Claude responds based on that context
   → New messages NOT added to sess-abc123
   → Essentially a "read-only" pickup
```

**Best for**: When you want to use a different model's perspective.

#### Option 2: Relay (True Continuation)

Messages are relayed through Abbenay to the original model.

```
Cursor sends message → abbenay_session_continue(sess-abc123, msg)
   → Daemon routes to copilot/gpt-4o
   → Response added to sess-abc123
   → Cursor displays response
```

**Best for**: When you want to continue with the same model, just different UI.

#### Option 3: Fork (Branch Off)

Create a new session that starts with the same history.

```
Cursor: abbenay_session_fork(sess-abc123, new_model="anthropic/claude-3-5-sonnet")
   → Creates sess-xyz789 (forked from sess-abc123)
   → New session uses Claude, starts with full history
   → Both sessions exist independently
```

**Best for**: Exploring alternative approaches with different models.

### gRPC Additions for Session Replay

```protobuf
//
// Session Replay (for cross-tool pickup)
//

rpc ReplaySession(ReplaySessionRequest) returns (ReplaySessionResponse);
rpc SummarizeSession(SummarizeSessionRequest) returns (SummarizeSessionResponse);
rpc ForkSession(ForkSessionRequest) returns (Session);

message ReplaySessionRequest {
  string session_id = 1;
  int32 max_messages = 2;         // 0 = all
  ReplayFormat format = 3;
}

enum ReplayFormat {
  REPLAY_FULL = 0;                // Complete message history
  REPLAY_CONDENSED = 1;           // Summary + recent messages
  REPLAY_SUMMARY_ONLY = 2;        // Just the summary
}

message ReplaySessionResponse {
  string session_id = 1;
  string model = 2;
  string source = 3;              // "vscode", "cli", etc.
  google.protobuf.Timestamp created_at = 4;
  
  // The formatted replay text (markdown)
  string replay_text = 5;
  
  // Metadata
  int32 total_messages = 6;
  int32 included_messages = 7;
  bool was_summarized = 8;
  string topic = 9;               // Auto-detected or user-set
}

message SummarizeSessionRequest {
  string session_id = 1;
  int32 max_tokens = 2;
  bool include_key_decisions = 3;
  string summarizer_model = 4;    // Which model to use (optional)
}

message SummarizeSessionResponse {
  string summary = 1;
  repeated string key_decisions = 2;
  string current_state = 3;
  int32 original_message_count = 4;
}

message ForkSessionRequest {
  string session_id = 1;
  optional string new_model = 2;  // Model for forked session
  optional int32 fork_point = 3;  // Message index to fork from
  map<string, string> metadata = 4;
}
```

### Session State Additions

```rust
pub struct Session {
    // ... existing fields ...
    
    /// Auto-detected or user-set topic
    pub topic: Option<String>,
    
    /// If this session was forked, the parent session ID
    pub forked_from: Option<String>,
    
    /// Fork point (message index in parent)
    pub fork_point: Option<usize>,
    
    /// Cached summary (regenerated when stale)
    pub cached_summary: Option<CachedSummary>,
}

pub struct CachedSummary {
    pub text: String,
    pub key_decisions: Vec<String>,
    pub generated_at: DateTime<Utc>,
    pub message_count_at_generation: usize,
}
```

---

## Client Lifecycle Details

### First Client (VS Code)

```
1. Extension activates
2. Try connect to /run/user/{uid}/abbenay/daemon.sock
3. Connection fails → socket doesn't exist
4. Spawn: abbenay-daemon --socket /run/user/{uid}/abbenay/daemon.sock
5. Wait for socket to appear (poll with backoff)
6. Connect via gRPC
7. Register MCP endpoint: RegisterMcpEndpoint(my_mcp_socket)
8. Set flag: i_am_spawner = true
```

### Second Client (CLI)

```
1. CLI command: abbenay chat "Hello"
2. Try connect to /run/user/{uid}/abbenay/daemon.sock
3. Connection succeeds → daemon already running
4. Send Chat request
5. Stream response
6. Disconnect
```

### Third Client (Claude Desktop via MCP)

```
1. Claude Desktop spawns: abbenay-mcp-server
2. MCP shim tries connect to socket → succeeds
3. MCP shim translates MCP calls to gRPC
4. Claude Desktop uses abbenay_chat tool
5. Works seamlessly
```

### Spawner Client Exits

```
1. VS Code deactivates
2. Check: i_am_spawner = true
3. Check: other clients connected?
   - If yes → just disconnect, don't shutdown
   - If no → send Shutdown request with grace period
4. Daemon handles Shutdown:
   - If force=false, wait for grace period (e.g., 5 min)
   - If new client connects during grace → cancel shutdown
   - If grace expires → save sessions, exit
```

---

## Benefits Summary

| Benefit | Description |
|---------|-------------|
| **Session Continuity** | Start in VS Code, continue in CLI, seamlessly |
| **Session Sharing** | Export sessions as JSON; share via git, Slack, or email with colleagues |
| **Universal Model Access** | Python/CLI can use Copilot via daemon's MCP connection |
| **Zero Config Conflicts** | One daemon = one config = no drift |
| **MCP Exposure** | Claude Desktop, Cursor can use Abbenay's models |
| **Warm Performance** | Daemon stays loaded; fast for all clients |
| **Tool Sharing** | VS Code tools available to all clients |
| **Unified Secrets** | One keychain/env lookup, shared |
| **Knowledge Artifacts** | Sessions become searchable, version-controlled documentation |

---

## Migration Path

### Phase 1: Add gRPC Server (Parallel)

1. Add `tonic` gRPC server to `abbenay-core`
2. Create `abbenay-daemon` binary
3. Implement core RPC methods (Chat, ListModels)
4. VS Code can optionally use daemon mode

### Phase 2: Session Management

1. Implement session state in daemon
2. Add session persistence
3. Add CLI commands: `session list`, `session attach`
4. VS Code shows sessions from daemon

### Phase 3: MCP Shim

1. Create `abbenay-mcp-server` binary
2. Publish mcpserver.json configuration
3. Test with Claude Desktop

### Phase 4: Deprecate NAPI/PyO3

1. Generate gRPC clients for Python/Node
2. Update VS Code to use gRPC exclusively
3. Remove NAPI/PyO3 bindings
4. Simplify build (no native compilation per platform)

---

## Open Questions

1. **Session limits?** Max sessions per user? Max message history?
2. **Session sharing?** Can two VS Code windows show the same session?
3. **Conflict resolution?** Two clients chat in same session simultaneously?
4. **Offline mode?** Should CLI work if daemon is down (limited functionality)?
5. **Multi-daemon?** Allow multiple daemons (e.g., per-workspace)?

---

## Appendix: File Locations

| File | Path | Purpose |
|------|------|---------|
| Socket | `/run/user/{uid}/abbenay/daemon.sock` | gRPC server socket |
| Sessions | `~/.config/abbenay/sessions/*.json` | Persisted sessions |
| Config | `~/.config/abbenay/config.yaml` | User configuration |
| Logs | `~/.config/abbenay/logs/daemon.log` | Daemon logs |
| PID | `$XDG_RUNTIME_DIR/abbenay/abbenay.pid` | Process ID for management |
