# Configuration Guide

Abbenay uses YAML configuration files and system keychain for secrets.

## Config File Locations

### User Level
`~/.config/abbenay/config.yaml` - Applies globally to all workspaces

### Workspace Level
`<workspace>/.config/abbenay/config.yaml` - Workspace-specific settings (overrides user-level)

## Config File Format

```yaml
providers:
  my-openai:                        # Virtual provider name (user-defined)
    engine: openai                  # Engine type (see Supported Engines below)
    api_key_keychain_name: "OPENAI_API_KEY"  # Option 1: keychain
    models:
      gpt-4o: {}                    # Enabled with defaults
      gpt-4o-mini:
        temperature: 0.3
        max_tokens: 4096
  
  anthropic-work:
    engine: anthropic
    api_key_env_var_name: "ANTHROPIC_API_KEY"  # Option 2: env var
    models:
      claude-sonnet-4-20250514: {}
      claude-3-5-haiku-20241022:
        temperature: 0.7
  
  local-ollama:
    engine: ollama
    base_url: "http://127.0.0.1:11434/v1"   # Optional: custom base URL
    models:
      llama3.2: {}
      qwen2.5-coder:
        model_id: "qwen2.5-coder:7b"        # Map virtual name to actual model ID
```

### Key Concepts

- **Virtual provider name** - The YAML key (e.g., `my-openai`). User-defined, must be lowercase alphanumeric with dots, hyphens, or underscores.
- **Engine** - The actual API backend (`openai`, `anthropic`, `ollama`, etc.). Fixed set defined in `core/engines.ts`.
- **Virtual model name** - The YAML key under `models`. Usually matches the engine model ID, but can be a custom alias via `model_id`.
- **Composite ID** - `{provider}/{model}` (e.g., `my-openai/gpt-4o`). Used in chat requests.

## API Key Storage Options

Each provider can specify exactly ONE of these (mutually exclusive):

### Option 1: Keychain Storage (`api_key_keychain_name`)

- Key stored in system keychain (macOS Keychain, Windows Credential Manager, Linux Secret Service)
- Specify the key name used in keychain
- Set via web dashboard "API Key" toggle

```yaml
providers:
  my-openai:
    engine: openai
    api_key_keychain_name: "OPENAI_API_KEY"
```

### Option 2: Environment Variable (`api_key_env_var_name`)

- Key read from environment variable at runtime
- Specify the env var name to check
- Set via web dashboard "Env" toggle

```yaml
providers:
  anthropic-work:
    engine: anthropic
    api_key_env_var_name: "ANTHROPIC_API_KEY"
```

### Fallback

If neither option is set, the engine's default environment variable is checked (e.g., `OPENAI_API_KEY` for the `openai` engine).

## Supported Engines

| Engine | ID | Default Env Var | Key Required |
|--------|----|-----------------|-------------|
| OpenAI | `openai` | `OPENAI_API_KEY` | Yes |
| Anthropic | `anthropic` | `ANTHROPIC_API_KEY` | Yes |
| Google Gemini | `gemini` | `GOOGLE_API_KEY` | Yes |
| Mistral | `mistral` | `MISTRAL_API_KEY` | Yes |
| xAI (Grok) | `xai` | `XAI_API_KEY` | Yes |
| DeepSeek | `deepseek` | `DEEPSEEK_API_KEY` | Yes |
| Groq | `groq` | `GROQ_API_KEY` | Yes |
| Cohere | `cohere` | `COHERE_API_KEY` | Yes |
| Amazon Bedrock | `bedrock` | *(AWS credentials)* | No |
| Fireworks | `fireworks` | `FIREWORKS_API_KEY` | Yes |
| Together AI | `togetherai` | `TOGETHER_AI_API_KEY` | Yes |
| Perplexity | `perplexity` | `PERPLEXITY_API_KEY` | Yes |
| Azure OpenAI | `azure` | `AZURE_OPENAI_API_KEY` | Yes |
| OpenRouter | `openrouter` | `OPENROUTER_API_KEY` | Yes |
| Ollama | `ollama` | *(none needed)* | No |
| LM Studio | `lmstudio` | *(none needed)* | No |
| Cerebras | `cerebras` | `CEREBRAS_API_KEY` | Yes |
| Meta (Llama) | `meta` | `META_API_KEY` | Yes |
| Mock (Testing) | `mock` | *(none needed)* | No |

