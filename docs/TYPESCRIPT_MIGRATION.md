# Abbenay TypeScript Migration Plan

> **Historical document.** This plan described the Rust-to-TypeScript migration, which is complete.
> The codebase has since moved from `multi-llm-ts` to the Vercel AI SDK (`@ai-sdk/*`)
> and been reorganized into a core/daemon split. See [ARCHITECTURE.md](ARCHITECTURE.md) for
> the current design.

**Status:** Complete (historical)  
**Date:** February 2026  
**Objective:** Rewrite the Rust daemon core in TypeScript while preserving all functionality

---

## Migration Status

| Phase | Status |
|-------|--------|
| Phase 1 (Foundation) | COMPLETE |
| Phase 2 (Provider Integration) | COMPLETE |
| Phase 3 (VS Code Backchannel) | COMPLETE |
| Phase 4 (Web Dashboard) | COMPLETE |
| Phase 5 (SEA Packaging) | COMPLETE |
| Phase 6 (Testing & Validation) | PARTIAL (53 tests passing) |

> **Note:** The Rust core has been removed. The TypeScript daemon in `packages/daemon/` is now the primary implementation.

---

## Executive Summary

This document outlines the plan to migrate the Abbenay daemon from Rust to TypeScript. The migration will:

- **Keep**: gRPC API, web dashboard UI, VS Code extension, all current functionality
- **Replace**: Rust daemon with TypeScript/Node.js daemon
- **Leverage**: `multi-llm-ts` library for provider implementations

The migration prioritizes functionality preservation and incremental delivery.

---

## Motivation

- Reduce barrier to contribution (TypeScript more accessible than Rust)
- Unify language stack (TypeScript for daemon, extension, and web)
- Leverage existing `multi-llm-ts` library for proven provider implementations
- Faster iteration on daemon features

---

## Current Rust Architecture

```
crates/abbenay/src/
├── main.rs                 # CLI entrypoint (daemon, web, status, stop)
├── state.rs                # Central daemon state
├── transport.rs            # Unix socket / TCP transport
├── server/                 # gRPC service handlers
│   ├── service.rs          # Abbenay service implementation
│   ├── handlers.rs         # RPC handlers
│   └── mcp_bridge.rs       # MCP bridge service
├── session/                # Session management
│   ├── manager.rs          # Session CRUD
│   ├── persistence.rs      # File-based persistence
│   └── types.rs            # Session, Message types
├── providers/              # LLM providers
│   ├── genai_adapter.rs    # genai crate wrapper
│   ├── mock.rs             # Mock provider for testing
│   └── traits.rs           # Provider trait
├── secrets/                # Secret storage
│   ├── keychain_store.rs   # System keychain
│   ├── memory_store.rs     # In-memory (testing)
│   └── traits.rs           # SecretStore trait
├── resolver/               # Config/secret resolution
│   ├── config_resolver.rs  # YAML config loading
│   └── secret_resolver.rs  # API key resolution
├── config/                 # Configuration
│   └── file.rs             # File-based config
├── tools/                  # Tool orchestration
│   ├── orchestrator.rs     # Tool call loop
│   └── registry.rs         # Tool registry
└── web/                    # Web dashboard
    ├── routes.rs           # HTTP API routes
    ├── client.rs           # gRPC client to daemon
    └── static/index.html   # Dashboard UI (RHDS)
```

### Key Components to Migrate

| Component | Rust Module | Complexity | multi-llm-ts Coverage |
|-----------|-------------|------------|----------------------|
| **Providers** | `providers/genai_adapter.rs` | High | ✅ Full - use `multi-llm-ts` |
| **gRPC Server** | `server/service.rs` | High | ❌ Implement with `@grpc/grpc-js` |
| **State Management** | `state.rs` | Medium | ❌ Implement from scratch |
| **Secret Store** | `secrets/keychain_store.rs` | Medium | ❌ Use `keytar` or similar |
| **Config Resolver** | `resolver/` | Low | ❌ Implement with `js-yaml` |
| **Transport** | `transport.rs` | Medium | ❌ Unix socket via Node.js |
| **Web Dashboard** | `web/` | Low | ❌ Keep existing, port routes |
| **MCP Bridge** | `server/mcp_bridge.rs` | Medium | ❌ Port to TypeScript |

> **Note:** Session management is defined in the proto but not fully implemented in Rust today. It's deferred to a future phase.

---

## Target TypeScript Architecture

