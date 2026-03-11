# Abbenay - Product Overview

**Status:** MVP Complete  
**Version:** 0.1.0  
**Last Updated:** February 2026

---

## Executive Summary

Abbenay is a unified AI daemon that provides consistent access to multiple LLM providers through a single interface. It enables the "Bring Your Own Model" (BYOM) vision by supporting both cloud providers (OpenAI, Anthropic, Google) and local models (Ollama).

The project implements a **TypeScript daemon** with **gRPC API**, a **web dashboard** for configuration, and a **VS Code extension** that registers models with VS Code's Language Model API.

---

## Goals Addressed

| Goal | Status | Implementation |
|------|--------|----------------|
| Decouple Provider Logic | ✅ Complete | TypeScript daemon handles all provider communication; clients use gRPC |
| Enable BYOM | ✅ Complete | 19 providers supported including local (Ollama) and custom endpoints |
| Centralize Configuration | ✅ Complete | YAML config files at user/workspace level; web dashboard for easy editing |
| Accelerate AI Infusion | ✅ Complete | Ready-made gRPC API; VS Code integration via Language Model API |

---

## Supported Engines

19 engines via the [Vercel AI SDK](https://sdk.vercel.ai/) with dynamically loaded `@ai-sdk/*` packages.

| Engine | ID | Tool Calling | SDK Package |
|--------|----|-------------|-------------|
| OpenAI | `openai` | Yes | `@ai-sdk/openai` |
| Anthropic | `anthropic` | Yes | `@ai-sdk/anthropic` |
| Google Gemini | `gemini` | Yes | `@ai-sdk/google` |
| Mistral | `mistral` | Yes | `@ai-sdk/mistral` |
| xAI (Grok) | `xai` | Yes | `@ai-sdk/xai` |
| DeepSeek | `deepseek` | Yes | `@ai-sdk/deepseek` |
| Groq | `groq` | Yes | `@ai-sdk/groq` |
| Cohere | `cohere` | Yes | `@ai-sdk/cohere` |
| Amazon Bedrock | `bedrock` | Yes | `@ai-sdk/amazon-bedrock` |
| Fireworks | `fireworks` | Yes | `@ai-sdk/fireworks` |
| Together AI | `togetherai` | Yes | `@ai-sdk/togetherai` |
| Perplexity | `perplexity` | No | `@ai-sdk/perplexity` |
| Azure OpenAI | `azure` | Yes | `@ai-sdk/openai-compatible` |
| OpenRouter | `openrouter` | Yes | `@ai-sdk/openai-compatible` |
| Ollama | `ollama` | Yes | `@ai-sdk/openai-compatible` |
| LM Studio | `lmstudio` | Yes | `@ai-sdk/openai-compatible` |
| Cerebras | `cerebras` | Yes | `@ai-sdk/openai-compatible` |
| Meta (Llama) | `meta` | Yes | `@ai-sdk/openai-compatible` |
| Mock | `mock` | No | *(built-in)* |

**Notes:** 
- Ollama supports any model that can run locally (Llama, Mistral, Qwen, DeepSeek, etc.)
- Models are discovered dynamically from provider APIs when possible
- All streaming; provider packages loaded on demand

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                    Consumer Applications                         │
│                                                                  │
│   VS Code Extension     Python Scripts      Web Dashboard        │
│   (gRPC client)         (gRPC client)       (HTTP → DaemonState) │
│         │                      │                   │             │
│   Custom Apps                                                    │
│   (@abbenay/core)                                                │
└─────────┼──────────────────────┼───────────────────┼─────────────┘
          │                      │                   │
          └──────────────────────┼───────────────────┘
                                 │ gRPC over Unix Socket
                                 ▼
┌─────────────────────────────────────────────────────────────────┐
│                     abbenay daemon (TypeScript)                  │
│                                                                  │
│   ┌─ @abbenay/core ────────────────────────────────────────┐    │
│   │  CoreState       Engines (Vercel AI SDK)   Config (YAML) │    │
│   │  SecretStore     Streaming chat + tools    Discovery     │    │
│   └──────────────────────────────────────────────────────────┘    │
│                                                                  │
│   ┌─ daemon layer ──────────────────────────────────────────┐    │
│   │  DaemonState     gRPC Server       Web UI (Express)      │    │
│   │  CLI             VS Code backchannel  Keychain (keytar)  │    │
│   └──────────────────────────────────────────────────────────┘    │
│                                                                  │
└────────────────────────────────┬────────────────────────────────┘
                                 │ HTTP
                                 ▼
                    ┌─────────────────────────┐
                    │    LLM Provider APIs     │
                    │  OpenAI, Anthropic,      │
                    │  Gemini, Ollama...       │
                    └─────────────────────────┘
```

### Two Packages, One Source Tree

| Package | Contents | Audience |
|---------|----------|----------|
| **@abbenay/core** | LLM engine abstraction, streaming chat, config, secret store interface | Agent devs, web devs, custom apps |
| **@abbenay/daemon** | gRPC, web UI, CLI, VS Code backchannel, SEA binary (bundles core) | End users |

### Why TypeScript Daemon?

1. **Single source of truth** - Configuration and secrets managed centrally
2. **Reusable core** - Library usable without the daemon for agent/web development
3. **Performance** - Async streaming with minimal overhead
4. **Simplicity** - Clients are thin gRPC wrappers, not embedded native code

---

## Components

### 1. TypeScript Daemon (`abbenay daemon`)

The core service that runs as a background process:
- Listens on Unix socket for gRPC requests
- Manages provider connections and API keys
- Handles chat streaming and session persistence
- Stores secrets in system keychain

### 2. Web Dashboard (`abbenay web`)

Browser-based configuration UI:
- Configure API keys (keychain or environment variable)
- Enable/disable providers and models
- View connection status
- Choose user or workspace config level

### 3. VS Code Extension

Integrates Abbenay with VS Code:
- Connects to daemon on activation
- Registers models with VS Code's Language Model API
- Provides workspace path info via backchannel
- Commands: "Show Daemon Status", "Open Dashboard"

---

## VS Code Integration

### How Models Appear in VS Code

```
Other VS Code Extensions (e.g., Ansible)
         │
         │  vscode.lm.selectChatModels({ vendor: 'abbenay' })
         ▼
Abbenay Extension → Returns configured models
         │
         │  model.sendRequest(messages, options)
         ▼
Daemon → Streams response from actual provider
```

Any extension using VS Code's standard LM API can use Abbenay providers without custom code.

---

## Configuration & Secrets

### Configuration Files

| Location | Purpose |
|----------|---------|
| `~/.config/abbenay/config.yaml` | User-level (global) settings |
| `<workspace>/.config/abbenay/config.yaml` | Workspace-specific settings |

### API Key Storage

Two mutually exclusive options per provider:

| Option | Field | Best For |
|--------|-------|----------|
| Keychain | `api_key_keychain_name` | Personal development, highest security |
| Environment Variable | `api_key_env_var_name` | CI/CD, containers, shared environments |

Example config:
```yaml
providers:
  openai:
    engine: openai
    api_key_keychain_name: "OPENAI_API_KEY"
    models:
      gpt-4o: {}
      gpt-4o-mini: {}
  anthropic:
    engine: anthropic
    api_key_env_var_name: "ANTHROPIC_API_KEY"
    models:
      claude-sonnet-4-20250514: {}
```

---

## User Stories - Implementation Status

| ID | Title | Status | Notes |
|----|-------|--------|-------|
| 1 | Centralized Config | ✅ Complete | YAML config shared across all tools |
| 2 | Local Model Support | ✅ Complete | Ollama provider with auto-discovery |
| 3 | Simplified Integration | ✅ Complete | Standard VS Code LM API |
| 4 | Provider Switching | ✅ Complete | Enable/disable via web dashboard |
| 5 | Session Continuity | Deferred | Stub RPCs exist; full implementation in a future release |

---

## Acceptance Criteria - Status

### Core Functionality

| Criterion | Status | Notes |
|-----------|--------|-------|
| Discover/connect to Ollama | ✅ Complete | Auto-connects to localhost:11434 |
| OpenAI-compatible endpoints | ✅ Complete | vLLM, RHEL AI, TGI all work |
| Secure API key storage | ✅ Complete | System keychain + env var support |
| Dynamic model discovery | ✅ Complete | Models fetched from provider APIs |

### Extension Integration

| Criterion | Status | Notes |
|-----------|--------|-------|
| VS Code Language Model API | ✅ Complete | `vscode.lm.selectChatModels({ vendor: 'abbenay' })` |
| Connection status | ✅ Complete | Status bar item + status panel |
| Web-based configuration | ✅ Complete | Dashboard at localhost:8787 |

---

## Out of Scope

| Item | Notes |
|------|-------|
| Chat UI | Extension provides status, not chat interface |
| Model Hosting | Connects to existing running models only |
| Telemetry | No model evaluation or quality metrics |
| Billing | No subscription or payment management |

---

## Session Continuity

Session continuity is **deferred** to a future release. Stub RPCs exist in the gRPC proto but return `UNIMPLEMENTED`. The vision is to enable starting a chat in VS Code and continuing from CLI or another tool, with JSON-based session persistence.

---

## Deployment

| Component | Distribution |
|-----------|--------------|
| TypeScript Daemon | Node.js package (Linux/macOS/Windows) |
| VS Code Extension | VSIX package → Marketplace |
| Python Client | pip package |
| Web Dashboard | Served by daemon (embedded in process) |

---

## Next Steps

1. **Public Repository** - Move to GitHub organization
2. **Marketplace Publishing** - Submit VS Code extension
3. **PyPI Publishing** - Publish Python gRPC client
4. **RHEL AI Testing** - Validate with RHEL AI endpoints
5. **Ansible Extension Integration** - Enable Ansible extension to use Abbenay

---

## Appendix: Provider-Specific Notes

### Ollama
- Default endpoint: `http://localhost:11434`
- No API key required
- Model list fetched dynamically

### Azure OpenAI
- Requires custom API base URL
- Model names may differ from OpenAI standard

### OpenRouter
- Aggregator supporting 100+ models
- Single API key for all providers
- Model IDs prefixed with provider

### RHEL AI / vLLM / TGI
- Use OpenAI-compatible provider
- Set custom API base URL
- API key optional depending on server config
