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
│   │   └── config.test.ts            <- Unit test (co-located)
│   └── state.test.ts                 <- Unit test (DaemonState)
├── tests/
│   └── integration/
│       ├── grpc-streaming.test.ts    <- Integration (real gRPC server/client)
│       ├── web-sse.test.ts           <- Integration (real Express + HTTP)
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
| `src/state.test.ts` | DaemonState: provider listing, model listing, chat flow |

### Layer 2: Integration Tests

Tests that start real servers, make real HTTP/gRPC calls.

| File | What it covers |
|------|----------------|
| `tests/integration/grpc-streaming.test.ts` | gRPC unary RPCs + streaming + cancellation + concurrency |
| `tests/integration/web-sse.test.ts` | Web API endpoints + SSE chat streaming + errors + disconnect |

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
