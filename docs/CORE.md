# @abbenay/core

A lightweight, transport-agnostic library for integrating LLM engines into your applications. Use it in agents, web apps, CLI tools, or any Node.js project that needs multi-provider LLM access.

## What is it?

`@abbenay/core` is the reusable library extracted from the Abbenay daemon. It provides:

- **Multi-engine abstraction** over 15+ LLM providers via the Vercel AI SDK
- **Streaming chat** with tool calling support
- **Model discovery** from provider APIs
- **YAML configuration** management (user-level and workspace-level)
- **Pluggable secret store** for API key management

It has **zero transport dependencies** — no gRPC, no Express, no CLI. Just the LLM logic.

## Install

```bash
npm install @abbenay/core
```

Then install only the AI SDK provider packages you need:

```bash
npm install @ai-sdk/openai        # for OpenAI
npm install @ai-sdk/anthropic     # for Anthropic
npm install @ai-sdk/google        # for Google Gemini
npm install @ai-sdk/openai-compatible  # for Ollama, OpenRouter, LM Studio, etc.
```

Provider packages are **optional peer dependencies** — loaded dynamically at runtime only when you use that engine. If a package is missing, you get a clear error message telling you what to install.

## Quick Start

### Programmatic (no config files)

Build providers entirely in memory — no YAML, no disk:

```typescript
import { CoreState, MemorySecretStore } from '@abbenay/core';

const core = new CoreState({ secretStore: new MemorySecretStore() });

// Add a provider with an API key — stored in-memory, ready immediately
await core.addProvider('my-openai', {
  engine: 'openai',
  apiKey: process.env.OPENAI_API_KEY!,
  models: { 'gpt-4o': {}, 'gpt-4o-mini': { temperature: 0.3 } },
});

// Stream a chat response
for await (const chunk of core.chat('my-openai/gpt-4o', [
  { role: 'user', content: 'Hello!' },
])) {
  if (chunk.type === 'text') process.stdout.write(chunk.text);
  if (chunk.type === 'done') console.log('\n[done]');
}
```

### From config files

If you have a `~/.config/abbenay/config.yaml`, CoreState reads it automatically:

```typescript
const core = new CoreState({ secretStore: new MemorySecretStore() });

// Reads providers from disk config
const providers = await core.listProviders();
const models = await core.listModels();
```

You can also mix both — disk config plus programmatic additions. In-memory providers take precedence.

## Configuration

`@abbenay/core` uses the same YAML config files as the full Abbenay daemon.

### Config file locations

- **User level**: `~/.config/abbenay/config.yaml`
- **Workspace level**: `<workspace>/.config/abbenay/config.yaml`

### Config format

```yaml
providers:
  my-openai:
    engine: openai
    api_key_keychain_name: "OPENAI_API_KEY"
    models:
      gpt-4o: {}
      gpt-4o-mini:
        temperature: 0.3
        max_tokens: 4096

  local-ollama:
    engine: ollama
    base_url: "http://127.0.0.1:11434/v1"
    models:
      llama3.2: {}
      qwen2.5-coder:
        model_id: "qwen2.5-coder:7b"
```

Key concepts:

- **Virtual provider** — a user-defined name (e.g., `my-openai`) that maps to an engine
- **Engine** — the actual API backend (`openai`, `anthropic`, `ollama`, etc.)
- **Virtual model** — a user-defined name within a provider; maps to an engine model ID
- **Composite ID** — `{provider}/{model}` (e.g., `my-openai/gpt-4o`) used in `chat()` calls

### Programmatic config access

```typescript
import { loadConfig, saveConfig, getUserConfigPath } from '@abbenay/core';

const config = loadConfig();
console.log(config.providers);

// Modify and save
config.providers!['my-openai'].models!['gpt-4o'] = { temperature: 0.7 };
saveConfig(config);
```

## API Reference

### CoreState

The main entry point. Manages providers, models, and chat.

```typescript
import { CoreState, MemorySecretStore } from '@abbenay/core';

const core = new CoreState({
  secretStore: new MemorySecretStore(),  // or your own SecretStore implementation
  configLoader: () => myCustomConfig,    // optional: override config loading
});
```

#### Builder Methods (in-memory, no disk writes)

| Method | Returns | Description |
|--------|---------|-------------|
| `addProvider(id, options)` | `Promise<void>` | Add a provider programmatically |
| `removeProvider(id)` | `boolean` | Remove an in-memory provider |
| `addModel(providerId, modelName, config?)` | `void` | Add a model to an existing provider |
| `removeModel(providerId, modelName)` | `boolean` | Remove a model from a provider |
| `hasProvider(id)` | `boolean` | Check if a provider exists |

