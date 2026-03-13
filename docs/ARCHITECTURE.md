# Abbenay Architecture

## Overview

Abbenay is a unified AI daemon and library written in TypeScript/Node.js that provides:
- A **reusable core library** (`@abbenay/core`) for LLM engine abstraction, streaming chat, and config
- A **gRPC API** for chat and configuration
- A **web dashboard** for provider/model management
- A **VS Code extension** that registers models with VS Code's Language Model API

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         Consumer Applications                            │
│                                                                          │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────────────┐  │
│  │   VS Code Ext   │  │   Python Apps   │  │   Web Dashboard         │  │
│  │   (gRPC)        │  │   (gRPC)        │  │   (HTTP → DaemonState)   │  │
│  └────────┬────────┘  └────────┬────────┘  └────────────┬────────────┘  │
│           │                    │                        │               │
│           └────────────────────┼────────────────────────┘               │
│                                │                                         │
└────────────────────────────────┼─────────────────────────────────────────┘
                                 │ gRPC over Unix Socket (or named pipe)
                                 ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                     abbenay daemon (TypeScript)                          │
│                                                                          │
│  ┌─ @abbenay/core ──────────────────────────────────────────────────┐   │
│  │  CoreState          Engines (Vercel AI SDK)    Config (YAML)      │   │
│  │  SecretStore i/f    Streaming chat + tools     Model discovery    │   │
│  └───────────────────────────────────────────────────────────────────┘   │
│                                                                          │
│  ┌─ daemon layer ────────────────────────────────────────────────────┐   │
│  │  DaemonState        gRPC Server               VS Code Backchannel │   │
│  │  CLI (Commander)    Web Dashboard (Express)    KeychainSecretStore │   │
│  └───────────────────────────────────────────────────────────────────┘   │
│                                                                          │
└──────────────────────────────────────────┬──────────────────────────────┘
                                           │
         ┌─────────────────────────────────┼───────────────────┐
         │                                 │                   │
         ▼                                 ▼                   ▼
