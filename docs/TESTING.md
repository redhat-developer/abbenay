# Abbenay Tests

## Test Structure

This project follows the "hybrid" test layout:

- **Unit tests** live co-located with the source code (`src/**/*.test.ts`)
- **Integration tests** live in a separate `tests/` folder inside each package

```
packages/daemon/
├── src/
│   ├── core/
│   │   ├── mock.ts
│   │   ├── mock.test.ts              <- Unit test (co-located)
│   │   ├── config.ts
│   │   ├── config.test.ts            <- Unit test (co-located)
│   │   ├── tool-registry.test.ts     <- Unit test (glob matching, registry)
│   │   ├── tool-approval.test.ts     <- Unit test (3-tier approval logic)
│   │   └── session-store.test.ts     <- Unit test (session CRUD, index)
│   ├── daemon/
│   │   ├── chat-prompt.test.ts       <- Unit test (parseApprovalInput)
│   │   └── web/
│   │       └── openai-compat.test.ts <- Unit test (OpenAI format mapping)
│   └── state.test.ts                 <- Unit test (DaemonState)
├── tests/
│   └── integration/
│       ├── grpc-streaming.test.ts    <- Integration (real gRPC server/client)
│       ├── web-sse.test.ts           <- Integration (real Express + HTTP)
│       ├── openai-compat.test.ts     <- Integration (OpenAI-compat API)
│       ├── sessions.test.ts          <- Integration (session CRUD + chat SSE)
│       └── helpers/
│           └── mock-daemon.ts        <- Shared mock gRPC server
├── vitest.config.ts
└── package.json
```

## Running Tests

```bash
# Run all daemon tests (unit + integration)
cd packages/daemon
npm test

# Run with verbose output
npx vitest run --reporter verbose

# Run only unit tests
npx vitest run src/

# Run only integration tests
npx vitest run tests/

# Watch mode
npx vitest
```

## Test Layers

### Layer 1: Unit Tests (co-located)

Pure unit tests with no I/O, no network, no processes.

| File | What it covers |
|------|----------------|
| `src/core/mock.test.ts` | Mock engine: echo, fixed, error, empty, slow modes |
| `src/core/config.test.ts` | Config loading, merging, validation |
| `src/core/tool-registry.test.ts` | Glob matching, tool registration, resolution, policy filtering |
| `src/core/tool-approval.test.ts` | 3-tier approval precedence (auto_approve, require_approval, default) |
| `src/state.test.ts` | DaemonState: provider listing, model listing, chat flow |
| `src/daemon/chat-prompt.test.ts` | `parseApprovalInput` case-sensitive routing |
| `src/daemon/web/openai-compat.test.ts` | OpenAI format mapping: models, finish reasons, stream chunks, complete responses |
| `src/core/session-store.test.ts` | SessionStore: CRUD, appendMessage, updateTitle, index consistency |

### Layer 2: Integration Tests

Tests that start real servers, make real HTTP/gRPC calls.

| File | What it covers |
|------|----------------|
| `tests/integration/grpc-streaming.test.ts` | gRPC unary RPCs + streaming + cancellation + concurrency |
| `tests/integration/web-sse.test.ts` | Web API endpoints + SSE chat streaming + errors + disconnect |
| `tests/integration/openai-compat.test.ts` | OpenAI-compatible API: /v1/models, streaming, non-streaming, errors, tool calls |
| `tests/integration/sessions.test.ts` | Session REST API: CRUD endpoints, session chat SSE streaming + persistence |

### Mock Engine

The `mock` engine (`mock/echo`, `mock/fixed`, `mock/error`, etc.) is a real engine
registered in `core/engines.ts`. No API keys or network needed. Use it for end-to-end testing:

```bash
# Chat with the mock engine via web API
curl -X POST http://localhost:8787/api/chat \
  -H 'Content-Type: application/json' \
  -d '{"model":"mock/echo","messages":[{"role":"user","content":"Hello!"}]}'
```

## Adding Tests

New unit tests should be co-located with their source files (e.g., `src/core/foo.test.ts`).
New integration tests should go in `packages/daemon/tests/integration/`.