#### Query & Chat Methods

| Method | Returns | Description |
|--------|---------|-------------|
| `listProviders(workspacePaths?)` | `Promise<ProviderInfo[]>` | List all virtual providers with config status |
| `listModels(workspacePaths?)` | `Promise<ModelInfo[]>` | List all virtual models across providers |
| `listEngines()` | `EngineInfo[]` | List available engine types (the fixed set) |
| `discoverModels(engineId, apiKey?, baseUrl?)` | `Promise<DiscoveredModel[]>` | Fetch models from an engine's API |
| `resolveApiKey(providerId, providerCfg?)` | `Promise<string \| null>` | Resolve API key from keychain or env var |
| `chat(compositeModelId, messages, params?, toolOptions?, toolExecutor?)` | `AsyncGenerator<ChatChunk>` | Stream a chat response |
| `runHealthChecks()` | `Promise<void>` | Run background health checks |

### Builder API (addProvider / addModel)

Build providers on the fly without config files:

```typescript
// Add a provider with API key (stored in the injected SecretStore)
await core.addProvider('my-anthropic', {
  engine: 'anthropic',
  apiKey: 'sk-ant-...',
  models: {
    'claude-sonnet-4-20250514': {},
    'claude-3-5-haiku-20241022': { temperature: 0.7 },
  },
});

// Or use an environment variable instead of a raw key
await core.addProvider('work-openai', {
  engine: 'openai',
  apiKeyEnvVar: 'WORK_OPENAI_KEY',
  baseUrl: 'https://corp-proxy.example.com/v1',
  models: { 'gpt-4o': {} },
});

// Add a model to an existing provider later
core.addModel('my-anthropic', 'claude-3-opus-20240229', { max_tokens: 8192 });

// Remove a model
core.removeModel('my-anthropic', 'claude-3-5-haiku-20241022');

// Remove an entire provider
core.removeProvider('work-openai');

// Check if a provider exists (in-memory or disk config)
if (core.hasProvider('my-anthropic')) { ... }
```

`AddProviderOptions`:

| Field | Type | Description |
|-------|------|-------------|
| `engine` | `string` | **Required.** Engine type (`"openai"`, `"anthropic"`, etc.) |
| `apiKey` | `string` | API key value — stored in SecretStore automatically |
| `apiKeyEnvVar` | `string` | Environment variable name (alternative to `apiKey`) |
| `baseUrl` | `string` | Custom base URL (overrides engine default) |
| `models` | `Record<string, ModelConfig>` | Models to enable |

In-memory providers merge over disk config. If both define the same provider ID, the in-memory version wins.

### SecretStore

Interface for API key storage. Implement your own or use the built-in `MemorySecretStore`.

```typescript
interface SecretStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<boolean>;
  has(key: string): Promise<boolean>;
}
```

### Chat streaming

The `chat()` method yields `ChatChunk` objects:

```typescript
type ChatChunk =
  | { type: 'text'; text: string }                    // LLM text output
  | { type: 'tool'; name: string; state: string; ... } // Tool call/result
  | { type: 'error'; error: string }                   // Error
  | { type: 'done'; finishReason: string }             // Stream finished
```

### Tool calling

Pass tool definitions and an executor to `chat()`:

```typescript
const tools = [{
  name: 'get_weather',
  description: 'Get current weather for a city',
  inputSchema: JSON.stringify({
    type: 'object',
    properties: { city: { type: 'string' } },
    required: ['city'],
  }),
}];

const executor = async (toolName: string, args: Record<string, any>) => {
  if (toolName === 'get_weather') {
    return { temperature: 72, condition: 'sunny' };
  }
};

for await (const chunk of core.chat(
  'my-openai/gpt-4o',
  [{ role: 'user', content: 'What is the weather in London?' }],
  undefined,        // params
  { tools },        // toolOptions
  executor,         // toolExecutor
)) {
  console.log(chunk);
}
```

The Vercel AI SDK handles the tool execution loop automatically (up to `maxSteps: 10`).

## Supported Engines