```
packages/daemon/
├── src/
│   ├── index.ts              # CLI entrypoint
│   ├── daemon.ts             # Daemon startup/shutdown
│   ├── state.ts              # Central daemon state
│   ├── transport.ts          # Unix socket / TCP transport
│   ├── server/
│   │   ├── grpc-server.ts    # gRPC server setup
│   │   └── abbenay-service.ts # Abbenay service handlers
│   ├── providers/
│   │   ├── adapter.ts        # multi-llm-ts adapter
│   │   └── registry.ts       # Provider registry
│   ├── secrets/
│   │   ├── keychain.ts       # Keychain via keytar
│   │   ├── memory.ts         # In-memory store
│   │   └── types.ts          # SecretStore interface
│   ├── config/
│   │   ├── loader.ts         # YAML config loading
│   │   └── types.ts          # Config interfaces
│   └── web/
│       ├── server.ts         # Express/Fastify HTTP server
│       ├── routes.ts         # API routes
│       └── static/           # Dashboard UI (unchanged)
├── package.json
└── tsconfig.json
```

---

## Migration Phases

### Phase 1: Foundation (Week 1)

**Goal:** Establish TypeScript project structure and basic daemon lifecycle.

#### Tasks

1. **Create `packages/daemon` package**
   ```bash
   mkdir -p packages/daemon/src
   cd packages/daemon
   npm init
   npm install typescript @types/node tsx
   npm install @grpc/grpc-js @grpc/proto-loader
   npm install multi-llm-ts
   npm install keytar js-yaml express
   ```

2. **Port transport layer**
   - Unix socket listener (Node.js `net` module)
   - PID file management
   - Daemon lifecycle (start, stop, status)

3. **Set up gRPC server skeleton**
   - Load proto definitions
   - Create service stubs
   - Test basic connectivity

4. **Port configuration loader**
   - Read `~/.config/abbenay/config.yaml`
   - Parse provider config structure
   - Support workspace-level config

**Deliverable:** Daemon starts, listens on socket, responds to `status` command.

---

### Phase 2: Provider Integration (Week 2)

**Goal:** Integrate `multi-llm-ts` for LLM provider support.

#### Tasks

1. **Create provider adapter**
   - Map `multi-llm-ts` engines to Abbenay provider interface
   - Implement `chat()` with streaming
   - Implement `listModels()`

2. **Port secret store**
   - Use `keytar` for system keychain access
   - Implement environment variable lookup
   - Match Rust's explicit keychain/env resolution

3. **Implement provider registry**
   - Initialize all supported providers
   - Dynamic model discovery
   - API key resolution from config

**Provider Mapping (multi-llm-ts → Abbenay):**

| Abbenay Provider | multi-llm-ts Engine | Notes |
|------------------|---------------------|-------|
| `openai` | `OpenAI` | Direct mapping |
| `anthropic` | `Anthropic` | Direct mapping |
| `gemini` | `Google` | Rename |
| `mistral` | `MistralAI` | Direct mapping |
| `ollama` | `Ollama` | Direct mapping |
| `azure` | `Azure` | Direct mapping |
| `openrouter` | `OpenRouter` | Direct mapping |
| `deepseek` | `DeepSeek` | Direct mapping |
| `groq` | `Groq` | Direct mapping |
| `xai` | `XAI` | Direct mapping |
| `together` | - | Add to multi-llm-ts or custom |
| `cohere` | - | Add to multi-llm-ts or custom |

**Deliverable:** `ListProviders`, `ListModels`, and streaming `Chat` work.

---

### Phase 3: VS Code Backchannel (Week 3)

**Goal:** Bidirectional VS Code communication.

#### Tasks

1. **Port VS Code stream handling**
   - Bidirectional gRPC stream (`VSCodeStream`)
   - Request/response correlation
   - Workspace path queries

2. **Port state management**
   - Connected clients tracking
   - VS Code connection registry
   - Pending request management

3. **Implement backchannel RPCs**
   - `GetWorkspace` request/response
   - `GetConnectedWorkspaces` aggregation

**Deliverable:** VS Code extension connects, workspace paths flow to web dashboard.

---

### Phase 4: Web Dashboard (Week 4)

**Goal:** Port web server and API routes.

#### Tasks

1. **Create HTTP server**
   - Express or Fastify
   - Serve static files (existing `index.html`)
   - gRPC client to daemon

2. **Port API routes**
   - `GET /api/providers` → List providers
   - `GET /api/models` → List models
   - `GET /api/config` → Load config
   - `POST /api/config` → Save config
   - `GET /api/api-key-status` → Check key availability
   - `POST /api/secrets/:key` → Store secret
   - `DELETE /api/secrets/:key` → Delete secret
   - `GET /api/workspaces` → Get VS Code workspaces
   - `POST /api/chat` → SSE chat endpoint

3. **Verify dashboard UI**
   - No changes to `index.html` needed
   - Test all CRUD operations

**Deliverable:** Web dashboard fully functional at `localhost:8787`.

---

### Phase 5: Single Executable Application (Week 5)

**Goal:** Package daemon as standalone binary (no Node.js required).

#### Background

