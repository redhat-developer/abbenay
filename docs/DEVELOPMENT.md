# Development Guide

## Prerequisites

The only hard prerequisites are `curl` and `bash`, both present on any macOS or Linux system. The bootstrap script downloads everything else.

If you already have Node.js 22+ and uv on your PATH, you can skip the bootstrap and use them directly.

## Quick Start

```bash
./bootstrap.sh                 # downloads Node.js 22, uv, prek into .build-tools/
source .build-tools/env.sh     # puts them on PATH
npm install                    # install dependencies
prek install && prek install -t commit-msg  # install git hooks
node build.js                  # full build (SEA + VSIX + zip)
```

## Bootstrap

`bootstrap.sh` downloads three tools into `.build-tools/` (gitignored):

| Tool | Source | Why |
|------|--------|-----|
| **Node.js** (version from `.node-version`) | [nodejs.org](https://nodejs.org/) official tarball | Official binaries include the `NODE_SEA_FUSE` sentinel required for SEA injection. Package-manager Node (Homebrew, apt, nvm) usually does not. |
| **uv** | [astral.sh](https://docs.astral.sh/uv/) | Python toolchain manager. Used to build the Python client wheel via `uvx hatch build` without needing a system Python. |
| **prek** | [github.com/j178/prek](https://prek.j178.dev/) | Pre-commit hook framework (single Rust binary). Enforces conventional commits and lint checks at commit time. |

After running the bootstrap, source the generated env file to put the tools on PATH:

```bash
source .build-tools/env.sh
```

The bootstrap is idempotent -- re-running it is a no-op if the tools are already downloaded.

### Platform / architecture matrix

The bootstrap auto-detects your OS and architecture:

| OS | Architecture | Node.js tarball | Tested in CI |
|----|-------------|-----------------|-------------|
| Linux | x86_64 (x64) | `node-v22.x.x-linux-x64.tar.xz` | Yes |
| Linux | aarch64 (arm64) | `node-v22.x.x-linux-arm64.tar.xz` | Yes |
| macOS | arm64 (Apple Silicon) | `node-v22.x.x-darwin-arm64.tar.xz` | Yes |
| macOS | x86_64 (Intel) | `node-v22.x.x-darwin-x64.tar.xz` | No (not in CI matrix) |

### Pinning the Node.js version

The Node.js version is stored in `.node-version` at the repo root. This file is read by `bootstrap.sh` and is also compatible with nvm, fnm, volta, and mise.

## Building

### Full build

```bash
node build.js
```

This runs 6 stages:

1. Generate Python gRPC client (requires `python3` -- skips if missing)
2. Generate TypeScript gRPC client (requires `protoc` -- skips if missing)
3. Build daemon: tsc type-check, esbuild bundle, core package, SEA binary
4. Package VS Code extension (VSIX)
5. Create distribution zip
6. Install VSIX into VS Code (only with `--code-install`)

### Build options

| Flag | Effect |
|------|--------|
| `--skip-proto` | Skip proto generation (use committed stubs) |
| `--proto-only` | Only regenerate proto stubs, then stop |
| `--skip-zip` | Skip creating distribution zip |
| `--code-install` | Build + install VSIX into VS Code |

### SEA binary

The daemon is packaged as a [Single Executable Application](https://nodejs.org/api/single-executable-applications.html). The build copies the Node.js binary, injects the bundled JS via `postject`, and produces a self-contained `abbenay-daemon-{platform}-{arch}` binary.

The SEA build runs a **preflight check** at the start -- before doing any esbuild work -- to verify the Node.js binary has the `NODE_SEA_FUSE` sentinel and that `postject` is available. If either is missing, the build fails immediately with a clear error.

When using the bootstrap, the downloaded Node.js is always the official binary, so the fuse is always present. If you're using your own Node.js, you can override with:

```bash
NODE_SEA_BASE=/path/to/official/node node build.js
```

### Python client wheel

```bash
npm run ci:package-python
```

This runs `uvx hatch build` in `packages/python/`, producing a wheel in `packages/python/dist/`. The bootstrapped `uv` handles downloading hatch and any needed Python version automatically.

### macOS note

The build handles macOS-specific SEA requirements automatically: it passes `--macho-segment-name NODE_SEA` to postject and re-signs the binary with an ad-hoc signature (`codesign --sign -`). No manual steps needed.

## npm scripts

### Top-level (repo root)

| Script | Command | Purpose |
|--------|---------|---------|
| `build` | `node build.js` | Full build |
| `build:dev` | `node build.js --skip-zip --code-install` | Build + install VSIX, no zip |
| `build:proto` | `node build.js --proto-only` | Regenerate proto stubs only |
| `lint` | `npm run lint --workspaces --if-present` | Lint all packages |
| `test` | `npm run test --workspaces --if-present` | Test all packages |
| `ci:build` | `node build.js --skip-proto` | Full build, skip proto (stubs committed) |
| `ci:package-python` | `cd packages/python && uvx hatch build` | Build Python wheel |

### Daemon package

| Script | Command | Purpose |
|--------|---------|---------|
| `build` | `tsc` | TypeScript compilation |
| `build:sea` | `node build.js` | SEA binary build |
| `dev` | `tsx src/daemon/index.ts` | Run daemon in dev mode (no compile) |
| `test` | `vitest` | Run tests |

## Running

```bash
# Development (via tsx, no compile step)
cd packages/daemon
npm run daemon        # start daemon (foreground)
npm run web           # start web dashboard
npm run status        # check status

# Production (compiled SEA binary)
abbenay daemon              # start daemon
abbenay web                 # start web dashboard
abbenay status              # check status
abbenay list-engines        # show all supported engines (sorted, formatted)
abbenay list-models         # show configured models from your config
abbenay list-models --discover ollama   # query an engine for available models
abbenay chat -m openai/gpt-4o          # interactive chat
aby daemon                  # short alias
```

### CLI list commands

| Command | What it shows | Network? |
|---------|--------------|----------|
| `list-engines` | All 19 supported engines with auth, tool support, and base URL | No |
| `list-models` | Configured provider/model pairs from your config (usable with `chat -m`) | No |
| `list-models --discover <engine>` | All models available from an engine's API | Yes |

All list commands support `--json` for machine-readable output.

## Development Workflow

### Daemon changes

Edit `src/core/` or `src/daemon/`, then:

```bash
cd packages/daemon
npm run daemon    # tsx runs directly, no build needed
```

### Proto changes

1. Edit `proto/abbenay/v1/service.proto`
2. Regenerate TypeScript stubs: `node build.js --proto-only`
3. The daemon uses `@grpc/proto-loader` for dynamic loading and does not need regeneration

### VS Code extension

1. Open `packages/vscode` in VS Code
2. Press **F5** to launch Extension Development Host
3. Check Output panel -> "Abbenay Provider" for logs

### Web dashboard

1. Edit `packages/daemon/static/index.html`
2. Restart the web server to see changes

## CI

CI runs in GitHub Actions (`.github/workflows/ci.yml`). The workflow follows a **lean CI** philosophy: GitHub Actions is a thin wrapper that calls the same scripts developers run locally.

### Workflow structure

```
lint-and-test (ubuntu-latest)
  └─ ./bootstrap.sh → npm ci → npm run lint
  └─ apt install xvfb → xvfb-run -a npm test

build (matrix: linux-x64, linux-arm64, macos-arm64)
  └─ ./bootstrap.sh → npm ci → npm run ci:build
  └─ uploads: SEA binary, VSIX, distribution zip

package-python (ubuntu-latest)
  └─ ./bootstrap.sh → npm run ci:package-python
  └─ uploads: Python wheel
```

### How bootstrap integrates with CI

`bootstrap.sh` detects the `$GITHUB_PATH` environment variable (set by GitHub Actions) and automatically appends its PATH entries there, so all subsequent workflow steps have `node`, `npm`, `uv`, `uvx`, and `prek` available without re-sourcing.

### Artifacts

Every CI run produces downloadable artifacts:

| Artifact | Contents |
|----------|----------|
| `abbenay-daemon-linux-x64` | SEA binary + sidecars (Linux x64) |
| `abbenay-daemon-linux-arm64` | SEA binary + sidecars (Linux arm64) |
| `abbenay-daemon-darwin-arm64` | SEA binary + sidecars (macOS Apple Silicon) |
| `abbenay-vsix-{platform}-{arch}` | VS Code extension (per platform) |
| `abbenay-client-python` | Python wheel (platform-independent) |

### Releases

A separate workflow (`.github/workflows/release.yml`) triggers when you push a `v*` tag. It builds all platforms and creates a GitHub Release with the artifacts permanently attached.

You can create a release from the GitHub UI (recommended) or from the CLI:

```bash
git tag v2026.3.1-alpha
git push --tags
```

Tags containing `alpha`, `beta`, or `rc` are automatically marked as prereleases. The workflow uses CalVer (`vYYYY.M.MICRO[-prerelease]`); do not use leading zeros in the month (semver prohibits them).

### Release artifacts

Each release produces these artifacts:

| Artifact | Description | Who needs it |
|----------|-------------|-------------|
| `abbenay-VERSION-linux-x64.tar.gz` | Standalone daemon binary + sidecars (proto, static, keytar) for Linux x64 | Standalone / CLI users on Linux x64 |
| `abbenay-VERSION-linux-arm64.tar.gz` | Same, for Linux arm64 | Standalone / CLI users on Linux arm64 |
| `abbenay-VERSION-darwin-arm64.tar.gz` | Same, for macOS Apple Silicon | Standalone / CLI users on macOS |
| `abbenay-provider-linux-x64-VERSION.vsix` | VS Code extension with embedded daemon (Linux x64) | VS Code users on Linux x64 |
| `abbenay-provider-linux-arm64-VERSION.vsix` | Same, for Linux arm64 | VS Code users on Linux arm64 |
| `abbenay-provider-darwin-arm64-VERSION.vsix` | Same, for macOS arm64 | VS Code users on macOS |
| `abbenay-core-VERSION.tgz` | `@abbenay/core` npm package (platform-independent) | Node.js consumers building on the core library |
| `abbenay_client-VERSION-py3-none-any.whl` | Python gRPC client wheel (platform-independent) | Python consumers of the gRPC API |
| `abbenay_client-VERSION.tar.gz` | Python client sdist | Alternative to the wheel |

**Quick guide:**

- **VS Code user** -- download the `.vsix` matching your OS/arch, then `code --install-extension <file>`. The daemon is bundled inside.
- **CLI / standalone daemon** -- download the `.tar.gz` for your platform, extract, and run `./abbenay-daemon`.
- **Node.js library** -- `npm install abbenay-core-*.tgz`.
- **Python gRPC client** -- `pip install abbenay_client-*.whl`.

### Reproducing CI locally

Every CI step is a standard npm script. To reproduce a CI build on your machine:

```bash
./bootstrap.sh
source .build-tools/env.sh
npm ci
npm run lint
npm test                       # or: xvfb-run -a npm test (headless Linux)
npm run ci:build
npm run ci:package-python
```

## Adding a New Engine

Edit `packages/daemon/src/core/engines.ts` and add a new entry to the `ENGINES` record. No other code changes needed.

For a dedicated `@ai-sdk/*` provider:

```typescript
newengine: {
  id: 'newengine',
  requiresKey: true,
  defaultBaseUrl: 'https://api.newengine.com/v1',
  defaultEnvVar: 'NEWENGINE_API_KEY',
  supportsTools: true,
  createModel: (modelId, config) =>
    dedicatedProvider('@ai-sdk/newengine', 'createNewEngine', config, modelId),
},
```

For an OpenAI-compatible provider:

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

## Adding a New gRPC RPC

1. Edit `proto/abbenay/v1/service.proto`
2. Regenerate stubs: `node build.js --proto-only`
3. Implement handler in `packages/daemon/src/daemon/server/abbenay-service.ts`

## Testing

### Daemon tests (Vitest)

```bash
cd packages/daemon
npm test                    # all tests
npx vitest run src/         # unit tests only
npx vitest run tests/       # integration tests only
```

Use `mock/echo`, `mock/fixed`, `mock/error` engines for testing without network or API keys.

### VS Code extension tests (@vscode/test-cli)

The extension uses `@vscode/test-cli` with `@vscode/test-electron` to run tests inside a real VS Code instance. Configuration is in `packages/vscode/.vscode-test.mjs`.

```bash
cd packages/vscode
npm test                    # compiles (pretest) then runs vscode-test
```

On headless Linux (no display server), wrap with `xvfb-run`:

```bash
xvfb-run -a npm test
```

From the repo root, `npm test` runs both daemon and extension tests via workspaces.

### Pre-commit hooks (prek)

After bootstrapping, install git hooks once:

```bash
prek install
prek install -t commit-msg
```

This installs two hooks from `.pre-commit-config.yaml`:

- **commit-msg**: validates commit messages against [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/) via commitlint
- **pre-commit**: runs `npm run lint`

To run hooks manually without committing:

```bash
prek run --all-files       # run all pre-commit hooks
prek run commitlint        # run just the commitlint hook
```

## Debugging

- **Daemon logs**: console output from the daemon process
- **Socket check**: `ls -la /run/user/$(id -u)/abbenay/`
- **VS Code logs**: Output panel -> "Abbenay Provider"

## Common Issues

### Daemon won't start

```bash
pkill -f "abbenay-daemon"
rm -f /run/user/$(id -u)/abbenay/daemon.sock
npm run daemon
```

### Proto mismatch

```bash
node build.js --proto-only        # regenerate stubs
cd packages/daemon && npm run build
```

### Extension not connecting

1. Ensure daemon is running: `npm run status` (in `packages/daemon`)
2. Check Output panel for connection errors
3. Reload VS Code window