| Engine | ID | Requires Key | SDK Package | Notes |
|--------|----|-------------|-------------|-------|
| OpenAI | `openai` | Yes | `@ai-sdk/openai` | GPT-4o, o1, etc. |
| Anthropic | `anthropic` | Yes | `@ai-sdk/anthropic` | Claude 4, 3.5, etc. |
| Google Gemini | `gemini` | Yes | `@ai-sdk/google` | Gemini Pro, Flash |
| Mistral | `mistral` | Yes | `@ai-sdk/mistral` | Mistral Large, etc. |
| xAI (Grok) | `xai` | Yes | `@ai-sdk/xai` | Grok models |
| DeepSeek | `deepseek` | Yes | `@ai-sdk/deepseek` | DeepSeek Coder |
| Groq | `groq` | Yes | `@ai-sdk/groq` | Fast inference |
| Cohere | `cohere` | Yes | `@ai-sdk/cohere` | Command models |
| Amazon Bedrock | `bedrock` | No* | `@ai-sdk/amazon-bedrock` | Uses AWS credentials |
| Fireworks | `fireworks` | Yes | `@ai-sdk/fireworks` | Optimized inference |
| Together AI | `togetherai` | Yes | `@ai-sdk/togetherai` | Open models |
| Perplexity | `perplexity` | Yes | `@ai-sdk/perplexity` | Search-augmented |
| Azure OpenAI | `azure` | Yes | `@ai-sdk/openai-compatible` | Custom base URL required |
| OpenRouter | `openrouter` | Yes | `@ai-sdk/openai-compatible` | 100+ model aggregator |
| Ollama | `ollama` | No | `@ai-sdk/openai-compatible` | Local models |
| LM Studio | `lmstudio` | No | `@ai-sdk/openai-compatible` | Local models |
| Cerebras | `cerebras` | Yes | `@ai-sdk/openai-compatible` | Fast inference |
| Meta (Llama) | `meta` | Yes | `@ai-sdk/openai-compatible` | Llama API |
| Mock | `mock` | No | *(built-in)* | Testing only |

## Policies

Policies are named behavioral presets that can be assigned to models. A model references a policy by name; the policy's fields act as defaults that can be overridden by explicit model config or request parameters.

### Built-in policies

| Policy | Purpose |
|--------|---------|
| `precise` | Low temperature (0.15), concise factual responses |
| `balanced` | General-purpose (temp 0.5, 4096 tokens) |
| `creative` | High temperature (0.9), longer output |
| `coder` | Low temperature, complete runnable code |
| `json_strict` | JSON-only output with retry on invalid JSON |
| `long_context_chat` | Concise follow-ups in long conversations |

### Custom policies

Define custom policies in `~/.config/abbenay/policies.yaml`:

```yaml
my-policy:
  sampling:
    temperature: 0.3
    top_p: 0.8
  output:
    max_tokens: 4096
    system_prompt_snippet: "Be concise."
  reliability:
    timeout: 30000
```

### Assigning to a model

```yaml
providers:
  my-openai:
    engine: openai
    models:
      gpt-4o:
        policy: coder
        temperature: 0.1   # Overrides the policy's temperature
```

### Programmatic access

```typescript
import { resolvePolicy, listAllPolicies, flattenPolicy } from '@abbenay/core';

const policy = resolvePolicy('coder');
const all = listAllPolicies();            // Built-in + custom
const flat = flattenPolicy(policy!);      // { params, systemPromptSnippet, ... }
```

## ToolRegistry

The `ToolRegistry` collects tools from multiple sources, namespaces them, and builds executors compatible with `CoreState.chat()`.

### Registering tools

```typescript
import { ToolRegistry } from '@abbenay/core';

const registry = new ToolRegistry();

// Register local tools with inline executors
registry.register('myAgent', 'local', [
  {
    name: 'search',
    description: 'Search documentation',
    inputSchema: JSON.stringify({ type: 'object', properties: { query: { type: 'string' } } }),
    executor: async (args) => ({ results: ['...'] }),
  },
]);
```

### Using tools with chat

```typescript
const tools = registry.listForChat();
const executor = registry.buildExecutor();

for await (const chunk of core.chat('my-openai/gpt-4o', messages, undefined, { tools }, executor)) {
  console.log(chunk);
}
```

### Tool policy

Control tool visibility and approval via `ToolPolicyConfig`:

```typescript
const tools = registry.listForChat({
  disabled_tools: ['mcp:filesystem/*'],   // Never send to LLM
  auto_approve: ['local:*/*'],            // Execute without confirmation
  require_approval: ['ws:*/*'],           // Pause and ask user
});
```

## Relationship to @abbenay/daemon

`@abbenay/core` is the library. `@abbenay/daemon` is the full application built on top of it.

```
@abbenay/core (this package)
  CoreState, engines, config, secrets interface
  Zero transport dependencies
  For: agent devs, web devs, custom apps

@abbenay/daemon (full application)
  DaemonState extends CoreState
  + gRPC server, web UI, CLI, VS Code backchannel
  + KeychainSecretStore (keytar), MCP, SEA binary
  For: end users running the daemon
```

Both are built from a single source tree (`packages/daemon/src/`). The core code lives in `src/core/`, the daemon-specific code in `src/daemon/`.