Node.js 20+ supports [Single Executable Applications (SEA)](https://nodejs.org/api/single-executable-applications.html), allowing bundling of the app and Node.js runtime into a single binary. This matches the Rust daemon's distribution model.

#### Tasks

1. **Bundle with esbuild**
   ```bash
   npm install esbuild --save-dev
   ```
   
   Bundle all TypeScript into single JS file:
   ```bash
   esbuild src/index.ts --bundle --platform=node --outfile=dist/daemon.js
   ```

2. **Create SEA configuration**
   
   `sea-config.json`:
   ```json
   {
     "main": "dist/daemon.js",
     "output": "dist/sea-prep.blob",
     "disableExperimentalSEAWarning": true,
     "useCodeCache": true
   }
   ```

3. **Generate SEA blob**
   ```bash
   node --experimental-sea-config sea-config.json
   ```

4. **Create executable**
   ```bash
   # Copy node binary
   cp $(which node) dist/abbenay
   
   # Inject SEA blob
   npx postject dist/abbenay NODE_SEA_BLOB dist/sea-prep.blob \
     --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2
   
   # Sign on macOS
   codesign --sign - dist/abbenay
   ```

5. **Handle native modules (keytar)**
   
   `keytar` uses native bindings. Options:
   - **Option A**: Bundle prebuilt binaries for each platform
   - **Option B**: Use `@aspect-build/rules_js` for hermetic builds
   - **Option C**: Switch to `secret-service` (Linux) / `keychain-cli` wrapper

6. **Build matrix for CI**
   
   | Platform | Architecture | Binary |
   |----------|--------------|--------|
   | Linux | x64 | `abbenay-linux-x64` |
   | Linux | arm64 | `abbenay-linux-arm64` |
   | macOS | x64 | `abbenay-darwin-x64` |
   | macOS | arm64 | `abbenay-darwin-arm64` |
   | Windows | x64 | `abbenay-win-x64.exe` |

**Deliverable:** Single `abbenay` binary that works without Node.js installed.

---

### Phase 6: Testing & Validation (Week 6)

**Goal:** Ensure feature parity and stability.

#### Tasks

1. **Create integration tests**
   - gRPC client tests
   - Provider tests (mocked)
   - Config/secret tests

2. **Parallel running validation**
   - Run Rust and TypeScript daemons on different sockets
   - Compare behavior for all RPCs

3. **VS Code extension testing**
   - Connect extension to TypeScript daemon
   - Verify Language Model API integration

4. **Web dashboard testing**
   - All UI flows
   - Config persistence
   - Secret management

5. **SEA binary testing**
   - Test on clean systems (no Node.js)
   - Verify all platforms build correctly

**Deliverable:** All existing functionality verified, binaries work standalone.

---

## Future Work (Post-Migration)

These features are defined in the proto but not currently implemented:

### Session Management

- `CreateSession`, `ListSessions`, `GetSession`, `DeleteSession`
- `SessionChat` (chat within a session context)
- `ForkSession`, `ReplaySession`
- `ExportSession`, `ImportSession`
- Persistence to `~/.config/abbenay/sessions/*.json`

### MCP Bridge

- `ListMcpTools`, `CallTool`, `CallToolsBatch`
- Tool orchestration during chat
- Resource and prompt support

---

## API Compatibility

The gRPC API remains unchanged. The proto file stays the same. 

**RPCs to implement in initial migration:**

```protobuf
service Abbenay {
  // Client lifecycle
  rpc Register(RegisterRequest) returns (RegisterResponse);
  rpc Unregister(UnregisterRequest) returns (Empty);
  
  // Chat (stateless)
  rpc Chat(ChatRequest) returns (stream ChatChunk);
  
  // Discovery
  rpc ListProviders(ListProvidersRequest) returns (ListProvidersResponse);
  rpc ListModels(ListModelsRequest) returns (ListModelsResponse);
  
  // Secrets
  rpc GetSecret(GetSecretRequest) returns (GetSecretResponse);
  rpc SetSecret(SetSecretRequest) returns (Empty);
  rpc DeleteSecret(DeleteSecretRequest) returns (Empty);
  rpc ListSecrets(ListSecretsRequest) returns (ListSecretsResponse);
  
  // VS Code backchannel
  rpc VSCodeStream(stream VSCodeResponse) returns (stream VSCodeRequest);
  rpc GetConnectedWorkspaces(GetConnectedWorkspacesRequest) returns (GetConnectedWorkspacesResponse);
  
  // Lifecycle
  rpc Shutdown(Empty) returns (Empty);
}
```

**RPCs deferred to future work (session management):**
- `SessionChat`, `CreateSession`, `ListSessions`, `GetSession`, `DeleteSession`
- `ForkSession`, `ReplaySession`, `ExportSession`, `ImportSession`

---

## Dependencies

### New TypeScript Dependencies

```json
{
  "dependencies": {
    "multi-llm-ts": "^1.0.0",
    "@grpc/grpc-js": "^1.10.0",
    "@grpc/proto-loader": "^0.7.0",
    "keytar": "^7.9.0",
    "js-yaml": "^4.1.0",
    "express": "^4.18.0",
    "uuid": "^9.0.0",
    "commander": "^12.0.0"
  },
  "devDependencies": {
    "typescript": "^5.4.0",
    "@types/node": "^20.0.0",
    "@types/js-yaml": "^4.0.0",
    "@types/express": "^4.17.0",
    "@types/uuid": "^9.0.0",
    "tsx": "^4.0.0",
    "vitest": "^1.0.0",
    "esbuild": "^0.20.0",
    "postject": "^1.0.0"
  }
}
```

### Node.js Version Requirement

- **Node.js 20.0.0+** required for Single Executable Application support
- Recommended: Node.js 22 LTS for improved SEA stability

### multi-llm-ts Capabilities

The library provides:
- ✅ Streaming chat completion
- ✅ Tool/function calling
- ✅ Vision (image input)
- ✅ Abort/cancellation
- ✅ Usage tracking
- ✅ 12 provider implementations

Missing providers we need to add or implement separately:
- Together AI
- Cohere
- Fireworks
- Custom/vLLM endpoints

---

## File Mapping

| Rust File | TypeScript File | Notes |
|-----------|-----------------|-------|
| `main.rs` | `src/index.ts` | CLI with commander |
| `state.rs` | `src/state.ts` | Class-based state |
| `transport.rs` | `src/transport.ts` | Node.js `net` module |
| `server/service.rs` | `src/server/abbenay-service.ts` | @grpc/grpc-js |
| `providers/genai_adapter.rs` | `src/providers/adapter.ts` | Wrap multi-llm-ts |
| `secrets/keychain_store.rs` | `src/secrets/keychain.ts` | Use keytar |
| `resolver/config_resolver.rs` | `src/config/loader.ts` | Use js-yaml |
| `web/routes.rs` | `src/web/routes.ts` | Use express |
| `web/static/index.html` | `src/web/static/index.html` | Copy unchanged |

---

## Rollout Strategy

### Development

1. Develop TypeScript daemon in `packages/daemon`
2. Keep Rust daemon functional during development
3. Use different socket paths for parallel testing

### Transition

1. Update VS Code extension to detect daemon type
2. Update web server to work with either backend
3. Gradual rollout to testers

### Deprecation

1. Mark Rust daemon as deprecated
2. Remove after TypeScript daemon stable
3. Clean up Rust-specific docs

---

## Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Performance regression | Medium | Benchmark critical paths, optimize hot spots |
| Keytar platform issues | Medium | Fallback to env vars, test on all platforms |
| gRPC streaming differences | Low | Thorough testing, match Rust behavior |
| multi-llm-ts limitations | Medium | Contribute upstream or fork if needed |
| **SEA + native modules** | High | Bundle prebuilt binaries or use CLI wrappers for keychain |
| **SEA binary size** | Low | Accept ~80-100MB binary (Node.js runtime included) |
| **SEA platform testing** | Medium | CI matrix for all target platforms |

---

## Success Criteria

- [ ] Core gRPC RPCs work: `Register`, `Chat`, `ListProviders`, `ListModels`
- [ ] VS Code extension connects and registers models
- [ ] VS Code backchannel works (workspace queries)
- [ ] Web dashboard fully operational
- [ ] All 12+ providers working via multi-llm-ts
- [ ] Keychain storage functional on Linux/macOS/Windows
- [ ] Config loading/saving works (user + workspace levels)
- [ ] No regression in streaming latency
- [ ] Test suite passing
- [ ] **SEA binaries work on clean systems (no Node.js installed)**
- [ ] **Binaries built for Linux (x64/arm64), macOS (x64/arm64), Windows (x64)**

---

## Appendix: multi-llm-ts Quick Reference

### Basic Usage

```typescript
import { loadModels, igniteModel, Message } from 'multi-llm-ts';

// Load available models
const config = { apiKey: 'sk-...' };
const models = await loadModels('openai', config);

// Create model instance
const model = igniteModel('openai', models.chat[0], config);

// Chat with streaming
const messages = [new Message('user', 'Hello!')];
const stream = await model.stream(messages);
for await (const chunk of stream) {
  process.stdout.write(chunk.text || '');
}
```

### Supported Providers

```typescript
import { OpenAI, Anthropic, Google, Ollama, Azure, OpenRouter } from 'multi-llm-ts';
```

### Capabilities Check

```typescript
const caps = engine.getModelCapabilities(model);
// { tools: true, vision: true, reasoning: false, caching: false }
```

---

## Next Steps

1. Review and approve this plan
2. Create `packages/daemon` package structure
3. Begin Phase 1 implementation
4. Weekly progress check-ins