┌─────────────────┐              ┌─────────────────┐    ┌───────────────┐
│   LLM APIs      │              │  keytar         │    │  Config Files │
│   (HTTP)        │              │  (keychain)     │    │  (YAML)       │
└─────────────────┘              └─────────────────┘    └───────────────┘
```

## Core/Full Package Split

The source tree is organized into two layers:

### @abbenay/core (`src/core/`)

Reusable library with zero transport dependencies. Can be used standalone by agent developers, web developers, or any Node.js application.

| File | Purpose |
|------|---------|
| `core/state.ts` | `CoreState` class — provider resolution, model listing, chat |
| `core/engines.ts` | Engine registry with Vercel AI SDK providers (dynamically loaded) |
| `core/config.ts` | YAML config loader/saver, merge logic |
| `core/secrets.ts` | `SecretStore` interface + `MemorySecretStore` |
| `core/paths.ts` | Platform-aware path utilities |
| `core/mock.ts` | Mock engine for testing |
| `core/policies.ts` | Policy system — built-in + custom policies, resolution, flattening |
| `core/tool-registry.ts` | Tool collection, namespacing, policy filtering, executor builder |
| `core/session-store.ts` | File-based session persistence (CRUD, index, messages) |
| `core/session-summarizer.ts` | Periodic LLM-generated session summaries (DR-022) |
| `core/index.ts` | Public API surface |

### @abbenay/daemon (`src/daemon/`)

Full application layer. Extends core with transport, UI, and CLI.

| File | Purpose |
|------|---------|
| `daemon/state.ts` | `DaemonState extends CoreState` — client registry, VS Code backchannel |
| `daemon/daemon.ts` | Process lifecycle, gRPC server startup, signal handling |
| `daemon/transport.ts` | Unix socket and PID file management |
| `daemon/tool-router.ts` | Tool execution routing (VS Code, MCP, local) |
| `daemon/mcp-client-pool.ts` | MCP server connection pool |
| `daemon/mcp-server.ts` | Embedded MCP server (exposes daemon as MCP) |
| `daemon/index.ts` | CLI entry point (Commander) |
| `daemon/server/abbenay-service.ts` | gRPC service handlers |
| `daemon/web/server.ts` | Express web server + REST API |
| `daemon/web/openai-compat.ts` | OpenAI-compatible `/v1/*` routes (models, chat completions) |
| `daemon/web/grpc-web-control.ts` | gRPC client for web server control |
| `daemon/secrets/keychain.ts` | `KeychainSecretStore` (keytar native addon) |

## Components

### abbenay daemon

The core TypeScript/Node.js process that runs as a background daemon.

**Subcommands:**
- `abbenay start` - Start all services (daemon, web dashboard, OpenAI API, MCP server)
- `abbenay daemon` - Start the gRPC server on Unix socket (or named pipe on Windows)
- `abbenay web` - Start the web dashboard (embedded in daemon or started via gRPC if daemon already running)
- `abbenay serve` - Start the OpenAI-compatible API server (same as `web` but framed for API use)
- `abbenay status` - Check if daemon is running
- `abbenay stop` - Stop the running daemon

**Socket location:**
- Linux/macOS: `$XDG_RUNTIME_DIR/abbenay/daemon.sock` or `/run/user/{uid}/abbenay/daemon.sock`
- Windows: `\\.\pipe\abbenay-daemon`

### Web Dashboard (Embedded)

The web dashboard runs inside the daemon process via Express:

- **Port**: `localhost:8787` (configurable)
- **Static assets**: Served from `packages/daemon/static/`
- **API routes**: `/api/*` -> Direct calls to `DaemonState` (no gRPC in the loop)
- **Chat SSE**: `POST /api/chat` -> Streaming responses via Server-Sent Events
- **OpenAI-compatible API**: `/v1/models`, `/v1/chat/completions` -> Drop-in replacement for any OpenAI-compatible client (see DR-020)

The web server is started either:
1. In-process when `abbenay web` or `abbenay serve` runs and no daemon is running
2. Via gRPC `StartWebServer` when a daemon is already running and `abbenay web`/`abbenay serve` is invoked

### VS Code Extension

The extension acts as a **thin gRPC client** to the daemon:

1. On activation: Connects to daemon (starts if not running)
2. Registers as a `LanguageModelChatProvider` with VS Code
3. Provides workspace paths via gRPC backchannel (`VSCodeStream`)
4. Opens web dashboard on command

**Key files:**
- `extension.ts` - Activation, commands, status bar
- `daemon/client.ts` - gRPC client wrapper
- `daemon/backchannel.ts` - Bidirectional stream handler
- `providers/AbbenayLanguageModelProvider.ts` - VS Code LM API integration

## Engine Architecture

All LLM providers are implemented via the [Vercel AI SDK](https://sdk.vercel.ai/) with a data-driven engine registry in `core/engines.ts`.

### Engine registry

Each engine entry carries metadata AND its factory function. Adding a new engine is a single registry entry — no switch statements anywhere.

```typescript
// core/engines.ts — simplified
const ENGINES: Record<string, EngineInfo> = {
  openai: {
    id: 'openai',
    requiresKey: true,
    defaultBaseUrl: 'https://api.openai.com/v1',
    defaultEnvVar: 'OPENAI_API_KEY',
    supportsTools: true,
    createModel: (modelId, config) =>
      dedicatedProvider('@ai-sdk/openai', 'createOpenAI', config, modelId),
  },
  // ... 18 more engines
};
```

### Dynamic provider loading

AI SDK provider packages (`@ai-sdk/openai`, `@ai-sdk/anthropic`, etc.) are loaded via dynamic `import()` at runtime — only when that engine is actually used. This means:

- **For the core library**: consumers install only the providers they need
- **For the daemon**: all providers are bundled into the SEA binary

If a provider package is missing, the error message tells you exactly what to install.

### Engine categories

- **Dedicated providers**: Each has its own `@ai-sdk/*` package (OpenAI, Anthropic, Gemini, Mistral, xAI, DeepSeek, Groq, Cohere, Bedrock, Fireworks, Together AI, Perplexity)
- **OpenAI-compatible**: Use `@ai-sdk/openai-compatible` (Azure, OpenRouter, Ollama, LM Studio, Cerebras, Meta)
- **Mock**: Built-in, no external package needed

## Secret Management

Secrets are managed explicitly per-provider with two options:

### Option 1: Keychain Storage (keytar)
- Uses keytar for cross-platform keychain access:
  - macOS: Keychain
  - Linux: libsecret (GNOME Keyring / KDE Wallet)
  - Windows: Credential Vault
- Config references key by name: `api_key_keychain_name: "OPENAI_API_KEY"`

### Option 2: Environment Variable Reference
- Config specifies env var name: `api_key_env_var_name: "OPENAI_API_KEY"`
- Value read from `process.env` at runtime

**Important:** These options are mutually exclusive per provider. The web UI provides a toggle to choose between them.

### SecretStore interface

```typescript
interface SecretStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<boolean>;
  has(key: string): Promise<boolean>;
}
```

`CoreState` accepts any `SecretStore` via constructor injection. `DaemonState` uses `KeychainSecretStore` (keytar-backed) by default. Tests and library consumers can use `MemorySecretStore`.

## Configuration

### Config Files

- **User level**: `~/.config/abbenay/config.yaml`
- **Workspace level**: `<workspace>/.config/abbenay/config.yaml`

### Config Format

```yaml
providers:
  my-openai:              # Virtual provider name (user-defined)
    engine: openai        # Actual engine type
    api_key_keychain_name: "OPENAI_API_KEY"
    models:               # Map of virtual model name -> config
      gpt-4o: {}          # Enabled with defaults
      gpt-4o-mini:
        temperature: 0.3
        max_tokens: 4096
```

### Config Loader

User and workspace configs are merged (workspace overrides user):

```typescript
// core/config.ts
// loadConfig(), loadWorkspaceConfig(), mergeConfigs()
// Provider config: engine, api_key_keychain_name | api_key_env_var_name, base_url, models
```

## Policies

Policies are named bundles of behavioral defaults that can be assigned to virtual models. A model references a policy by name; the policy's fields act as defaults that the model's explicit config can override.

### Resolution order (later wins)

```
Engine defaults  ←  Policy defaults  ←  Explicit ModelConfig  ←  Request params
```

### Built-in policies

| Policy | Temperature | max_tokens | Purpose |
|--------|------------|------------|---------|
| `precise` | 0.15 | 2048 | Factual, concise responses |
| `balanced` | 0.5 | 4096 | General-purpose |
| `creative` | 0.9 | 8192 | Exploratory, generative |
| `coder` | 0.2 | 4096 | Complete, runnable code |
| `json_strict` | 0.2 | 2048 | JSON-only output with retry |
| `long_context_chat` | — | 4096 | Concise follow-ups in long conversations |

### Policy config structure

```yaml
# ~/.config/abbenay/policies.yaml (user-level only)
my-policy:
  sampling:
    temperature: 0.3
    top_p: 0.8
  output:
    max_tokens: 4096
    system_prompt_snippet: "Be concise."
    system_prompt_mode: prepend   # prepend | append | replace
    format: text                  # text | json_only | markdown
  reliability:
    retry_on_invalid_json: false
    timeout: 30000
```

### Assigning a policy to a model

```yaml
# In config.yaml
providers:
  my-openai:
    engine: openai
    models:
      gpt-4o:
        policy: coder            # References a built-in or custom policy
        temperature: 0.1         # Explicit config overrides the policy
```

## Tool System

### ToolRegistry (core)

The `ToolRegistry` collects tools from multiple sources and namespaces them to prevent collisions. Part of `@abbenay/core`, usable without the daemon.

**Sources and namespace prefixes:**

| Source | Prefix | Example |
|--------|--------|---------|
| VS Code workspace | `ws:` | `ws:myproject/readFile` |
| MCP server | `mcp:` | `mcp:github/searchCode` |
| Local (agent-registered) | `local:` | `local:myAgent/search` |

**Tool policy** controls which tools the LLM sees:

| Tier | Config field | Behavior |
|------|-------------|----------|
| Auto-approve | `auto_approve` | Execute without confirmation |
| Require approval | `require_approval` | Pause and ask user |
| Disabled | `disabled_tools` | Never sent to LLM |

Patterns support glob matching (e.g., `mcp:filesystem/*`).

### ToolRouter (daemon)

The daemon's `ToolRouter` provides the execution backend for remote tools:

- **VS Code tools** → routed via gRPC backchannel (`VSCodeStream`)
- **MCP tools** → routed via `McpClientPool`
- **Local tools** → called directly via inline executor

### McpClientPool (daemon)

Manages connections to external MCP servers defined in config. Uses `@ai-sdk/mcp` for the client implementation.

- Supports stdio and HTTP/SSE transports
- Auto-discovers tools on connect and registers them in `ToolRegistry`
- Hot-reloads when config changes (connects new, disconnects removed)

```yaml
# In config.yaml
mcp_servers:
  filesystem:
    transport: stdio
    command: npx
    args: ["-y", "@modelcontextprotocol/server-filesystem", "/home/user"]
    enabled: true
  github:
    transport: http
    url: http://localhost:3001/sse
    enabled: true
```

## gRPC Protocol

Defined in `proto/abbenay/v1/service.proto`. The daemon loads protos dynamically via `@grpc/proto-loader` (no code generation for the daemon).

### Core RPCs (Implemented)

| RPC | Description |
|-----|-------------|
| `Chat` | Streaming chat with a model |
| `ListModels` | List available models from providers |
| `ListProviders` | List configured providers |
| `GetSecret` / `SetSecret` / `DeleteSecret` / `ListSecrets` | Secret management |
| `Register` / `Unregister` | Client registration |
| `VSCodeStream` | Bidirectional backchannel |
| `GetStatus` / `HealthCheck` | Daemon status |
| `GetConfig` / `UpdateConfig` | Configuration |
| `GetProviderStatus` | Provider status |
| `GetConnectedWorkspaces` | Workspace paths from VS Code |
| `StartWebServer` / `StopWebServer` | Embedded web dashboard lifecycle |
| `Shutdown` | Daemon shutdown |

### Stub RPCs (Deferred)

| RPC | Description |
|-----|-------------|
| `WatchSessions` / `ReplaySession` / `SummarizeSession` | Session features |
| `ForkSession` / `ExportSession` / `ImportSession` | Session branching |
| `ListTools` / `ExecuteTool` | Tool execution (future MCP) |
| `RegisterMcpServer` / `UnregisterMcpServer` | MCP server registration |

### VS Code Backchannel

The `VSCodeStream` RPC enables bidirectional communication:

**Daemon -> VS Code requests:**
- `GetWorkspace` - Get connected workspace paths
- `InvokeTool` - Invoke VS Code tools (future)
- `ListModels` - List VS Code LM models (future)

**VS Code -> Daemon responses:**
- Workspace folder paths
- Tool results
- Error responses

## Session Management

Sessions are persisted as JSON files in `$XDG_DATA_HOME/abbenay/sessions/`
(Linux) or `~/Library/Application Support/abbenay/sessions/` (macOS). See DR-021.

The `SessionStore` class (core layer) handles CRUD operations and maintains an
`index.json` for fast listing without reading every session file.

**Available transports:**
- gRPC: `CreateSession`, `GetSession`, `ListSessions`, `DeleteSession`, `SessionChat`, `SummarizeSession`
- Web API: `POST/GET/DELETE /api/sessions`, `POST /api/sessions/:id/chat` (SSE), `GET /api/sessions/:id/summary`
- CLI: `aby sessions list/show/delete`, `aby chat --session <id|new>`

**Periodic summaries:** Every 10 user messages, a background LLM call generates
a 2-3 sentence summary stored on the session (see DR-022). Summaries are also
available on demand via `SummarizeSession` (gRPC) or `GET /api/sessions/:id/summary`.

**Not yet implemented:** `ForkSession`, `ExportSession`, `ImportSession`,
`ReplaySession`, web dashboard session sidebar, context window compression
using summaries (`context.context_threshold` / `compression_strategy`),
internal MCP tool for cross-session retrieval.

## Data Flow

### Chat Request Flow

```
1. Client sends ChatRequest via gRPC (or POST /api/chat for web)
   ↓
2. DaemonState.chat() → CoreState.chat() resolves provider/model from composite ID
   ↓
3. CoreState.resolveApiKey() gets API key (keychain or env var based on config)
   ↓
4. engines.ts streamChat() dynamically loads the AI SDK provider and calls streamText()
   ↓
5. Response chunks streamed back to client as ChatChunk objects
```

### Model Discovery Flow

```
1. Client calls ListModels (gRPC or GET /api/models)
   ↓
2. CoreState.listModels() iterates configured providers
   ↓
3. For each configured provider:
   - Load API key from config (keychain name or env var name)
   - Resolve key value via secretStore or process.env
   - Call fetchModels(engineId, apiKey) → provider API
   ↓
4. Aggregate and return all models as ModelInfo[]
```

### Web Dashboard Flow

```
1. Browser loads http://localhost:8787
   ↓
2. Express serves static HTML/JS from packages/daemon/static/
   ↓
3. Frontend makes API calls to Express routes:
   - GET /api/providers → state.listProviders()
   - GET /api/models → state.listModels()
   - GET /api/config → loadConfig()
   - POST /api/config → saveConfig()
   - POST /api/secrets → state.secretStore.set()
   - POST /api/chat → state.chat() (SSE stream)
   - POST/GET/DELETE /api/sessions → state.sessionStore.*()
   - POST /api/sessions/:id/chat → session-scoped chat (SSE)
   - GET /v1/models → state.listModels() (OpenAI format)
   - POST /v1/chat/completions → state.chat() (OpenAI format, streaming or JSON)
   ↓
4. Web server has direct DaemonState access (no gRPC in the loop)
```

## File Locations

| File | Path | Purpose |
|------|------|---------|
| Socket (Linux/macOS) | `$XDG_RUNTIME_DIR/abbenay/daemon.sock` | gRPC server socket |
| Socket (Windows) | `\\.\pipe\abbenay-daemon` | gRPC named pipe |
| PID file | `$XDG_RUNTIME_DIR/abbenay/abbenay.pid` | Daemon process ID |
| User Config | `~/.config/abbenay/config.yaml` | User-level provider config |
| Workspace Config | `<ws>/.config/abbenay/config.yaml` | Workspace-level config |
| Session Data | `$XDG_DATA_HOME/abbenay/sessions/` | Persisted chat sessions |
| Logs | Stdout/stderr | Daemon logs |

## Security

- **Secrets**: Stored in system keychain via keytar when available; never in config files
- **Socket**: Unix socket (or named pipe) with user-only permissions
- **Web dashboard**: Listens on localhost only
- **No remote access**: Daemon designed for local use only
- **Config files**: Created with mode `0o600` (user read/write only)
