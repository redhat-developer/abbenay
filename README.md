# Abbenay

[![CI](https://github.com/redhat-developer/abbenay/actions/workflows/ci.yml/badge.svg)](https://github.com/redhat-developer/abbenay/actions/workflows/ci.yml)

A unified AI daemon and library for OpenAI, Anthropic, Google Gemini, Mistral, Ollama, and 10+ more providers.

## Packages

Abbenay produces two packages from a single source tree:

| Package | What | For |
|---------|------|-----|
| **@abbenay/core** | Lightweight library — LLM engine abstraction, streaming chat, model discovery, config, secret store interface. Zero transport deps. | Agent developers, web developers, custom apps |
| **@abbenay/daemon** | Complete application — gRPC server, web dashboard, CLI, VS Code backchannel, SEA binary. Bundles core internally. | End users running the daemon |

## Features

- **19 LLM engines** via the [Vercel AI SDK](https://sdk.vercel.ai/) with dynamic provider loading
- **Unified daemon**: TypeScript/Node.js service serves all clients via gRPC
- **Web dashboard**: Configure providers, API keys, and models via browser UI
- **VS Code integration**: Models appear in VS Code's Language Model picker
- **Reusable core library**: Use `@abbenay/core` in your own apps without the daemon
- **Dynamic model discovery**: Fetches available models from provider APIs
- **Tool calling**: Full tool execution loop with approval tiers
- **Single Executable Application (SEA)**: Self-contained binary, no Node.js install required

## Why "Abbenay"?

**Abbenay** is the central settlement on the anarchist moon Anarres in Ursula K. Le Guin's *The Dispossessed* (1974). The name means "mind" in the constructed language Pravic.

The name fits this project on three levels: it literally means *mind* (an AI/LLM tool), it comes from a society built on openness and shared resources rather than proprietary ownership (the open alternative to vendor lock-in), and Abbenay itself is a coordination hub in a decentralized world -- exactly what this daemon does for LLM providers, VS Code, and MCP servers.

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│  Clients                                                                 │
│  ├── VS Code Extension (gRPC)                                            │
│  ├── Web Dashboard (HTTP, embedded)                                      │
│  ├── Python scripts (gRPC)                                               │
│  └── Custom apps (@abbenay/core)                                         │
└─────────────────────────────────────────────────────────────────────────┘
                              │ gRPC (Unix socket) or direct library use
                              ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  abbenay daemon (TypeScript/Node.js)                                    │
│                                                                          │
│  ┌─ @abbenay/core ──────────────────────────────────────────────────┐   │
│  │  CoreState       engines.ts (Vercel AI SDK)    config.ts (YAML)   │   │
│  │  SecretStore     streaming chat + tools        model discovery    │   │
│  └───────────────────────────────────────────────────────────────────┘   │
│                                                                          │
│  ┌─ daemon layer ────────────────────────────────────────────────────┐   │
│  │  DaemonState     gRPC server         Web UI (Express)             │   │
│  │  CLI (Commander) VS Code backchannel KeychainSecretStore (keytar) │   │
│  └───────────────────────────────────────────────────────────────────┘   │
│                                                                          │
└──────────────────────────────────────────┬──────────────────────────────┘
                                           │ HTTP
                                           ▼
                               ┌──────────────────────┐
                               │   LLM Provider APIs   │
                               │   (OpenAI, Anthropic,  │
                               │    Gemini, Ollama...)   │
                               └──────────────────────┘
```

## Quick Start

### Using the daemon

```bash
cd packages/daemon
npm install
npm run daemon    # Start daemon (foreground)
npm run web       # Start web dashboard at http://localhost:8787
```

With the compiled binary (or SEA):

```bash
abbenay daemon        # Start daemon
abbenay web           # Start web dashboard
abbenay status        # Check status
abbenay list-engines  # Show all supported engines
abbenay list-models   # Show configured models (from your config)
abbenay chat -m openai/gpt-4o   # Interactive chat
aby daemon            # Short alias — aby is equivalent to abbenay
```

To discover what models an engine offers:

```bash
abbenay list-models --discover ollama           # keyless — works immediately
abbenay list-models --discover openai           # reads OPENAI_API_KEY from env
abbenay list-models --discover anthropic --api-key sk-...
```

### Using the core library

```typescript
import { CoreState, MemorySecretStore } from '@abbenay/core';

const core = new CoreState({ secretStore: new MemorySecretStore() });

// Add a provider on the fly — no config files needed
await core.addProvider('my-openai', {
  engine: 'openai',
  apiKey: process.env.OPENAI_API_KEY!,
  models: { 'gpt-4o': {} },
});

for await (const chunk of core.chat('my-openai/gpt-4o', [
  { role: 'user', content: 'Hello!' },
])) {
  if (chunk.type === 'text') process.stdout.write(chunk.text);
}
```

See [docs/CORE.md](docs/CORE.md) for the full library API reference.

### Building everything

**Prerequisites:** `curl` and `bash` (that's it).

The bootstrap script downloads the correct Node.js (with SEA fuse) and [uv](https://docs.astral.sh/uv/) into `.build-tools/`. No system Node.js or Python required.

```bash
./bootstrap.sh                 # downloads node + uv
source .build-tools/env.sh     # puts them on PATH
npm install                    # install dependencies
node build.js                  # full build: SEA + VSIX + zip
```

To build and install the VSIX into VS Code:

```bash
node build.js --code-install
```

See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) for all platforms, CI details, and build options.

## Supported Engines

| Engine | ID | Key Required | Tool Calling | SDK Package |
|--------|----|-------------|-------------|-------------|
| OpenAI | `openai` | Yes | Yes | `@ai-sdk/openai` |
| Anthropic | `anthropic` | Yes | Yes | `@ai-sdk/anthropic` |
| Google Gemini | `gemini` | Yes | Yes | `@ai-sdk/google` |
| Mistral | `mistral` | Yes | Yes | `@ai-sdk/mistral` |
| xAI (Grok) | `xai` | Yes | Yes | `@ai-sdk/xai` |
| DeepSeek | `deepseek` | Yes | Yes | `@ai-sdk/deepseek` |
| Groq | `groq` | Yes | Yes | `@ai-sdk/groq` |
| Cohere | `cohere` | Yes | Yes | `@ai-sdk/cohere` |
| Amazon Bedrock | `bedrock` | No* | Yes | `@ai-sdk/amazon-bedrock` |
| Fireworks | `fireworks` | Yes | Yes | `@ai-sdk/fireworks` |
| Together AI | `togetherai` | Yes | Yes | `@ai-sdk/togetherai` |
| Perplexity | `perplexity` | Yes | No | `@ai-sdk/perplexity` |
| Azure OpenAI | `azure` | Yes | Yes | `@ai-sdk/openai-compatible` |
| OpenRouter | `openrouter` | Yes | Yes | `@ai-sdk/openai-compatible` |
| Ollama | `ollama` | No | Yes | `@ai-sdk/openai-compatible` |
| LM Studio | `lmstudio` | No | Yes | `@ai-sdk/openai-compatible` |
| Cerebras | `cerebras` | Yes | Yes | `@ai-sdk/openai-compatible` |
| Meta (Llama) | `meta` | Yes | Yes | `@ai-sdk/openai-compatible` |
| Mock | `mock` | No | No | *(built-in)* |

\* Amazon Bedrock uses AWS credential chain, not an API key.

AI SDK provider packages are **dynamically loaded** — install only the ones you use.

## Configuration

### Config files

- **User level**: `~/.config/abbenay/config.yaml`
- **Workspace level**: `<workspace>/.config/abbenay/config.yaml`

### Example

```yaml
providers:
  my-openai:
    engine: openai
    api_key_keychain_name: "OPENAI_API_KEY"
    models:
      gpt-4o: {}
      gpt-4o-mini:
        temperature: 0.3

  anthropic-work:
    engine: anthropic
    api_key_env_var_name: "ANTHROPIC_API_KEY"
    models:
      claude-sonnet-4-20250514: {}

  local-ollama:
    engine: ollama
    models:
      llama3.2: {}
```

See [docs/CONFIGURATION.md](docs/CONFIGURATION.md) for the full config reference.

## Project Structure

```
abbenay/
├── packages/
│   ├── daemon/                # TypeScript daemon + core library
│   │   ├── src/
│   │   │   ├── core/          # @abbenay/core (reusable library)
│   │   │   │   ├── index.ts   # Public API exports
│   │   │   │   ├── state.ts   # CoreState class
│   │   │   │   ├── engines.ts # Engine registry (Vercel AI SDK)
│   │   │   │   ├── config.ts  # YAML config loader
│   │   │   │   ├── secrets.ts # SecretStore interface + MemorySecretStore
│   │   │   │   ├── paths.ts   # Platform-aware paths
│   │   │   │   └── mock.ts    # Mock engine for testing
│   │   │   └── daemon/        # Daemon-specific (gRPC, web, CLI)
│   │   │       ├── index.ts   # CLI entry point (Commander)
│   │   │       ├── state.ts   # DaemonState extends CoreState
│   │   │       ├── daemon.ts  # Process lifecycle
│   │   │       ├── transport.ts
│   │   │       ├── server/    # gRPC service handlers
│   │   │       ├── web/       # Express web server
│   │   │       └── secrets/   # KeychainSecretStore (keytar)
│   │   ├── static/            # Web dashboard HTML
│   │   ├── tests/             # Integration tests
│   │   └── build.js           # SEA + core package builder
│   ├── vscode/                # VS Code extension
│   ├── python/                # Python gRPC client
│   └── proto-ts/              # Generated TypeScript proto stubs
├── proto/                     # gRPC service definition
├── docs/                      # Documentation
└── build.js                   # Monorepo build orchestrator
```

## Documentation

- [Core Library (API Reference)](docs/CORE.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Configuration](docs/CONFIGURATION.md)
- [Development Guide](docs/DEVELOPMENT.md)
- [Testing](docs/TESTING.md)
- [Product Overview](docs/PRODUCT_OVERVIEW.md)

## License

MIT