## Per-Model Configuration

Each model entry supports these optional fields:

| Field | Type | Description |
|-------|------|-------------|
| `model_id` | string | Actual engine model ID (when the key is a virtual alias) |
| `system_prompt` | string | System prompt text |
| `system_prompt_mode` | `"prepend"` \| `"replace"` | How to combine with request system prompt (default: `"prepend"`) |
| `temperature` | number | Sampling temperature (0.0 - 2.0) |
| `top_p` | number | Nucleus sampling (0.0 - 1.0) |
| `top_k` | number | Top-k sampling |
| `max_tokens` | number | Maximum output tokens |
| `timeout` | number | Request timeout in milliseconds |

An empty object `{}` means "enabled with all defaults."

## Web Dashboard Configuration

The easiest way to configure Abbenay is via the web dashboard:

1. Start the daemon: `npm run daemon` (or `abbenay daemon` / `aby daemon`)
2. Start the web server: `npm run web` (or `abbenay web` / `aby web`)
3. Open http://localhost:8787

### Provider Cards

Each provider shows:
- **Name**: Virtual provider name
- **Engine**: The underlying API backend
- **Toggle**: Choose "Key" (keychain) or "Env" (environment variable)
- **Input field**: Enter API key value (for keychain) or env var name
- **Status badge**: "Configured", "Key missing", or "Not configured"
- **Model selection**: Choose which models to enable

### Config Location

Click the settings icon to choose where config is saved:
- **User**: `~/.config/abbenay/config.yaml` (default)
- **Workspace**: `<workspace>/.config/abbenay/config.yaml` (requires VS Code connection)

## VS Code Extension

The VS Code extension:
- Connects to the daemon automatically
- Provides workspace paths for workspace-level config
- Registers configured models with VS Code's Language Model API

No configuration is stored in the extension itself.

## CLI Configuration

### View Status
```bash
# From packages/daemon
npm run status

# Or with compiled binary
abbenay status
```

### Start Services
```bash
# Development
npm run daemon    # Start daemon (foreground)
npm run web       # Start web dashboard

# Production (aby is a short alias for abbenay)
abbenay daemon &
abbenay web
aby status
```

## Example Configurations

### Minimal (Single Provider)
```yaml
providers:
  openai:
    engine: openai
    api_key_env_var_name: "OPENAI_API_KEY"
    models:
      gpt-4o: {}
```

### Multiple Providers
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
    api_key_keychain_name: "ANTHROPIC_API_KEY"
    models:
      claude-sonnet-4-20250514: {}
  
  local:
    engine: ollama
    models:
      llama3.2: {}
      qwen2.5-coder:
        model_id: "qwen2.5-coder:7b"
```

### Multiple Instances of Same Engine
```yaml
providers:
  work-openai:
    engine: openai
    api_key_env_var_name: "WORK_OPENAI_KEY"
    base_url: "https://corp-proxy.example.com/v1"
    models:
      gpt-4o: {}

  personal-openai:
    engine: openai
    api_key_keychain_name: "PERSONAL_OPENAI_KEY"
    models:
      gpt-4o: {}
      gpt-4o-mini: {}
```

### Local Development (All from Env Vars)
```yaml
providers:
  openai:
    engine: openai
    api_key_env_var_name: "OPENAI_API_KEY"
    models:
      gpt-4o: {}
  
  anthropic:
    engine: anthropic
    api_key_env_var_name: "ANTHROPIC_API_KEY"
    models:
      claude-sonnet-4-20250514: {}
```

## Best Practices

### Personal Development
- Use keychain storage for API keys (secure, persistent)
- Configure via web dashboard for easy management

### Team Projects
- Use workspace-level config (`.config/abbenay/config.yaml`)
- Reference env vars for API keys
- Team members set their own env vars
- Commit config file, add env var docs to README

### CI/CD
- Use environment variables for API keys
- Set `api_key_env_var_name` in config
- Pass secrets via CI/CD platform

### Security
- Never commit API keys to version control
- Use keychain for local development
- Use env vars for CI/CD and containers
