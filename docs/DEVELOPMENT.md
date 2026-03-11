# Development Guide

## Prerequisites

- **Node.js** (20+) and **npm** — for development and building
- **Node.js official binary** — for SEA packaging (see below)
- **protoc** — Protocol buffer compiler (for gRPC client generation)
- **python3** — For Python gRPC client generation (optional — build skips if missing)
- **VS Code** — for extension development

### macOS (Homebrew)

```bash
brew install node protobuf python3
```

### Linux (apt)

```bash
sudo apt install -y nodejs npm protobuf-compiler python3 python3-venv
```

### Node.js for SEA (required for full build)

The full build produces a Single Executable Application (SEA) binary. This requires an **official Node.js binary** downloaded from [nodejs.org](https://nodejs.org/) — package-manager-installed Node.js (Homebrew, apt, nvm, etc.) does **not** include the `NODE_SEA_FUSE` sentinel needed for SEA injection.

Download the official binary and set `NODE_SEA_BASE`:

```bash
# macOS (Apple Silicon)
curl -fsSL https://nodejs.org/dist/v22.22.0/node-v22.22.0-darwin-arm64.tar.xz | tar xJ -C /tmp
export NODE_SEA_BASE=/tmp/node-v22.22.0-darwin-arm64/bin/node

# macOS (Intel)
curl -fsSL https://nodejs.org/dist/v22.22.0/node-v22.22.0-darwin-x64.tar.xz | tar xJ -C /tmp
export NODE_SEA_BASE=/tmp/node-v22.22.0-darwin-x64/bin/node

# Linux (x64)
curl -fsSL https://nodejs.org/dist/v22.22.0/node-v22.22.0-linux-x64.tar.xz | tar xJ -C /tmp
export NODE_SEA_BASE=/tmp/node-v22.22.0-linux-x64/bin/node

# Linux (arm64)
curl -fsSL https://nodejs.org/dist/v22.22.0/node-v22.22.0-linux-arm64.tar.xz | tar xJ -C /tmp
export NODE_SEA_BASE=/tmp/node-v22.22.0-linux-arm64/bin/node
```

If `NODE_SEA_BASE` is not set, the build checks your system node for the fuse and fails with a clear error message.

## Repository Structure

```
abbenay/
├── packages/
│   ├── daemon/              # TypeScript daemon + core library
│   │   ├── src/
│   │   │   ├── core/        # @abbenay/core (reusable library)
│   │   │   │   ├── index.ts # Public API
│   │   │   │   ├── state.ts # CoreState
│   │   │   │   ├── engines.ts # Engine registry (Vercel AI SDK)
│   │   │   │   ├── config.ts  # YAML config
│   │   │   │   ├── secrets.ts # SecretStore + MemorySecretStore
│   │   │   │   ├── paths.ts   # Platform paths
│   │   │   │   └── mock.ts    # Mock engine
│   │   │   └── daemon/      # Daemon-specific code
│   │   │       ├── index.ts # CLI entry point
│   │   │       ├── state.ts # DaemonState extends CoreState
│   │   │       ├── daemon.ts
│   │   │       ├── transport.ts
│   │   │       ├── server/  # gRPC service handlers
│   │   │       ├── web/     # Express web server
│   │   │       └── secrets/ # KeychainSecretStore
│   │   ├── static/          # Web dashboard HTML
│   │   ├── tests/           # Integration tests
│   │   └── build.js         # SEA + core package builder
│   ├── python/              # Python gRPC client
│   ├── vscode/              # VS Code extension
│   └── proto-ts/            # Generated TS proto stubs
├── proto/                   # gRPC service definition
├── docs/
└── build.js                 # Monorepo build orchestrator
```

## Building

```bash
cd packages/daemon
npm install
npm run build   # TypeScript compilation
npm test        # vitest
```

## Running

```bash
# Development (via tsx, no compile step)
npm run daemon        # Start daemon (foreground)
npm run web           # Start web dashboard
npm run status        # Check status

# Production (compiled)
node dist/daemon/index.js daemon
node dist/daemon/index.js web
node dist/daemon/index.js status
node dist/daemon/index.js stop

# Or via CLI binary (aby is a short alias for abbenay)
abbenay daemon
aby status
```

## Full Build (SEA + VSIX)

```bash
# From repo root — install dependencies first
npm install

# Full build: proto generation + SEA binary + VSIX extension + zip
node build.js

# Common variations
node build.js --skip-proto     # Skip proto generation (use existing stubs)
node build.js --code-install   # Build + install VSIX into VS Code
node build.js --skip-zip       # Skip creating distribution zip

# If your system node lacks the SEA fuse:
NODE_SEA_BASE=/path/to/official/node node build.js
```

The build pipeline runs 6 stages:
1. Generate Python gRPC client (requires python3 — skips if missing)
2. Generate TypeScript gRPC client (requires protoc)
3. Build daemon: tsc type-check, esbuild bundle, core package, SEA binary
4. Package VS Code extension (VSIX)
5. Create distribution zip
6. Install VSIX into VS Code (only with `--code-install`)

> **macOS note:** The build automatically handles macOS-specific SEA requirements — it passes `--macho-segment-name NODE_SEA` to postject and re-signs the binary with an ad-hoc signature (`codesign --sign -`). No manual steps are needed.

## Development Workflow

### 1. Making Daemon Changes

Edit `src/core/` or `src/daemon/`, then:

```bash
cd packages/daemon
npm run daemon    # tsx watches and runs directly, no build needed
```

For compiled output:
```bash
npm run build
node dist/daemon/index.js daemon
```

### 2. Making Proto Changes

1. Edit `proto/abbenay/v1/service.proto`
2. Regenerate TypeScript stubs for VS Code:
   ```bash
   node build.js --proto-only
   ```
3. The daemon uses `@grpc/proto-loader` for dynamic loading and does not need stub regeneration

### 3. VS Code Extension

1. Open `packages/vscode` in VS Code
2. Press **F5** to launch Extension Development Host
3. Check Output panel -> "Abbenay Provider" for logs

### 4. Web Dashboard

1. Edit `packages/daemon/static/index.html`
2. Restart the web server to see changes
3. Start daemon + web: `npm run web` (or start daemon first, then web)

## Adding a New Engine

Edit `packages/daemon/src/core/engines.ts`:

1. Add a new entry to the `ENGINES` record with metadata and a `createModel` factory
2. That's it — no other code changes needed

Example for a dedicated `@ai-sdk/*` provider:

```typescript
const ENGINES: Record<string, EngineInfo> = {
  // ... existing engines

  newengine: {
    id: 'newengine',
    requiresKey: true,
    defaultBaseUrl: 'https://api.newengine.com/v1',
    defaultEnvVar: 'NEWENGINE_API_KEY',
    supportsTools: true,
    createModel: (modelId, config) =>
      dedicatedProvider('@ai-sdk/newengine', 'createNewEngine', config, modelId),
  },
};
```

For an OpenAI-compatible provider (no dedicated SDK package):

```typescript
  newcompat: {
    id: 'newcompat',
    requiresKey: true,
    defaultBaseUrl: 'https://api.newcompat.com/v1',
    defaultEnvVar: 'NEWCOMPAT_API_KEY',
    supportsTools: true,
    createModel: (modelId, config) =>
      openaiCompatibleProvider('newcompat', 'https://api.newcompat.com/v1', config, modelId),
  },
```

The engine will automatically appear in:
- `listEngines()` / `list-engines` CLI command
- The web dashboard's "Add Provider" wizard
- `getProviderTemplates()` for UI consumption

## Adding a New gRPC RPC

1. **Define in proto** - Edit `proto/abbenay/v1/service.proto`:
   ```protobuf
   rpc NewMethod(NewMethodRequest) returns (NewMethodResponse);
   message NewMethodRequest { string field = 1; }
   message NewMethodResponse { string result = 1; }
   ```

2. **Regenerate stubs** - Run `node build.js --proto-only` for the VS Code extension

3. **Implement handler** - Edit `packages/daemon/src/daemon/server/abbenay-service.ts`:
   ```typescript
   NewMethod(
     call: grpc.ServerUnaryCall<any, any>,
     callback: grpc.sendUnaryData<any>
   ): void {
     const req = call.request;
     callback(null, { result: 'done' });
   }
   ```

## Testing

- **Unit tests** - vitest, co-located with source (`src/core/*.test.ts`, `src/*.test.ts`)
- **Integration tests** - `tests/integration/*.test.ts`
- **Mock engine** - Use `mock/echo`, `mock/fixed`, `mock/error` for testing without network or API keys

```bash
cd packages/daemon
npm test                    # All tests
npx vitest run src/         # Unit tests only
npx vitest run tests/       # Integration tests only
```

## Debugging

- **Daemon logs** - Console output from the daemon process
- **Socket check** - `ls -la /run/user/$(id -u)/abbenay/`
- **VS Code logs** - Output panel -> "Abbenay Provider"

## Common Issues

### Socket Permission Denied

```bash
ls -la /run/user/$(id -u)/abbenay/daemon.sock
# Should be owned by your user with appropriate permissions
```

### Daemon Won't Start

```bash
# Kill any stale processes
pkill -f "abbenay-daemon"

# Remove stale socket
rm -f /run/user/$(id -u)/abbenay/daemon.sock

# Check for port conflicts
lsof -i :8787

# Restart
npm run daemon
```

### Proto Mismatch

If TypeScript clients and daemon disagree on proto format:

```bash
# Regenerate VS Code stubs
node build.js --proto-only

# Rebuild daemon (uses dynamic loading, no regeneration needed)
cd packages/daemon && npm run build
```

### Extension Not Connecting

1. Ensure daemon is running: `npm run status`
2. Check Output panel for connection errors
3. Reload VS Code window
4. Verify socket path matches expected location
